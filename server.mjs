// hypersnap.borodutch.com: crawls the Hypersnap gossip mesh every minute (Snapchain shares it), keeps hourly uptime in
// SQLite, and serves the SPA (with per-page meta tags and the live snapshot inlined for crawlers), its JSON API and
// the share images.
import { Resvg } from '@resvg/resvg-js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { crawl } from './crawl.mjs'
import { NAMES, nodeCard, siteCard } from './og.mjs'
import { NETWORKS, parseValidators, summarize } from './status.mjs'
import { known, locate, meta, open, record } from './store.mjs'

const SITE = process.env.SITE ?? 'https://hypersnap.borodutch.com'
const PORT = +(process.env.PORT ?? 3000)
const DATA = process.env.DATA_DIR ?? './data'
const EVERY = 60_000
const SEEDS = ['https://haatz.quilibrium.com', 'https://hypersnap.imgnai.com', 'https://ohsnap.schmidtiest.xyz', 'http://85.209.231.221:3381', 'https://crackle.farcaster.xyz:3381', 'https://snap.farcaster.xyz:3381']
const VALIDATORS = {
  hypersnap: ['https://raw.githubusercontent.com/farcasterorg/hypersnap/main/validators.toml', 'validators', 'fixture-validators.toml'],
  snapchain: ['https://raw.githubusercontent.com/farcasterxyz/snapchain/main/validators.toml', 'validators:snapchain', 'fixture-snapchain-validators.toml'],
}
const PATHS = { hypersnap: '/', snapchain: '/snapchain' }

const db = open(`${DATA}/status.db`)
const vals = Object.fromEntries(NETWORKS.map((net) => {
  const [, key, fixture] = VALIDATORS[net]
  return [net, parseValidators(meta(db, key) ?? readFileSync(new URL(fixture, import.meta.url), 'utf8'))]
}))
async function refreshValidators() {
  for (const net of NETWORKS) {
    const [url, key] = VALIDATORS[net]
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      const text = r.ok && (await r.text())
      if (text?.includes('[[consensus.validator_sets]]')) (vals[net] = parseValidators(text)), meta(db, key, text)
    } catch {}
  }
}

let snapshot = null
let busy = false
async function tick() {
  if (busy) return
  busy = true
  try {
    const at = Date.now()
    const peers = known(db, at)
    const s = summarize(await crawl([...SEEDS, ...peers.map((p) => p.url).filter(Boolean)]), vals, at, new Map(peers.map((p) => [p.id, p.net])))
    await locate(db, NETWORKS.flatMap((net) => s.networks[net].nodes.map((n) => n.ip)))
    for (const net of NETWORKS) {
      // none of a network's APIs answered: more likely our own connection than the whole network, so record nothing
      if (snapshot && !s.networks[net].nodes.some((n) => n.state !== 'gossip')) (s.networks[net] = snapshot.networks[net]), console.error(`crawl reached no ${net} API; keeping its last state`)
      else record(db, net, s.networks[net], at)
    }
    s.since = +meta(db, 'since')
    snapshot = s
    cache.clear()
  } catch (e) {
    console.error('crawl failed', e)
  } finally {
    busy = false
  }
}

// ---- HTTP ----

