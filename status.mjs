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

/** A node's shardInfos, keeping only well-formed entries (they come from whoever answers). */
const shardsOf = (p) => (Array.isArray(p?.info?.shardInfos) ? p.info.shardInfos : [])
  .filter((s) => Number.isInteger(s?.shardId) && s.shardId >= 0 && s.shardId < 16 && Number.isSafeInteger(s.maxHeight) && Number.isFinite(s.blockDelay))

// the second-best value when two or more nodes report: one bogus node can't move a shard's tip or hide a halt
const second = (xs, better) => (xs.sort(better), xs[Math.min(1, xs.length - 1)])

export const NETWORKS = ['hypersnap', 'snapchain']

// Snapchain's own fleet, by peer id (hypersnap src/network/mesh/nodes.rs, from Neynar's runbook): its validators.toml
// labels some keys with the wrong operator, and readers have no key at all
const FLEET = {
  '12D3KooWCc28TYrrXFivwUshyZ8R5HqPMgx4f7AP54iCDLYr7kFR': 'mordor (Neynar)',
  '12D3KooWSFyadP8BZkjhKGMcWVZrvVSxVfXEYip7R8jqeVjherRk': 'gondor (Neynar)',
  '12D3KooWQaoBw2gvdmfGdXjepEQU9i47FXxvsCZ6wu8Vn4gwvHm2': 'rohan (Neynar)',
  '12D3KooWJVyaQRovV1rjV8TzkN3cRiysACyey86kXDLdvf6JRq5Z': 'erebor (Neynar)',
  '12D3KooWH527dqZTziqzzuXunismeJ3iFVnUxV5spv6VkS7U7zL1': 'snap (Merkle)',
  '12D3KooWGmXDC2SfjSG7h7DchyVJHMB4GpA8JYpHf9iwz8L8BFqB': 'crackle (Merkle)',
  '12D3KooWCpHGJd3WYMY4cnbP8wQk4AK99J8YQfczLTsa7w4HkGDP': 'pop (Merkle)',
  '12D3KooWCnMgP8BYvwGG5eBfU3gLRnk1bA8BwCkrC3xMtHYp3dRR': 'pow (Merkle)',
  '12D3KooWN1tfvjuYaMdkMbtfed6o5TmAnNw1szjaZowmhet8Y4uF': 'uno',
}

/** Per shard: the tip two of the network's API nodes agree on, and the freshest block two of them have. */
function tipsOf(probes, hyper) {
  const per = new Map()
  for (const p of probes.values()) {
    if (p.hyper !== hyper) continue
    for (const s of shardsOf(p)) {
      const t = per.get(s.shardId) ?? { heights: [], delays: [] }
      t.heights.push(s.maxHeight)
      t.delays.push(s.blockDelay)
      per.set(s.shardId, t)
    }
  }
  return new Map([...per].map(([id, t]) => [id, { id, tip: second(t.heights, (a, b) => b - a), delay: second(t.delays, (a, b) => a - b) }]))
}

/** The validators (peer id → key) of each shard's current and next set; older sets are history. */
function validatorsOf(vals, tips) {
  const sets = new Map([...tips.values()].map((t) => [t.id, setsAt(vals, t.id, t.tip)]))
  const peers = new Map()
  for (const { current, next } of sets.values()) for (const k of [...(current?.keys ?? []), ...(next?.keys ?? [])]) peers.set(peerIdOf(k), k)
  return { sets, peers }
}

/**
 * A crawl ({ probes, seen } as Maps) → { at, networks: { hypersnap, snapchain }, unknown }. Both networks share one
 * gossip mesh. A peer's own API decides its network (only Hypersnap serves /v1/nativeRegistration); without one, the
 * network it was in before (`known`: id → network), then validator sets, the hyper:v1 capability and Snapchain's fleet.
 */
export function summarize({ probes, seen }, vals, at = Date.now(), known = new Map()) {
  const tips = { hypersnap: tipsOf(probes, true), snapchain: tipsOf(probes, false) }
  const v = { hypersnap: validatorsOf(vals.hypersnap, tips.hypersnap), snapchain: validatorsOf(vals.snapchain, tips.snapchain) }
  const netOf = (id) => {
    const p = probes.get(id)
    if (p?.hyper != null) return p.hyper ? 'hypersnap' : 'snapchain'
    if (known.has(id)) return known.get(id)
    if (v.hypersnap.peers.has(id) || seen.get(id)?.caps?.has('hyper:v1')) return 'hypersnap'
    if (v.snapchain.peers.has(id) || FLEET[id]) return 'snapchain'
    return null
  }
  const ids = new Set([...probes.keys(), ...seen.keys()])
  const by = { hypersnap: [], snapchain: [] }
  for (const id of ids) by[netOf(id)]?.push(id)
  const networks = Object.fromEntries(NETWORKS.map((net) => [net, network(net, by[net], probes, seen, vals[net], tips[net], v[net])]))
  return { at, networks, unknown: ids.size - by.hypersnap.length - by.snapchain.length }
}

function network(net, ids, probes, seen, vals, tips, { sets, peers: validatorPeers }) {
  const nameOf = (id, key) => (net === 'snapchain' && FLEET[id]) || (key && vals.names[key])
  const nodes = ids.map((id) => {
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
      net,
      name: nameOf(id, key) || (url && hostOf(url)) || annHost || ip || id.slice(-8),
      validator: key ?? null,
      ip,
      url,
      version: typeof p?.info?.version === 'string' ? p.info.version.slice(0, 32) : null,
      ms: p?.ms ?? null,
      peers: p ? p.peers : null,
      seenBy: g?.by.size ?? 0,
      messages: p?.info?.dbStats?.numMessages ?? null,
      bytes: p?.info?.dbStats?.approxSize ?? null,
      shards,
      state: !p ? 'gossip' : shards.some((s) => s.lag > LAG_BLOCKS) ? 'syncing' : 'synced',
    }
  }).sort((a, b) => (a.state === 'gossip') - (b.state === 'gossip') || !!b.validator - !!a.validator || a.name.localeCompare(b.name))

  const online = new Set(ids)
  const shards = [...tips.values()].sort((a, b) => a.id - b.id).map((t) => {
    const { current, next } = sets.get(t.id)
    const validators = (current?.keys ?? []).map((k) => ({ key: k, name: nameOf(peerIdOf(k), k) || k.slice(0, 8), peer: peerIdOf(k), online: online.has(peerIdOf(k)) }))
    return { id: t.id, tip: t.tip, delay: t.delay, stalled: !(t.delay <= STALL_S), validators, next: next && { at: next.at, size: next.keys.length } }
  })

  const halted = shards.filter((s) => s.stalled).length
  const status = !shards.length || halted === shards.length ? 'major' : halted ? 'partial' : 'operational'
  return { status, shards, nodes }
}
