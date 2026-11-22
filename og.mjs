// 1200×630 share cards, drawn as SVG from the live snapshot (server.mjs renders them with resvg).

export const NAMES = { hypersnap: 'Hypersnap', snapchain: 'Snapchain' }
const C = { bg: '#0c0e13', panel: '#151922', line: '#232937', text: '#f2f4f8', muted: '#8b93a7', ok: '#2fbf71', warn: '#f0a020', bad: '#ef4b4b', off: '#3a4150' }
const STATE = { operational: C.ok, partial: C.warn, major: C.bad, synced: C.ok, syncing: C.warn, gossip: C.ok, offline: C.bad }
const x = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const num = (n) => Number(n).toLocaleString('en-US')

export function dur(s) {
  if (!Number.isFinite(s)) return '?'
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

const frame = (net, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><radialGradient id="g" cx="0.15" cy="0" r="1"><stop offset="0" stop-color="#1b2133"/><stop offset="1" stop-color="${C.bg}"/></radialGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<g transform="translate(72 64)"><rect width="40" height="40" rx="10" fill="#6d5dfc"/><path d="M12 13h16M12 20h10M12 27h16" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/></g>
<text x="128" y="93" font-family="Inter" font-weight="700" font-size="28" fill="${C.text}">${NAMES[net]} Network Status</text>
<text x="1128" y="93" text-anchor="end" font-family="Inter" font-size="24" fill="${C.muted}">status.quilcast.com</text>
${body}</svg>`

export function headline(s) {
  const halted = s.shards.filter((h) => h.stalled)
  if (s.status === 'operational') return 'All systems operational'
  if (s.status === 'major') return 'Network halted'
  return `${halted.length === 1 ? 'Shard' : 'Shards'} ${halted.map((h) => h.id).join(', ')} halted`
}

export function siteCard(s, net = 'hypersnap') {
  const online = s.nodes.filter((n) => n.state !== 'offline').length
  const vs = new Map(s.shards.flatMap((h) => h.validators).map((v) => [v.key, v.online]))
  const rows = s.shards.map((h, i) => {
    const y = 368 + i * 80
    const on = h.validators.filter((v) => v.online).length
    const squares = h.validators.map((v, j) => `<rect x="${600 + j * 22}" y="${y - 22}" width="16" height="28" rx="4" fill="${v.online ? C.ok : C.off}"/>`).join('')
    return `<rect x="72" y="${y - 50}" width="1056" height="70" rx="14" fill="${C.panel}" stroke="${C.line}"/>
<circle cx="106" cy="${y - 15}" r="9" fill="${h.stalled ? C.bad : C.ok}"/>
<text x="130" y="${y - 5}" font-family="Inter" font-weight="700" font-size="28" fill="${C.text}">Shard ${h.id}</text>
<text x="290" y="${y - 5}" font-family="Inter" font-size="26" fill="${C.muted}">#${num(h.tip)}</text>
${squares}<text x="${600 + h.validators.length * 22 + 8}" y="${y - 5}" font-family="Inter" font-size="22" fill="${C.muted}">${on}/${h.validators.length}</text>
<text x="1104" y="${y - 5}" text-anchor="end" font-family="Inter" font-weight="700" font-size="26" fill="${h.stalled ? C.bad : C.ok}">${h.stalled ? `halted ${dur(h.delay)}` : 'live'}</text>`
  }).join('\n')
  return frame(net, `<circle cx="94" cy="196" r="16" fill="${STATE[s.status]}"/>
<text x="126" y="218" font-family="Inter" font-weight="700" font-size="62" fill="${C.text}">${x(headline(s))}</text>
<text x="72" y="270" font-family="Inter" font-size="28" fill="${C.muted}">${online} nodes online · ${[...vs.values()].filter(Boolean).length} of ${vs.size} validators in the mesh</text>
${rows}
<text x="72" y="590" font-family="Inter" font-size="22" fill="${C.muted}">Updated ${new Date(s.at).toISOString().slice(0, 16).replace('T', ' ')} UTC</text>`)
}

export function nodeCard(n, s) {
  const label = { synced: 'Synced', syncing: 'Syncing', gossip: 'Seen in gossip', offline: 'Offline' }[n.state]
  const place = [n.geo?.city, n.geo?.country].filter(Boolean).join(', ')
  const facts = [n.validator ? 'Validator' : 'Node', n.version && `v${n.version}`, n.ip, place].filter(Boolean).join('  ·  ')
  const up = n.uptime?.d30 != null ? `${(n.uptime.d30 * 100).toFixed(n.uptime.d30 === 1 ? 0 : 2)}%` : '—'
  const shards = (n.shards ?? []).map((h, i) => {
    const y = 390 + i * 58
    const tip = s.shards.find((t) => t.id === h.id)
    return `<text x="72" y="${y}" font-family="Inter" font-weight="700" font-size="26" fill="${C.text}">Shard ${h.id}</text>
<text x="230" y="${y}" font-family="Inter" font-size="26" fill="${C.muted}">#${num(h.height)}</text>
<text x="560" y="${y}" font-family="Inter" font-size="26" fill="${h.lag > 60 ? C.warn : C.ok}">${h.lag > 60 ? `${num(h.lag)} blocks behind` : tip?.stalled ? 'at tip (shard halted)' : 'at tip'}</text>`
  }).join('\n')
  return frame(n.net ?? 'hypersnap', `<circle cx="94" cy="196" r="16" fill="${STATE[n.state]}"/>
<text x="126" y="218" font-family="Inter" font-weight="700" font-size="54" fill="${C.text}">${x(cut(n.name, 32))}</text>
<text x="72" y="272" font-family="Inter" font-size="28" fill="${C.muted}">${x(cut(facts, 70))}</text>
<text x="72" y="326" font-family="Inter" font-weight="700" font-size="28" fill="${STATE[n.state]}">${label}</text>
<text x="1128" y="326" text-anchor="end" font-family="Inter" font-size="28" fill="${C.muted}">${s.at - s.since < 30 * 864e5 ? 'Uptime since launch' : '30-day uptime'} <tspan font-weight="700" fill="${C.text}">${up}</tspan></text>
${shards || `<text x="72" y="400" font-family="Inter" font-size="26" fill="${C.muted}">No public API: seen by ${n.seenBy} peers in the gossip mesh</text>`}`)
}
