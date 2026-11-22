// hypersnap.borodutch.com: crawls the Hypersnap network every minute, keeps hourly uptime in SQLite, and serves the
// SPA (with per-page meta tags and the live snapshot inlined for crawlers), its JSON API and the share images.
import { Resvg } from '@resvg/resvg-js'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { crawl } from './crawl.mjs'
import { nodeCard, siteCard } from './og.mjs'
import { parseValidators, summarize } from './status.mjs'

const SITE = process.env.SITE ?? 'https://hypersnap.borodutch.com'
const PORT = +(process.env.PORT ?? 3000)
const DATA = process.env.DATA_DIR ?? './data'
const EVERY = 60_000
const KEEP = 7 * 864e5 // a node unseen this long drops off the list
const SEEDS = ['https://haatz.quilibrium.com', 'https://hypersnap.imgnai.com', 'https://ohsnap.schmidtiest.xyz', 'http://85.209.231.221:3381']
const VALIDATORS = 'https://raw.githubusercontent.com/farcasterorg/hypersnap/main/validators.toml'

const db = new DatabaseSync(`${DATA}/status.db`)
db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, first INTEGER, last INTEGER, url TEXT, json TEXT);
  CREATE TABLE IF NOT EXISTS hourly (id TEXT, hour INTEGER, up INTEGER, total INTEGER, PRIMARY KEY (id, hour));
  CREATE TABLE IF NOT EXISTS incidents (n INTEGER PRIMARY KEY, shard INTEGER, start INTEGER, end INTEGER);
  CREATE TABLE IF NOT EXISTS geo (ip TEXT PRIMARY KEY, json TEXT);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`)
const meta = (k, v) => v === undefined ? db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v : db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(k, v)
if (!meta('since')) meta('since', String(Date.now()))

let vals = parseValidators(meta('validators') ?? readFileSync(new URL('fixture-validators.toml', import.meta.url), 'utf8'))
async function refreshValidators() {
  try {
    const r = await fetch(VALIDATORS, { signal: AbortSignal.timeout(10_000) })
    const text = r.ok && (await r.text())
    if (text?.includes('[[consensus.validator_sets]]')) (vals = parseValidators(text)), meta('validators', text)
  } catch {}
}

// country, city and network of each node's IP (ip-api.com, looked up once per IP)
async function locate(ips) {
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
const geoOf = (ip) => (ip && JSON.parse(db.prepare('SELECT json FROM geo WHERE ip = ?').get(ip)?.json ?? 'null')) || null

const hourOf = (t) => Math.floor(t / 36e5)
const tally = db.prepare('INSERT INTO hourly VALUES (?, ?, ?, 1) ON CONFLICT (id, hour) DO UPDATE SET up = up + excluded.up, total = total + 1')

/** Up-ratio per UTC day for the last 90 days (null where there's no data), and the 1/30-day percentages. */
function history(at) {
  const from = hourOf(at) - 90 * 24 + 1
  const today = Math.floor(at / 864e5)
  const out = new Map()
  for (const r of db.prepare('SELECT id, hour, up, total FROM hourly WHERE hour >= ?').all(from)) {
    const h = out.get(r.id) ?? { days: Array(90).fill(null).map(() => [0, 0]), d1: [0, 0], d30: [0, 0] }
    out.set(r.id, h)
    const day = 89 - (today - Math.floor(r.hour / 24))
    if (day >= 0) (h.days[day][0] += r.up), (h.days[day][1] += r.total)
    if (r.hour > hourOf(at) - 24) (h.d1[0] += r.up), (h.d1[1] += r.total)
    if (r.hour > hourOf(at) - 30 * 24) (h.d30[0] += r.up), (h.d30[1] += r.total)
  }
  const ratio = ([u, t]) => (t ? u / t : null)
  return (id) => {
    const h = out.get(id)
    return h ? { days: h.days.map(ratio), d1: ratio(h.d1), d30: ratio(h.d30) } : { days: Array(90).fill(null), d1: null, d30: null }
  }
}

let snapshot = null
let busy = false
async function tick() {
  if (busy) return
  busy = true
  try {
    const at = Date.now()
    const known = db.prepare('SELECT url FROM peers WHERE last > ? AND url IS NOT NULL').all(at - KEEP).map((r) => r.url)
    const s = summarize(await crawl([...SEEDS, ...known]), vals, at)
    await locate(s.nodes.map((n) => n.ip))
    const hour = hourOf(at)
    const upsert = db.prepare('INSERT INTO peers VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET last = excluded.last, url = coalesce(excluded.url, url), json = excluded.json')
    for (const n of s.nodes) upsert.run(n.id, at, at, n.url, JSON.stringify(n)), tally.run(n.id, hour, 1)
    // known nodes this crawl didn't find count as down
    const live = new Set(s.nodes.map((n) => n.id))
    for (const p of db.prepare('SELECT id, json, last FROM peers WHERE last > ?').all(at - KEEP)) {
      if (live.has(p.id)) continue
      tally.run(p.id, hour, 0)
      s.nodes.push({ ...JSON.parse(p.json), state: 'offline', ms: null, peers: null, seenBy: 0, lastSeen: p.last })
    }
    for (const sh of s.shards) {
      tally.run(`shard:${sh.id}`, hour, sh.stalled ? 0 : 1)
      const open = db.prepare('SELECT n FROM incidents WHERE shard = ? AND end IS NULL').get(sh.id)
      if (sh.stalled && !open) db.prepare('INSERT INTO incidents (shard, start) VALUES (?, ?)').run(sh.id, at - (Number.isFinite(sh.delay) ? sh.delay * 1000 : 0))
      if (!sh.stalled && open) db.prepare('UPDATE incidents SET end = ? WHERE n = ?').run(at, open.n)
    }
    const up = history(at)
    const firsts = new Map(db.prepare('SELECT id, first FROM peers').all().map((r) => [r.id, r.first]))
    for (const n of s.nodes) Object.assign(n, { geo: geoOf(n.ip), uptime: up(n.id), firstSeen: firsts.get(n.id) ?? at })
    for (const sh of s.shards) sh.uptime = up(`shard:${sh.id}`)
    s.incidents = db.prepare('SELECT shard, start, end FROM incidents ORDER BY start DESC LIMIT 20').all()
    s.since = +meta('since')
    snapshot = s
    cache.clear()
  } catch (e) {
    console.error('crawl failed', e)
  } finally {
    busy = false
  }
}

// ---- HTTP ----

const html = readFileSync(new URL('public/index.html', import.meta.url), 'utf8')
const files = {
  '/app.js': ['text/javascript', readFileSync(new URL('public/app.js', import.meta.url))],
  '/style.css': ['text/css', readFileSync(new URL('public/style.css', import.meta.url))],
  '/og.mjs': ['text/javascript', readFileSync(new URL('og.mjs', import.meta.url))],
  '/favicon.svg': ['image/svg+xml', readFileSync(new URL('public/favicon.svg', import.meta.url))],
  '/robots.txt': ['text/plain', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`],
}
const cache = new Map() // rendered share images, cleared on every crawl

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const LABEL = { operational: 'All systems operational', partial: 'Partial outage', major: 'Major outage' }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

