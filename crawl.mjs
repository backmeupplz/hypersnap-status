// Walks the Hypersnap gossip mesh over the nodes' public HTTP APIs: /v1/info for each node's own state,
// /v1/currentPeers for who it's connected to, and the peers' addresses lead to the next nodes. Every URL here comes
// from what peers gossip, so only public addresses on the node ports are fetched, without redirects, with caps.
import { lookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

const PORTS = new Set(['', '80', '443', '3381'])
const MAX_NODES = 400

/** Loopback, private, link-local, CGNAT, multicast, reserved, and the IPv6 forms of them. */
export function blocked(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19))
  }
  const v = ip.toLowerCase()
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return blocked(mapped[1])
  return v.startsWith('::') || v.startsWith('64:ff9b:') || v.startsWith('2002:') || v.startsWith('2001:0:') || v.startsWith('2001::') ||
    /^f[cd]/.test(v) || /^fe[89a-f]/.test(v) || v.startsWith('ff') || v.startsWith('2001:db8') || v.startsWith('100:')
}

// the address is checked inside the socket's own lookup, so the IP checked is the IP connected to
function safeLookup(host, opts, cb) {
  lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err)
    if (!addrs.length || addrs.some((a) => blocked(a.address))) return cb(Object.assign(new Error('non-public address'), { code: 'EBLOCKED' }))
    opts?.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family)
  })
}

/** Base URL for a gossiped address, or null when it isn't one we'd fetch. */
export function base(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!/^https?:$/.test(u.protocol) || u.username || !PORTS.has(u.port) || (isIP(host) && blocked(host))) return null
  return `${u.protocol}//${u.host}`
}

/** GET a node's JSON: { status, json, ms } or null. 1 MB cap, 5 s deadline, no redirects. */
export function getJson(url, timeout = 5000) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const t0 = performance.now()
    const req = (u.protocol === 'https:' ? https : http).get(u, { lookup: safeLookup, agent: false, headers: { 'user-agent': 'hypersnap-status (+https://hypersnap.borodutch.com)', accept: 'application/json' } }, (res) => {
      const chunks = []
      let n = 0
      res.on('data', (c) => ((n += c.length) > 1e6 ? req.destroy() : chunks.push(c)))
      res.on('end', () => {
        clearTimeout(timer)
        let json = null
        try {
          json = JSON.parse(Buffer.concat(chunks).toString())
        } catch {}
        resolve({ status: res.statusCode, json, ms: Math.round(performance.now() - t0) })
      })
      res.on('error', () => resolve(null))
    })
    const timer = setTimeout(() => req.destroy(), timeout)
    req.on('error', () => (clearTimeout(timer), resolve(null)))
  })
}

const ip4 = (a) => (typeof a === 'string' && a.match(/\/ip4\/([\d.]+)\//)?.[1]) || null

/** Where to look for a gossiped peer's HTTP API: the default port on its gossip IP, and the host it announces. */
export function candidates(peer) {
  const ci = peer.contact_info
  const out = []
  const ip = ip4(ci?.gossip_address) || ip4(peer.observed_address)
  if (ip) out.push(`http://${ip}:3381`)
  if (ci?.announce_rpc_address) {
    try {
      const u = new URL(ci.announce_rpc_address)
      // the announced address is gRPC; a node on the default ports serves HTTP on 3381 beside it
      out.push(u.port === '3383' ? `${u.protocol}//${u.hostname}:3381` : `${u.protocol}//${u.host}`)
    } catch {}
  }
  return out.map(base).filter(Boolean)
}

/** One pass over the mesh from `seeds`. Returns { probes: peerId → what its API said, seen: peerId → how peers see it }. */
export async function crawl(seeds) {
  const probes = new Map()
  const seen = new Map()
  const tried = new Set()
  let queue = seeds.map(base).filter(Boolean)
  while (queue.length && tried.size < MAX_NODES) {
    const layer = [...new Set(queue)].filter((u) => !tried.has(u)).slice(0, MAX_NODES - tried.size)
    queue = []
    for (const u of layer) tried.add(u)
    await Promise.all(layer.map(async (url) => {
      const info = await getJson(url + '/v1/info')
      const id = info?.status === 200 && typeof info.json?.peer_id === 'string' && info.json.peer_id
      if (!id) return
      const known = probes.get(id)
      if (known) return void known.urls.push(url)
      const probe = { urls: [url], ms: info.ms, info: info.json, hyper: null, peers: 0 }
      probes.set(id, probe)
      const [reg, cur] = await Promise.all([getJson(url + '/v1/nativeRegistration'), getJson(url + '/v1/currentPeers')])
      // only Hypersnap serves native registration; upstream Snapchain nodes answer 404
      probe.hyper = reg?.status === 200 ? true : reg?.status === 404 ? false : null
      const peers = Array.isArray(cur?.json?.peers) ? cur.json.peers : []
      probe.peers = peers.length
      for (const p of peers) {
        if (typeof p?.peer_id !== 'string') continue
        const s = seen.get(p.peer_id) ?? { by: new Set(), ip: null, contact: null, caps: new Set() }
        seen.set(p.peer_id, s)
        s.by.add(id)
        s.ip ||= ip4(p.contact_info?.gossip_address) || ip4(p.observed_address)
        if (p.contact_info && !(s.contact?.timestamp > p.contact_info.timestamp)) s.contact = p.contact_info
        // older nodes relay contacts without capabilities, so they add up across observers
        for (const c of Array.isArray(p.contact_info?.capabilities) ? p.contact_info.capabilities : []) s.caps.add(c)
        queue.push(...candidates(p))
      }
    }))
  }
  return { probes, seen }
}
