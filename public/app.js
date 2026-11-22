// The SPA: home (network, shards, nodes, validators, incidents) and /node/<peer id>. Server-rendered meta tags and the
// first snapshot come with the page; after that it polls /api/status. Everything from nodes goes through esc().
import { dur, headline } from '/og.mjs'

const app = document.getElementById('app')
let data = JSON.parse(document.getElementById('data')?.textContent || 'null')
let nodeHours = null

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const pct = (r) => (r == null ? '—' : `${(r * 100).toFixed(r === 1 ? 0 : 2)}%`)
const bytes = (b) => (b == null ? '—' : b > 1e12 ? `${(b / 1e12).toFixed(2)} TB` : `${(b / 1e9).toFixed(1)} GB`)
const ago = (t) => `${dur((Date.now() - t) / 1000)} ago`
const date = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const flag = (cc) => (cc ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : '')
const where = (g) => (g ? `${flag(g.cc)} ${[g.city, g.country].filter(Boolean).join(', ')}` : '')
const STATE = { synced: 'Synced', syncing: 'Syncing', gossip: 'Seen in gossip', offline: 'Offline' }
const SHARD = (id) => (id === 0 ? 'Block shard' : 'Message shard')

/** 90 day bars (or any ratios) as one strip, colored by up-ratio, with a tooltip per bar. */
function bars(ratios, label) {
  return `<div class="bars" role="img" aria-label="${esc(label)}">${ratios.map(([r, title]) => `<i class="${r == null ? 'n' : r >= 0.995 ? 'g' : r >= 0.9 ? 'y' : 'r'}" title="${esc(title)}: ${r == null ? 'no data' : pct(r)}"></i>`).join('')}</div>`
}
function days(uptime) {
  const today = Math.floor(Date.now() / 864e5)
  return uptime.days.map((r, i) => [r, new Date((today - 89 + i) * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })])
}

function home(d) {
  const counts = Object.fromEntries(Object.keys(STATE).map((k) => [k, d.nodes.filter((n) => n.state === k).length]))
  const vals = new Map()
  for (const s of d.shards) for (const v of s.validators) (vals.get(v.key) ?? vals.set(v.key, { ...v, shards: [] }).get(v.key)).shards.push(s.id)
  const known = new Set(d.nodes.map((n) => n.id))
  return `
<section class="banner ${d.status}"><span class="dot"></span><div><h1>${esc(headline(d))}</h1>
<p>Updated ${ago(d.at)} · history since ${date(d.since)}</p></div></section>

<h2>Shards</h2>
${d.shards.map((s) => `<section class="card shard">
  <div class="row"><span class="dot ${s.stalled ? 'bad' : 'ok'}"></span><strong>Shard ${s.id}</strong><span class="muted">${SHARD(s.id)}</span>
  <span class="spacer"></span><span class="mono">#${num(s.tip)}</span>
  <span class="tag ${s.stalled ? 'bad' : 'ok'}">${s.stalled ? `halted ${dur(s.delay)}` : `last block ${dur(s.delay)} ago`}</span></div>
  <div class="row small"><span class="squares">${s.validators.map((v) => `<i class="${v.online ? 'g' : 'n'}" title="${esc(v.name)}: ${v.online ? 'in the mesh' : 'not seen'}"></i>`).join('')}</span>
  <span class="muted">${s.validators.filter((v) => v.online).length} of ${s.validators.length} validators in the mesh${s.next ? ` · new set of ${s.next.size} at #${num(s.next.at)} (${num(s.next.at - s.tip)} blocks away)` : ''}</span></div>
  ${bars(days(s.uptime), `Shard ${s.id} uptime, last 90 days`)}
  <div class="row small muted"><span>90 days ago</span><span class="spacer"></span><span>${pct(s.uptime.d30)} live over 30 days</span><span class="spacer"></span><span>Today</span></div>
</section>`).join('')}

<h2>Nodes <span class="muted">${d.nodes.length}</span></h2>
<p class="chips">${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `<span class="chip ${k}"><span class="dot"></span>${n} ${STATE[k].toLowerCase()}</span>`).join('')}</p>
<div class="nodes">
<div class="nrow head"><span>Node</span><span>Location</span><span>Version</span><span>Sync</span><span>Latency</span><span>30 days</span><span class="hide-s">Last 30 days</span></div>
${d.nodes.map((n) => {
  const lag = Math.max(0, ...(n.shards ?? []).map((s) => s.lag))
  return `<a class="nrow" href="/node/${esc(n.id)}">
  <span class="name"><span class="dot ${n.state}"></span><span><strong>${esc(n.name)}</strong>${n.validator ? '<span class="badge">validator</span>' : ''}<br><span class="mono muted">${esc(n.ip && n.ip !== n.name ? n.ip : `peer …${n.id.slice(-8)}`)}</span></span></span>
  <span class="small">${esc(where(n.geo))}<br><span class="muted">${esc(n.geo?.org ?? '')}</span></span>
  <span class="mono">${esc(n.version ?? '—')}</span>
  <span class="small">${n.state === 'syncing' ? `${num(lag)} behind` : STATE[n.state]}</span>
  <span class="mono">${n.ms == null ? '—' : `${n.ms} ms`}</span>
  <span class="mono">${pct(n.uptime?.d30)}</span>
  <span class="hide-s">${n.uptime ? bars(days(n.uptime).slice(-30), `${n.name} uptime, last 30 days`) : ''}</span>
</a>`
}).join('')}
</div>
${d.other ? `<p class="muted small">${d.other} more peers in the same gossip mesh run upstream Snapchain or couldn't be identified, so they aren't listed.</p>` : ''}

<h2>Validators <span class="muted">${vals.size}</span></h2>
<div class="vals">${[...vals.values()].map((v) => {
  const tag = `<span class="dot ${v.online ? 'ok' : 'bad'}"></span><strong>${esc(v.name)}</strong><span class="muted small">shard ${v.shards.join(', ')}</span>`
  return known.has(v.peer) ? `<a class="val" href="/node/${esc(v.peer)}">${tag}</a>` : `<span class="val">${tag}</span>`
}).join('')}</div>

<h2>Incidents</h2>
${d.incidents.length ? `<ul class="incidents">${d.incidents.map((i) => `<li><span class="dot ${i.end ? 'ok' : 'bad'}"></span><div><strong>Shard ${i.shard} halted</strong>
<span class="muted small">${date(i.start)} · ${i.end ? `resolved after ${dur((i.end - i.start) / 1000)}` : `ongoing for ${dur((Date.now() - i.start) / 1000)}`}</span></div></li>`).join('')}</ul>` : `<p class="muted">No incidents since ${date(d.since)}.</p>`}`
}