export function describe(s) {
  if (!s) return 'Live status of the Hypersnap network: node uptime, shard heights, validators and incidents.'
  const halted = s.shards.filter((x) => x.stalled).map((x) => `shard ${x.id}`)
  const up = s.nodes.filter((n) => n.state !== 'offline').length
  const v = s.shards.flatMap((x) => x.validators)
  return `${LABEL[s.status]}${halted.length ? ` (${halted.join(', ')} halted)` : ''}. ${plural(up, 'node')} online, ${new Set(v.filter((x) => x.online).map((x) => x.key)).size} of ${new Set(v.map((x) => x.key)).size} validators in the mesh. Live uptime, shard heights and incidents for the Hypersnap network.`
}

function page(path, node) {
  const title = node ? `${node.name} · Hypersnap node status` : 'Hypersnap Network Status'
  const desc = node
    ? `${node.validator ? 'Validator' : 'Node'} ${node.name}${node.version ? ` running Hypersnap ${node.version}` : ''}: ${node.state}${node.uptime?.d30 != null ? `, ${(node.uptime.d30 * 100).toFixed(2)}% uptime over 30 days` : ''}. Live health, shard heights and history.`
    : describe(snapshot)
  const image = node ? `${SITE}/og/node/${node.id}.png` : `${SITE}/og.png`
  const url = SITE + path
  const tags = `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Hypersnap Network Status">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}"><meta name="twitter:image:alt" content="${esc(title)}">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, description: desc, url }).replace(/</g, '\\u003c')}</script>`
  const data = `<script id="data" type="application/json">${JSON.stringify(snapshot).replace(/</g, '\\u003c')}</script>`
  return html.replace('<!--meta-->', tags).replace('<!--data-->', data)
}

