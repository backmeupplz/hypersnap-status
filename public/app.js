// The SPA: a page per network (/ Hypersnap, /snapchain) and /node/<peer id>. Server-rendered meta tags and the first
// snapshot come with the page; after that it polls /api/status. A page is a layout of named regions, and a poll only
// rewrites regions whose markup changed, so a selection, the search box or focus survive it. Node data goes through esc().
import { NAMES, dur, headline } from '/og.mjs'

// opened as a mini app: tell the host it can drop its splash (the miniapp SDK's ready(), as a bare Comlink call)
if (parent !== window) parent.postMessage({ id: 'ready', type: 'APPLY', path: ['ready'], argumentList: [{ type: 'RAW', value: {} }] }, '*')

const app = document.getElementById('app')
let data = JSON.parse(document.getElementById('data')?.textContent || 'null')
let hours = null // { id, hours } for the node page
let q = ''
let filter = 'all'
let shown = null // the path the layout was built for
const last = new Map() // region → markup it shows

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const num = (n) => (n == null || !Number.isFinite(+n) ? '—' : Number(n).toLocaleString('en-US'))
const pct = (r) => (r == null ? '—' : `${(r * 100).toFixed(r === 1 ? 0 : r > 0.999 ? 2 : 1)}%`)
const bytes = (b) => (b == null || !Number.isFinite(+b) ? '—' : b > 1e12 ? `${(b / 1e12).toFixed(2)} TB` : `${(b / 1e9).toFixed(1)} GB`)
const ago = (t) => `${dur((Date.now() - t) / 1000)} ago`
const date = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const flag = (cc) => (/^[A-Za-z]{2}$/.test(cc ?? '') ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : '')
const place = (g) => (g ? [g.city, g.cc].filter(Boolean).join(', ') : '')
const STATE = { synced: 'Synced', syncing: 'Syncing', gossip: 'Gossip only', offline: 'Offline' }
const PATH = { hypersnap: '/', snapchain: '/snapchain' }
const span = (since = data.since) => (Date.now() - since < 30 * 864e5 ? 'since launch' : '30 days')
const pill = (cls, text, title = '') => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ''}>${text}</span>`
const copy = (v) => `<button type="button" class="copy" data-copy="${esc(v)}">Copy</button>`

function route() {
  const m = location.pathname.match(/^\/node\/([^/]+)$/)
  if (m) {
    const id = decodeURIComponent(m[1])
    const node = data && Object.values(data.networks).flatMap((n) => n.nodes).find((n) => n.id === id)
    return { id, node, net: node?.net ?? 'hypersnap' }
  }
  return { net: location.pathname === '/snapchain' ? 'snapchain' : 'hypersnap' }
}

/** Ratios as one strip of bars, colored by up-ratio, each with a tooltip. */
function bars(items, label, cls = '') {
  return `<div class="bars ${cls}" role="img" aria-label="${esc(label)}">${items.map(([r, title]) => `<i class="${r == null ? 'n' : r >= 0.995 ? 'g' : r >= 0.9 ? 'y' : 'r'}" title="${esc(title)}: ${r == null ? 'no data' : pct(r)}"></i>`).join('')}</div>`
}
function days(uptime, n = 90) {
  const today = Math.floor(Date.now() / 864e5)
  return uptime.days.slice(-n).map((r, i) => [r, new Date((today - n + 1 + i) * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })])
}
const syncPill = (n) => {
  const lag = Math.max(0, ...(n.shards ?? []).map((s) => s.lag))
  return n.state === 'syncing' ? pill('syncing', `${num(lag)} behind`, `${num(lag)} blocks behind the tip`) : pill(n.state, STATE[n.state])
}

function tabs(active) {
  return `<nav class="tabs" aria-label="Network">${Object.entries(data.networks).map(([net, s]) => `<a href="${PATH[net]}"${net === active ? ' aria-current="page"' : ''}>
<span class="dot ${s.status}"></span>${NAMES[net]}<span class="count">${s.nodes.filter((n) => n.state !== 'offline').length}</span></a>`).join('')}</nav>`
}

const tile = (label, value, sub) => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`

// ---- network page ----

