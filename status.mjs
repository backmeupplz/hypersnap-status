// Turns one crawl into the network's state: which peers are Hypersnap, each node's health against the shard tips,
// and each shard's liveness and validators. Pure, so status.test.mjs can feed it a recorded crawl.

export const STALL_S = 120 // a shard with no new block for this long is halted
export const LAG_BLOCKS = 60 // a node this far behind a shard's tip is still syncing (blocks come ~1/s)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
// a libp2p ed25519 peer id is the identity multihash of the protobuf-wrapped public key
const PREFIX = '0024080112' + '20'

export function peerIdOf(key) {
  let n = BigInt('0x' + PREFIX + key)
  let s = ''
  while (n) (s = B58[Number(n % 58n)] + s), (n /= 58n)
  return '1' + s // the multihash's leading zero byte
}

/** validators.toml → { sets: [{ at, shards, keys }], names: { key: name } } */
export function parseValidators(toml) {
  const names = {}
  for (const m of toml.matchAll(/^#\s+([0-9a-f]{64})\s+-\s+(.+)$/gm)) names[m[1]] = m[2].trim()
  const sets = toml.split('[[consensus.validator_sets]]').slice(1).map((block) => {
    const keys = []
    for (const m of block.matchAll(/"([0-9a-f]{64})"\s*,?[ \t]*(?:#[ \t]*(.*))?/g)) {
      keys.push(m[1])
      if (m[2]) names[m[1]] = m[2].trim()
    }
    return {
      at: Number((block.match(/effective_at\s*=\s*([\d_]+)/)?.[1] ?? '0').replaceAll('_', '')),
      shards: (block.match(/shard_ids\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(Number),
      keys,
    }
  })
  return { sets, names }
}

/** The set governing `shard` at `height`, and the next one if a rotation is scheduled. */
export function setsAt(vals, shard, height) {
  const mine = vals.sets.filter((s) => s.shards.includes(shard)).sort((a, b) => a.at - b.at)
  const i = mine.findLastIndex((s) => s.at <= height)
  return { current: mine[i] ?? null, next: mine[i + 1] ?? null }
}

const hostOf = (url) => {
  const h = new URL(url).hostname
  return /^[\d.]+$/.test(h) ? null : h
}

/** A crawl ({ probes, seen } as Maps) → { status, shards, nodes, other }. */
/** A node's shardInfos, keeping only well-formed entries (they come from whoever answers). */
const shardsOf = (p) => (Array.isArray(p?.info?.shardInfos) ? p.info.shardInfos : [])
  .filter((s) => Number.isInteger(s?.shardId) && s.shardId >= 0 && s.shardId < 16 && Number.isSafeInteger(s.maxHeight) && Number.isFinite(s.blockDelay))

// the second-best value when two or more nodes report: one bogus node can't move a shard's tip or hide a halt
const second = (xs, better) => (xs.sort(better), xs[Math.min(1, xs.length - 1)])

export function summarize({ probes, seen }, vals, at = Date.now(), known = new Set()) {
  // shard tips: the highest height two Hypersnap API nodes agree on; liveness: the freshest block two of them have
  const per = new Map()
  for (const p of probes.values()) {
    if (p.hyper !== true) continue
    for (const s of shardsOf(p)) {
      const t = per.get(s.shardId) ?? { heights: [], delays: [] }
      t.heights.push(s.maxHeight)
      t.delays.push(s.blockDelay)
      per.set(s.shardId, t)
    }
  }
  const tips = new Map([...per].map(([id, t]) => [id, { id, tip: second(t.heights, (a, b) => b - a), delay: second(t.delays, (a, b) => a - b) }]))
  // the validators of each shard's current and next set (older sets are pre-fork Snapchain's)
  const sets = new Map([...tips.values()].map((t) => [t.id, setsAt(vals, t.id, t.tip)]))
  const validatorPeers = new Map()
  for (const { current, next } of sets.values()) for (const k of [...(current?.keys ?? []), ...(next?.keys ?? [])]) validatorPeers.set(peerIdOf(k), k)

  const isHyper = (id) => {
    const p = probes.get(id)
    if (p?.hyper != null) return p.hyper
    // once a peer was Hypersnap it stays so, unless its own API says otherwise
    return known.has(id) || validatorPeers.has(id) || !!seen.get(id)?.caps?.has('hyper:v1')
  }
  const ids = new Set([...probes.keys(), ...seen.keys()])
  const hyper = [...ids].filter(isHyper)

  const nodes = hyper.map((id) => {
    const p = probes.get(id)
    const g = seen.get(id)
    const key = validatorPeers.get(id)
    const urls = p?.urls ?? []
    const url = urls.find((u) => u.startsWith('https:') && hostOf(u)) ?? urls.find(hostOf) ?? urls[0] ?? null
    const ann = g?.contact?.announce_rpc_address
    const annHost = ann && (() => { try { return hostOf(ann) } catch { return null } })()
    const shards = shardsOf(p).map((s) => ({ id: s.shardId, height: s.maxHeight, lag: Math.max(0, (tips.get(s.shardId)?.tip ?? s.maxHeight) - s.maxHeight), delay: s.blockDelay, mempool: s.mempoolSize })).sort((a, b) => a.id - b.id)
    const ip = (url && !hostOf(url) && new URL(url).hostname) || g?.ip || null
    return {
      id,
      name: (key && vals.names[key]) || (url && hostOf(url)) || annHost || ip || id.slice(-8),
      validator: key ?? null,
      ip,
      url,
      version: p?.info?.version ?? null,
      ms: p?.ms ?? null,
      peers: p ? p.peers : null,
      seenBy: g?.by.size ?? 0,
      messages: p?.info?.dbStats?.numMessages ?? null,
      bytes: p?.info?.dbStats?.approxSize ?? null,
      shards,
      state: !p ? 'gossip' : shards.some((s) => s.lag > LAG_BLOCKS) ? 'syncing' : 'synced',
    }
  }).sort((a, b) => (a.state === 'gossip') - (b.state === 'gossip') || !!b.validator - !!a.validator || a.name.localeCompare(b.name))

  const online = new Set(hyper)
  const shards = [...tips.values()].sort((a, b) => a.id - b.id).map((t) => {
    const { current, next } = sets.get(t.id)
    const validators = (current?.keys ?? []).map((k) => ({ key: k, name: vals.names[k] ?? k.slice(0, 8), peer: peerIdOf(k), online: online.has(peerIdOf(k)) }))
    return { id: t.id, tip: t.tip, delay: t.delay, stalled: !(t.delay <= STALL_S), validators, next: next && { at: next.at, size: next.keys.length } }
  })

  const halted = shards.filter((s) => s.stalled).length
  const status = !shards.length || halted === shards.length ? 'major' : halted ? 'partial' : 'operational'
  return { at, status, shards, nodes, other: ids.size - hyper.length }
}