function send(req, res, status, type, body, maxAge = 30) {
  const enc = String(req.headers['accept-encoding'] ?? '')
  const text = /text|json|javascript|svg|xml/.test(type) && body.length > 1024
  const headers = { 'content-type': type, 'cache-control': `public, max-age=${maxAge}`, 'x-content-type-options': 'nosniff', vary: 'accept-encoding' }
  if (text && enc.includes('br')) (body = brotliCompressSync(body)), (headers['content-encoding'] = 'br')
  else if (text && enc.includes('gzip')) (body = gzipSync(body)), (headers['content-encoding'] = 'gzip')
  if (type.startsWith('text/html')) headers['content-security-policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  res.writeHead(status, headers).end(req.method === 'HEAD' ? undefined : body)
}

function png(key, svg) {
  if (!cache.has(key)) {
    const r = new Resvg(svg, { font: { fontFiles: [new URL('fonts/Inter-Regular.ttf', import.meta.url).pathname, new URL('fonts/Inter-Bold.ttf', import.meta.url).pathname], loadSystemFonts: false, defaultFontFamily: 'Inter' } })
    cache.set(key, r.render().asPng())
  }
  return cache.get(key)
}

const nodeById = (id) => snapshot?.nodes.find((n) => n.id === id)

createServer((req, res) => {
  const path = new URL(req.url, SITE).pathname
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'text/plain', 'method not allowed')
  if (files[path]) return send(req, res, 200, files[path][0], files[path][1], 300)
  if (path === '/api/status') return snapshot ? send(req, res, 200, 'application/json', JSON.stringify(snapshot)) : send(req, res, 503, 'application/json', '{"error":"first crawl running"}', 0)
  let m = path.match(/^\/api\/node\/([1-9A-HJ-NP-Za-km-z]{30,60})$/)
  if (m) {
    const node = nodeById(m[1])
    if (!node) return send(req, res, 404, 'application/json', '{"error":"unknown node"}')
    const hours = db.prepare('SELECT hour, up, total FROM hourly WHERE id = ? AND hour > ? ORDER BY hour').all(node.id, hourOf(Date.now()) - 48)
    return send(req, res, 200, 'application/json', JSON.stringify({ node, hours }))
  }
  if (path === '/og.png') return snapshot ? send(req, res, 200, 'image/png', png('site', siteCard(snapshot)), 300) : send(req, res, 503, 'text/plain', 'warming up', 0)
  m = path.match(/^\/og\/node\/([1-9A-HJ-NP-Za-km-z]{30,60})\.png$/)
  if (m) {
    const node = nodeById(m[1])
    return node ? send(req, res, 200, 'image/png', png(node.id, nodeCard(node, snapshot)), 300) : send(req, res, 404, 'text/plain', 'unknown node')
  }
  if (path === '/sitemap.xml') {
    const urls = ['/', ...(snapshot?.nodes ?? []).map((n) => `/node/${n.id}`)]
    return send(req, res, 200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${SITE}${u}</loc><changefreq>hourly</changefreq></url>`).join('')}</urlset>`, 300)
  }
  if (path === '/') return send(req, res, 200, 'text/html; charset=utf-8', page('/'), 0)
  m = path.match(/^\/node\/([1-9A-HJ-NP-Za-km-z]{30,60})$/)
  const node = m && nodeById(m[1])
  return send(req, res, node || (m && !snapshot) ? 200 : 404, 'text/html; charset=utf-8', page(node ? path : '/', node), 0)
}).listen(PORT, () => console.log(`listening on ${PORT}`))

await refreshValidators()
tick()
setInterval(tick, EVERY)
setInterval(refreshValidators, 36e5)