function netRegions(net) {
  const s = data.networks[net]
  const api = s.nodes.filter((n) => n.state === 'synced' || n.state === 'syncing')
  const online = s.nodes.filter((n) => n.state !== 'offline')
  const vals = new Map()
  for (const sh of s.shards) for (const v of sh.validators) (vals.get(v.key) ?? vals.set(v.key, { ...v, shards: [] }).get(v.key)).shards.push(sh.id)
  const versions = Object.entries(api.reduce((a, n) => ((a[n.version] = (a[n.version] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1])
  const live = s.shards.filter((x) => !x.stalled)
  const known = new Map(s.nodes.map((n) => [n.id, n]))
  const counts = Object.fromEntries(Object.keys(STATE).map((k) => [k, s.nodes.filter((n) => n.state === k).length]))
  const match = (n) => (filter === 'all' || n.state === filter) &&
    (!q || [n.name, n.ip, n.id, n.version, n.geo?.city, n.geo?.country, n.geo?.org].some((x) => String(x ?? '').toLowerCase().includes(q)))
  const list = s.nodes.filter(match)
  return {
    tabs: tabs(net),
    banner: `<section class="banner ${s.status}"><span class="dot big ${s.status}"></span><div class="text"><h1>${esc(headline(s))}</h1>
<p>${NAMES[net]} network · updated ${ago(data.at)} · checked every minute</p></div></section>`,
    stats: `<div class="tiles">
${tile('Nodes online', online.length, `${api.length} with a public API`)}
${tile('Validators', `${[...vals.values()].filter((v) => v.online).length}<small>/${vals.size}</small>`, 'in the mesh')}
${tile('Shards live', `${live.length}<small>/${s.shards.length}</small>`, s.shards.length === live.length ? 'all producing blocks' : `shard ${s.shards.filter((x) => x.stalled).map((x) => x.id).join(', ')} halted`)}
${tile('Top version', `<span class="mono">${esc(versions[0]?.[0] ?? '—')}</span>`, versions[0] ? `on ${versions[0][1]} of ${api.length} API nodes` : '')}
</div>`,
    shards: `<div class="shards">${s.shards.map((x) => `<article class="card shard">
  <header><span class="dot ${x.stalled ? 'bad' : 'ok'}"></span><h3>Shard ${x.id}</h3><span class="muted small">${x.id === 0 ? 'Blocks' : 'Messages'}</span>
  ${x.stalled ? pill('bad', `Halted ${dur(x.delay)}`) : pill('ok', 'Live')}</header>
  <div class="height mono">#${num(x.tip)}</div>
  <div class="small muted">${x.stalled ? `no block for ${dur(x.delay)}` : `last block ${dur(x.delay)} ago`}</div>
  <div class="vrow"><span class="squares">${x.validators.map((v) => `<i class="${v.online ? 'g' : 'n'}" title="${esc(v.name)}: ${v.online ? 'connected' : 'not seen'}"></i>`).join('')}</span>
  <span class="small muted">${x.validators.filter((v) => v.online).length}/${x.validators.length} validators</span></div>
  ${x.next ? `<div class="small muted">Set of ${x.next.size} takes over at #${num(x.next.at)}</div>` : ''}
  ${bars(days(x.uptime), `Shard ${x.id}, last 90 days`, 'thin')}
  <div class="legend"><span>90 days ago</span><span>${pct(x.uptime.d30)} live ${span(s.since)}</span></div>
</article>`).join('')}</div>`,
    chips: Object.entries({ all: s.nodes.length, ...counts }).filter(([k, n]) => k === 'all' || n).map(([k, n]) =>
      `<button type="button" class="chip" data-filter="${k}" aria-pressed="${filter === k}">${k === 'all' ? 'All' : `<span class="dot ${k}"></span>${STATE[k]}`}<span class="count">${n}</span></button>`).join(''),
    nodes: list.length ? `<div class="nodes">
<div class="node head" aria-hidden="true"><span>Node</span><span>Location</span><span class="c-ver">Version</span><span>Sync</span><span class="c-ms">Latency</span><span class="c-up">Uptime</span><span class="c-bars">Last 30 days</span></div>
${list.map((n) => `<a class="node" href="/node/${esc(n.id)}">
  <span class="c-main"><span class="dot ${n.state}"></span><span class="stack"><span class="name one" title="${esc(n.name)}">${esc(n.name)}</span>
  <span class="sub one">${n.validator ? '<b>Validator</b> · ' : ''}<span class="mono">${esc(n.ip && n.ip !== n.name ? n.ip : `…${n.id.slice(-10)}`)}</span></span></span></span>
  <span class="c-loc stack"><span class="one" title="${esc([n.geo?.city, n.geo?.country].filter(Boolean).join(', '))}">${n.geo ? `${flag(n.geo.cc)} ${esc(place(n.geo))}` : '—'}</span><span class="sub one">${esc(n.geo?.org ?? '')}</span></span>
  <span class="c-ver mono one">${esc(n.version ?? '—')}</span>
  <span class="c-sync">${syncPill(n)}</span>
  <span class="c-ms mono">${n.ms == null ? '—' : `${n.ms} ms`}</span>
  <span class="c-up mono">${pct(n.uptime?.d30)}</span>
  <span class="c-bars">${n.uptime ? bars(days(n.uptime, 30), `${n.name}, last 30 days`) : ''}</span>
</a>`).join('')}
</div>` : `<p class="empty">No nodes match.</p>`,
    validators: vals.size ? `<h2>Validators <span class="count">${vals.size}</span></h2><div class="vals">${[...vals.values()].map((v) => {
      // a key without a name in validators.toml goes by its node's name when the node is known
      const name = /^[0-9a-f]{8}$/.test(v.name) && known.get(v.peer)?.name || v.name
      const inner = `<span class="dot ${v.online ? 'ok' : 'bad'}"></span><span class="name one" title="${esc(name)}">${esc(name)}</span><span class="small muted">shard ${v.shards.join(' · ')}</span>`
      return known.has(v.peer) ? `<a class="val" href="/node/${esc(v.peer)}">${inner}</a>` : `<span class="val">${inner}</span>`
    }).join('')}</div>` : '',
    incidents: `<h2>Incidents</h2>${s.incidents.length ? `<ul class="incidents">${s.incidents.map((i) => `<li><span class="dot ${i.end ? 'ok' : 'bad'}"></span>
<div class="stack"><strong>Shard ${i.shard} halted</strong><span class="small muted">${date(i.start)}${i.end ? ` – ${date(i.end)}` : ' · ongoing'}</span></div>
${i.end ? pill('ok', `Resolved · ${dur((i.end - i.start) / 1000)}`) : pill('bad', `Ongoing · ${dur((Date.now() - i.start) / 1000)}`)}</li>`).join('')}</ul>` : `<p class="empty">No incidents since tracking began ${date(s.since ?? data.since)}.</p>`}`,
    other: data.unknown ? `<p class="small muted">${data.unknown} more peers in the gossip mesh have no public API or other marker, so their network is unknown and they aren't listed.</p>` : '',
  }
}

const netLayout = () => `<div data-r="tabs"></div><div data-r="banner"></div><div data-r="stats"></div>
<h2>Shards</h2><div data-r="shards"></div>
<div class="nodes-head"><h2>Nodes</h2><input type="search" id="q" placeholder="Search name, IP, location, version" aria-label="Search nodes" autocomplete="off" value="${esc(q)}"></div>
<div class="chips" data-r="chips" role="group" aria-label="Filter nodes"></div><div data-r="nodes"></div><div data-r="other"></div>
<div data-r="validators"></div><div data-r="incidents"></div>`

// ---- node page ----

function nodeRegions({ id, node: n, net }) {
  if (!n) return { tabs: tabs(net), main: `<p class="crumb"><a href="/">← Hypersnap network</a></p><h1>Node not found</h1><p class="muted">No node with peer ID <span class="mono wrap">${esc(id)}</span> has been seen in the last 7 days.</p>` }
  const tips = new Map(data.networks[n.net].shards.map((s) => [s.id, s]))
  const now = Math.floor(Date.now() / 36e5)
  const hs = hours?.id === n.id ? hours.hours : []
  const hourly = Array.from({ length: 48 }, (_, i) => {
    const h = hs.find((x) => x.hour === now - 47 + i)
    return [h ? h.up / h.total : null, new Date((now - 47 + i) * 36e5).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })]
  })
  const fact = (k, v, c) => `<div><dt>${k}</dt><dd><span class="v">${v}</span>${c ? copy(c) : ''}</dd></div>`
  return {
    tabs: tabs(n.net),
    main: `<p class="crumb"><a href="${PATH[n.net]}">← ${NAMES[n.net]} network</a></p>
<section class="banner ${n.state}"><span class="dot big ${n.state}"></span><div class="text"><h1 class="wrap">${esc(n.name)}</h1>
<p class="pills">${syncPill(n)}${n.validator ? pill('accent', 'Validator') : ''}${pill('plain', NAMES[n.net])}${n.lastSeen ? `<span class="small muted">last seen ${ago(n.lastSeen)}</span>` : ''}</p></div></section>`,
    stats: `<div class="tiles">
${tile('Uptime today', pct(n.uptime?.d1), 'last 24 hours')}
${tile('Uptime', pct(n.uptime?.d30), span())}
${tile('API latency', n.ms == null ? '—' : `${n.ms}<small> ms</small>`, n.url ? 'from Germany' : 'no public API')}
${tile('Peers', num(n.peers), `seen by ${num(n.seenBy)} peers`)}
</div>`,
    shards: n.shards?.length ? `<h2>Shards</h2><div class="table"><table><thead><tr><th>Shard</th><th>Height</th><th>Behind tip</th><th>Last block</th><th>Mempool</th></tr></thead><tbody>
${n.shards.map((s) => `<tr><td>Shard ${s.id}</td><td class="mono">#${num(s.height)}</td><td class="mono ${s.lag > 60 ? 'warn' : ''}">${num(s.lag)}</td>
<td class="${tips.get(s.id)?.stalled ? 'bad' : ''}">${dur(s.delay)} ago${tips.get(s.id)?.stalled ? ' (shard halted)' : ''}</td><td class="mono">${num(s.mempool)}</td></tr>`).join('')}</tbody></table></div>` : '',
    uptime: `<h2>Uptime</h2><section class="card">
<div class="legend above"><span>Last 48 hours</span><span>${pct(n.uptime?.d1)} today</span></div>${bars(hourly, 'Hourly uptime, last 48 hours')}
<div class="legend above"><span>Last 90 days</span><span>${pct(n.uptime?.d30)} ${span()}</span></div>${n.uptime ? bars(days(n.uptime), 'Daily uptime, last 90 days', 'thin') : ''}</section>`,
    details: `<h2>Details</h2><dl class="facts">
${fact('Peer ID', `<span class="mono wrap">${esc(n.id)}</span>`, n.id)}
${fact('IP address', `<span class="mono">${esc(n.ip ?? '—')}</span>`, n.ip)}
${fact('Public API', n.url ? `<a class="mono wrap" href="${esc(n.url)}/v1/info" rel="nofollow noopener">${esc(n.url)}</a>` : 'none, seen in gossip only', n.url)}
${fact('Location', esc(n.geo ? `${flag(n.geo.cc)} ${[n.geo.city, n.geo.country].filter(Boolean).join(', ')}` : '—'))}
${fact('Network', esc(n.geo?.org ?? '—'))}
${fact('Version', `<span class="mono">${esc(n.version ?? '—')}</span>`)}
${n.validator ? fact('Validator key', `<span class="mono wrap">${esc(n.validator)}</span>`, n.validator) : ''}
${fact('Messages', num(n.messages))}
${fact('Database', bytes(n.bytes))}
${fact('First seen', date(n.firstSeen))}
</dl>`,
  }
}

const nodeLayout = () => `<div data-r="tabs"></div><div data-r="main"></div><div data-r="stats"></div><div data-r="shards"></div><div data-r="uptime"></div><div data-r="details"></div>`

// ---- rendering ----

function render(only) {
  if (!data) return void (app.innerHTML = '<p class="empty">The first crawl of the network is running. This page fills in within a minute.</p>')
  const r = route()
  if (shown !== location.pathname) {
    app.innerHTML = r.id ? nodeLayout() : netLayout()
    shown = location.pathname
    last.clear()
  }
  const regions = r.id ? nodeRegions(r) : netRegions(r.net)
  for (const el of app.querySelectorAll('[data-r]')) {
    const name = el.dataset.r
    if (only && !only.includes(name)) continue
    const html = regions[name] ?? ''
    if (last.get(name) !== html) (el.innerHTML = html), last.set(name, html)
  }
  document.title = r.id ? `${r.node?.name ?? 'Node'} · ${NAMES[r.net]} node status` : `${NAMES[r.net]} Network Status`
}

async function refresh() {
  try {
    const r = await fetch('/api/status')
    if (r.ok) data = await r.json()
    const { id } = route()
    if (id) {
      const h = await fetch(`/api/node/${encodeURIComponent(id)}`)
      hours = h.ok ? { id, hours: (await h.json()).hours } : null
    }
  } catch {}
  render()
}

function go(path) {
  history.pushState(null, '', path)
  scrollTo(0, 0)
  render()
  refresh()
}

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]')
  if (c) {
    navigator.clipboard?.writeText(c.dataset.copy).then(() => {
      c.textContent = 'Copied'
      setTimeout(() => (c.textContent = 'Copy'), 1500)
    })
    return
  }
  const f = e.target.closest('[data-filter]')
  if (f) return (filter = f.dataset.filter), render(['chips', 'nodes'])
  const a = e.target.closest('a')
  if (!a || a.origin !== location.origin || !/^\/(node\/[^/]+|snapchain)?$/.test(a.pathname) || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  if (a.pathname !== location.pathname) go(a.pathname)
})
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') (q = e.target.value.trim().toLowerCase()), render(['nodes'])
})
addEventListener('popstate', () => (render(), refresh()))
render()
refresh()
setInterval(refresh, 30_000)
