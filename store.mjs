// History in SQLite: known peers, hourly up/total per node and per shard, shard-halt incidents, IP locations.
import { DatabaseSync } from 'node:sqlite'

export const KEEP = 7 * 864e5 // a node unseen this long drops off the list
const hourOf = (t) => Math.floor(t / 36e5)

export function open(path) {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, first INTEGER, last INTEGER, url TEXT, json TEXT);
    CREATE TABLE IF NOT EXISTS hourly (id TEXT, hour INTEGER, up INTEGER, total INTEGER, PRIMARY KEY (id, hour));
    CREATE TABLE IF NOT EXISTS incidents (n INTEGER PRIMARY KEY, shard INTEGER, start INTEGER, end INTEGER);
    CREATE TABLE IF NOT EXISTS geo (ip TEXT PRIMARY KEY, json TEXT);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`)
  // 0.3: rows from before Snapchain was tracked are Hypersnap's
  for (const t of ['peers', 'incidents'])
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'net')) db.exec(`ALTER TABLE ${t} ADD COLUMN net TEXT NOT NULL DEFAULT 'hypersnap'`)
  return db
}

export const meta = (db, k, v) => v === undefined ? db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v : db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(k, v)
export const known = (db, at) => db.prepare('SELECT id, url, net FROM peers WHERE last > ?').all(at - KEEP)
// Hypersnap's shard rows keep the ids they had before Snapchain was tracked
const shardKey = (net, id) => (net === 'hypersnap' ? `shard:${id}` : `${net}:shard:${id}`)

/** Up-ratio per UTC day for the last 90 days (null where there's no data), and the 1/30-day ratios. */
function history(db, at) {
  const now = hourOf(at)
  const today = Math.floor(at / 864e5)
  const out = new Map()
  for (const r of db.prepare('SELECT id, hour, up, total FROM hourly WHERE hour > ?').all(now - 90 * 24)) {
    const h = out.get(r.id) ?? { days: Array.from({ length: 90 }, () => [0, 0]), d1: [0, 0], d30: [0, 0] }
    out.set(r.id, h)
    const day = 89 - (today - Math.floor(r.hour / 24))
    if (day >= 0) (h.days[day][0] += r.up), (h.days[day][1] += r.total)
    if (r.hour > now - 24) (h.d1[0] += r.up), (h.d1[1] += r.total)
    if (r.hour > now - 30 * 24) (h.d30[0] += r.up), (h.d30[1] += r.total)
  }
  const ratio = ([u, t]) => (t ? u / t : null)
  return (id) => {
    const h = out.get(id)
    return h ? { days: h.days.map(ratio), d1: ratio(h.d1), d30: ratio(h.d30) } : { days: Array(90).fill(null), d1: null, d30: null }
  }
}

/** Records one network's summary from a crawl and returns it filled in: offline nodes, uptime, locations, incidents. */
export function record(db, net, s, at) {
  const hour = hourOf(at)
  const tally = db.prepare('INSERT INTO hourly VALUES (?, ?, ?, 1) ON CONFLICT (id, hour) DO UPDATE SET up = up + excluded.up, total = total + 1')
  const upsert = db.prepare('INSERT INTO peers (id, first, last, url, json, net) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET last = excluded.last, url = coalesce(excluded.url, url), json = excluded.json, net = excluded.net')
  db.exec('BEGIN')
  try {
    if (!meta(db, 'since')) meta(db, 'since', String(at))
    for (const n of s.nodes) upsert.run(n.id, at, at, n.url, JSON.stringify(n), net), tally.run(n.id, hour, 1)
    // this network's known nodes that the crawl didn't find count as down
    const live = new Set(s.nodes.map((n) => n.id))
    for (const p of db.prepare('SELECT id, json, last FROM peers WHERE last > ? AND net = ?').all(at - KEEP, net)) {
      if (live.has(p.id)) continue
      tally.run(p.id, hour, 0)
      s.nodes.push({ ...JSON.parse(p.json), net, state: 'offline', ms: null, peers: null, seenBy: 0, lastSeen: p.last })
    }
    for (const sh of s.shards) {
      tally.run(shardKey(net, sh.id), hour, sh.stalled ? 0 : 1)
      const open = db.prepare('SELECT n FROM incidents WHERE net = ? AND shard = ? AND end IS NULL').get(net, sh.id)
      if (sh.stalled && !open) db.prepare('INSERT INTO incidents (shard, start, net) VALUES (?, ?, ?)').run(sh.id, at - (Number.isFinite(sh.delay) ? sh.delay * 1000 : 0), net)
      if (!sh.stalled && open) db.prepare('UPDATE incidents SET end = ? WHERE n = ?').run(at, open.n)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  const up = history(db, at)
  const firsts = new Map(db.prepare('SELECT id, first FROM peers').all().map((r) => [r.id, r.first]))
  const geo = db.prepare('SELECT json FROM geo WHERE ip = ?')
  for (const n of s.nodes) Object.assign(n, { geo: (n.ip && JSON.parse(geo.get(n.ip)?.json ?? 'null')) || null, uptime: up(n.id), firstSeen: firsts.get(n.id) ?? at })
  for (const sh of s.shards) sh.uptime = up(shardKey(net, sh.id))
  s.incidents = db.prepare('SELECT shard, start, end FROM incidents WHERE net = ? ORDER BY start DESC LIMIT 20').all(net).map((r) => ({ ...r }))
  return s
}

/** Country, city and network for IPs not looked up yet (ip-api.com, 100 per call). */
export async function locate(db, ips) {
  const has = db.prepare('SELECT 1 FROM geo WHERE ip = ?')
  const todo = [...new Set(ips)].filter((ip) => ip && !has.get(ip)).slice(0, 100)
  if (!todo.length) return
  try {
    const r = await fetch('http://ip-api.com/batch?fields=status,query,countryCode,country,city,isp,org', { method: 'POST', body: JSON.stringify(todo), signal: AbortSignal.timeout(10_000) })
    for (const g of await r.json()) {
      if (g.status === 'success') db.prepare('INSERT OR REPLACE INTO geo VALUES (?, ?)').run(g.query, JSON.stringify({ cc: g.countryCode, country: g.country, city: g.city, org: g.org || g.isp }))
    }
  } catch {}
}