// assets are served at ?v=<hash of the content>, so a page never pairs with stale CSS or JS
const read = (f) => readFileSync(new URL(f, import.meta.url))
const hash = (b) => createHash('sha256').update(b).digest('hex').slice(0, 10)
const og = read('og.mjs')
const files = {
  '/og.mjs': ['text/javascript', og],
  '/app.js': ['text/javascript', Buffer.from(String(read('public/app.js')).replace("'/og.mjs'", `'/og.mjs?v=${hash(og)}'`))],
  '/style.css': ['text/css', read('public/style.css')],
  '/theme.js': ['text/javascript', read('public/theme.js')],
  '/favicon.svg': ['image/svg+xml', read('public/favicon.svg')],
  '/robots.txt': ['text/plain', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`],
}
let html = String(read('public/index.html'))
for (const f of ['/app.js', '/style.css', '/theme.js']) html = html.replace(`"${f}"`, `"${f}?v=${hash(files[f][1])}"`)
const cache = new Map() // rendered share images, cleared on every crawl

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const LABEL = { operational: 'All systems operational', partial: 'Partial outage', major: 'Major outage' }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
const young = () => snapshot.at - snapshot.since < 30 * 864e5

function describe(net) {
  const s = snapshot?.networks[net]
  if (!s) return `Live status of the ${NAMES[net]} network: node uptime, shard heights, validators and incidents.`
  const halted = s.shards.filter((x) => x.stalled).map((x) => `shard ${x.id}`)
  const up = s.nodes.filter((n) => n.state !== 'offline').length
  const v = s.shards.flatMap((x) => x.validators)
  return `${LABEL[s.status]}${halted.length ? ` (${halted.join(', ')} halted)` : ''}. ${plural(up, 'node')} online, ${new Set(v.filter((x) => x.online).map((x) => x.key)).size} of ${new Set(v.map((x) => x.key)).size} validators in the mesh. Live uptime, shard heights and incidents for the ${NAMES[net]} network.`
}

function page(path, net, node) {
  const title = node ? `${node.name} · ${NAMES[node.net]} node status` : `${NAMES[net]} Network Status`
  const desc = node
    ? `${node.validator ? 'Validator' : 'Node'} ${node.name} on ${NAMES[node.net]}${node.version ? `, running ${node.version}` : ''}: ${node.state}${node.uptime?.d30 != null ? `, ${(node.uptime.d30 * 100).toFixed(2)}% uptime ${young() ? 'since tracking began' : 'over 30 days'}` : ''}. Live health, shard heights and history.`
    : describe(net)
  const image = node ? `${SITE}/og/node/${node.id}.png` : net === 'hypersnap' ? `${SITE}/og.png` : `${SITE}/og/${net}.png`
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
  const headers = { 'content-type': type, 'cache-control': maxAge === 'immutable' ? 'public, max-age=31536000, immutable' : `public, max-age=${maxAge}`, 'x-content-type-options': 'nosniff', vary: 'accept-encoding' }
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

const nodeById = (id) => snapshot && NETWORKS.map((net) => snapshot.networks[net].nodes.find((n) => n.id === id)).find(Boolean)
const view = (net) => ({ ...snapshot.networks[net], at: snapshot.at, since: snapshot.since })
const card = (net) => siteCard(view(net), net)
const PEER = '([1-9A-HJ-NP-Za-km-z]{30,60})'

createServer((req, res) => {
  const url = new URL(req.url, SITE)
  const path = url.pathname
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'text/plain', 'method not allowed')
  if (files[path]) return send(req, res, 200, files[path][0], files[path][1], url.searchParams.has('v') ? 'immutable' : 300)
  if (path === '/api/status') return snapshot ? send(req, res, 200, 'application/json', JSON.stringify(snapshot)) : send(req, res, 503, 'application/json', '{"error":"first crawl running"}', 0)
  let m = path.match(new RegExp(`^/api/node/${PEER}$`))
  if (m) {
    const node = nodeById(m[1])
    if (!node) return send(req, res, 404, 'application/json', '{"error":"unknown node"}')
    const hours = db.prepare('SELECT hour, up, total FROM hourly WHERE id = ? AND hour > ? ORDER BY hour').all(node.id, Math.floor(Date.now() / 36e5) - 48)
    return send(req, res, 200, 'application/json', JSON.stringify({ node, hours }))
  }
  m = path.match(/^\/og(?:\/(snapchain))?\.png$/)
  if (m) return snapshot ? send(req, res, 200, 'image/png', png(m[1] ?? 'hypersnap', card(m[1] ?? 'hypersnap')), 300) : send(req, res, 503, 'text/plain', 'warming up', 0)
  m = path.match(new RegExp(`^/og/node/${PEER}\\.png$`))
  if (m) {
    const node = nodeById(m[1])
    return node ? send(req, res, 200, 'image/png', png(node.id, nodeCard(node, view(node.net))), 300) : send(req, res, 404, 'text/plain', 'unknown node')
  }
  if (path === '/sitemap.xml') {
    const urls = [...Object.values(PATHS), ...NETWORKS.flatMap((net) => snapshot?.networks[net].nodes ?? []).map((n) => `/node/${n.id}`)]
    return send(req, res, 200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${SITE}${u}</loc><changefreq>hourly</changefreq></url>`).join('')}</urlset>`, 300)
  }
  const net = NETWORKS.find((n) => PATHS[n] === path)
  if (net) return send(req, res, 200, 'text/html; charset=utf-8', page(path, net), 0)
  m = path.match(new RegExp(`^/node/${PEER}$`))
  const node = m && nodeById(m[1])
  return send(req, res, node || (m && !snapshot) ? 200 : 404, 'text/html; charset=utf-8', page(node ? path : '/', node?.net ?? 'hypersnap', node), 0)
}).listen(PORT, () => console.log(`listening on ${PORT}`))

await refreshValidators()
tick()
setInterval(tick, EVERY)
setInterval(refreshValidators, 36e5)