function node(d, id) {
  const n = d.nodes.find((x) => x.id === id)
  if (!n) return `<p><a href="/">← Network</a></p><h1>Node not found</h1><p class="muted">No Hypersnap node with peer ID <span class="mono">${esc(id)}</span> has been seen in the last 7 days.</p>`
  const tips = new Map(d.shards.map((s) => [s.id, s]))
  const hours = nodeHours?.id === id ? nodeHours.hours : []
  const now = Math.floor(Date.now() / 36e5)
  const hourly = Array.from({ length: 48 }, (_, i) => {
    const h = hours.find((x) => x.hour === now - 47 + i)
    return [h ? h.up / h.total : null, new Date((now - 47 + i) * 36e5).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })]
  })
  const facts = [
    ['Peer ID', `<span class="mono wrap">${esc(n.id)}</span>`],
    ['IP address', `<span class="mono">${esc(n.ip ?? '—')}</span>`],
    ['Location', esc(where(n.geo) || '—')],
    ['Network', esc(n.geo?.org ?? '—')],
    ['Public API', n.url ? `<a class="mono wrap" href="${esc(n.url)}/v1/info" rel="nofollow noopener">${esc(n.url)}</a>` : 'none (gossip only)'],
    ['Version', `<span class="mono">${esc(n.version ?? '—')}</span>`],
    ['Validator key', n.validator ? `<span class="mono wrap">${esc(n.validator)}</span>` : '—'],
    ['Connected peers', num(n.peers)],
    ['Seen by', `${num(n.seenBy)} peers`],
    ['Messages', num(n.messages)],
    ['Database', bytes(n.bytes)],
    ['API latency', n.ms == null ? '—' : `${n.ms} ms`],
    ['First seen', date(n.firstSeen)],
    ['Last seen', n.lastSeen ? ago(n.lastSeen) : 'now'],
  ]
  return `<p><a href="/">← Network</a></p>
<section class="banner ${n.state}"><span class="dot"></span><div><h1>${esc(n.name)}</h1><p>${STATE[n.state]}${n.validator ? ' · validator' : ''} · ${pct(n.uptime?.d1)} up today · ${pct(n.uptime?.d30)} over 30 days</p></div></section>
${n.shards?.length ? `<h2>Shards</h2><div class="table"><table><thead><tr><th>Shard</th><th>Height</th><th>Behind tip</th><th>Last block</th><th>Mempool</th></tr></thead><tbody>
${n.shards.map((s) => `<tr><td>Shard ${s.id}</td><td class="mono">#${num(s.height)}</td><td class="mono ${s.lag > 60 ? 'warn' : ''}">${num(s.lag)}</td>
<td class="${tips.get(s.id)?.stalled ? 'bad' : ''}">${dur(s.delay)} ago</td><td class="mono">${num(s.mempool)}</td></tr>`).join('')}</tbody></table></div>` : ''}
<h2>Uptime</h2>
<section class="card"><p class="small muted">Last 48 hours</p>${bars(hourly, 'Hourly uptime, last 48 hours')}
<p class="small muted">Last 90 days</p>${n.uptime ? bars(days(n.uptime), 'Daily uptime, last 90 days') : ''}</section>
<h2>Details</h2>
<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`
}

function render() {
  const m = location.pathname.match(/^\/node\/([^/]+)$/)
  if (!data) return void (app.innerHTML = '<p class="muted">The first crawl of the network is running. This page fills in within a minute.</p>')
  app.innerHTML = m ? node(data, decodeURIComponent(m[1])) : home(data)
  const n = m && data.nodes.find((x) => x.id === decodeURIComponent(m[1]))
  document.title = n ? `${n.name} · Hypersnap node status` : 'Hypersnap Network Status'
}

async function refresh() {
  try {
    const r = await fetch('/api/status')
    if (r.ok) data = await r.json()
    const m = location.pathname.match(/^\/node\/([^/]+)$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const h = await fetch(`/api/node/${encodeURIComponent(id)}`)
      nodeHours = h.ok ? { id, hours: (await h.json()).hours } : null
    }
  } catch {}
  render()
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a')
  if (!a || a.origin !== location.origin || !/^\/(node\/|$)/.test(a.pathname) || e.metaKey || e.ctrlKey || e.shiftKey) return
  e.preventDefault()
  history.pushState(null, '', a.pathname)
  scrollTo(0, 0)
  render()
  refresh()
})
addEventListener('popstate', () => (render(), refresh()))
render()
refresh()
setInterval(refresh, 30_000)
