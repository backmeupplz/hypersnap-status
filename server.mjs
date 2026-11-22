// hypersnap.borodutch.com: crawls the Hypersnap network every minute, keeps hourly uptime in SQLite, and serves the
// SPA (with per-page meta tags and the live snapshot inlined for crawlers), its JSON API and the share images.
import { Resvg } from '@resvg/resvg-js'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { crawl } from './crawl.mjs'
import { nodeCard, siteCard } from './og.mjs'
import { parseValidators, summarize } from './status.mjs'
import { known, locate, meta, open, record } from './store.mjs'

const SITE = process.env.SITE ?? 'https://hypersnap.borodutch.com'
const PORT = +(process.env.PORT ?? 3000)
const DATA = process.env.DATA_DIR ?? './data'
const EVERY = 60_000
const SEEDS = ['https://haatz.quilibrium.com', 'https://hypersnap.imgnai.com', 'https://ohsnap.schmidtiest.xyz', 'http://85.209.231.221:3381']
const VALIDATORS = 'https://raw.githubusercontent.com/farcasterorg/hypersnap/main/validators.toml'

const db = open(`${DATA}/status.db`)
let vals = parseValidators(meta(db, 'validators') ?? readFileSync(new URL('fixture-validators.toml', import.meta.url), 'utf8'))
async function refreshValidators() {
  try {
    const r = await fetch(VALIDATORS, { signal: AbortSignal.timeout(10_000) })
    const text = r.ok && (await r.text())
    if (text?.includes('[[consensus.validator_sets]]')) (vals = parseValidators(text)), meta(db, 'validators', text)
  } catch {}
}

let snapshot = null
let busy = false
async function tick() {
  if (busy) return
  busy = true
  try {
    const at = Date.now()
    const peers = known(db, at)
    const s = summarize(await crawl([...SEEDS, ...peers.map((p) => p.url).filter(Boolean)]), vals, at, new Set(peers.map((p) => p.id)))
    // no Hypersnap API answered at all: more likely our own network than the whole network, so record nothing
    if (!s.nodes.some((n) => n.state !== 'gossip')) return void console.error('crawl reached no Hypersnap API; keeping the last snapshot')
    await locate(db, s.nodes.map((n) => n.ip))
    snapshot = record(db, s, at)
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
    ? `${node.validator ? 'Validator' : 'Node'} ${node.name}${node.version ? ` running Hypersnap ${node.version}` : ''}: ${node.state}${node.uptime?.d30 != null ? `, ${(node.uptime.d30 * 100).toFixed(2)}% uptime ${snapshot.at - snapshot.since < 30 * 864e5 ? 'since tracking began' : 'over 30 days'}` : ''}. Live health, shard heights and history.`
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
    const hours = db.prepare('SELECT hour, up, total FROM hourly WHERE id = ? AND hour > ? ORDER BY hour').all(node.id, Math.floor(Date.now() / 36e5) - 48)
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
