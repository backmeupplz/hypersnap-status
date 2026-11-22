// A real crawl from 2026-11-21 (fixture.json + fixture-validators.toml): shard 1 halted network-wide, haatz behind on
// shards 0 and 2, 159.195.236.247 behind on shard 1, and upstream Snapchain nodes in the same gossip mesh.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseValidators, peerIdOf, summarize } from './status.mjs'

const raw = JSON.parse(readFileSync(new URL('fixture.json', import.meta.url)))
const crawl = { probes: new Map(raw.probes), seen: new Map(raw.seen.map(([k, v]) => [k, { ...v, by: new Set(v.by), caps: new Set(v.contact?.capabilities ?? []) }])) }
const load = (f) => parseValidators(readFileSync(new URL(f, import.meta.url), 'utf8'))
const vals = { hypersnap: load('fixture-validators.toml'), snapchain: load('fixture-snapchain-validators.toml') }
const all = summarize(crawl, vals, 0)
const s = all.networks.hypersnap
const snap = all.networks.snapchain
const node = (name) => s.nodes.find((n) => n.name === name)

test('peer ids come from validator keys', () => {
  assert.equal(peerIdOf('ae46d4ae50bee1a9cf6d798ddddd1d7f54c8314eaf85ac0efa3bf685c9506119'), '12D3KooWMYfkXiNcn9LifPkLYiHtGmXYnknYG1yFBD53rUseUMUc')
})

test('Hypersnap and Snapchain nodes are told apart', () => {
  assert.ok(!s.nodes.some((n) => n.version === '0.17.0' || n.ip === '107.20.169.236'))
  assert.ok(!snap.nodes.some((n) => n.version === '0.17.17'))
  // named from the fleet table: no API, known only as a peer
  assert.equal(snap.nodes.find((n) => n.ip === '54.87.204.167')?.name, 'crackle (Merkle)')
  assert.equal(snap.nodes.find((n) => n.ip === '107.20.169.236')?.name, 'mordor (Neynar)')
  // Snapchain's shards run ahead of Hypersnap's fork and all produce blocks
  assert.ok(snap.shards.every((x) => !x.stalled) && snap.shards[0].tip > s.shards[0].tip)
})

test('shard 1 is halted, the others are live', () => {
  assert.deepEqual(s.shards.map((x) => [x.id, x.stalled]), [[0, false], [1, true], [2, false]])
  assert.equal(s.status, 'partial')
})

test('lagging nodes are syncing, the rest synced', () => {
  assert.equal(node('cassie (haatz.quilibrium.com)').state, 'syncing')
  assert.equal(node('derekhoiem').state, 'syncing')
  assert.equal(node('arfonzo').state, 'synced')
  assert.equal(node('cassie (haatz.quilibrium.com)').url, 'https://haatz.quilibrium.com')
})

test('validator sets follow the tip, with the scheduled rotation as next', () => {
  const s1 = s.shards[1]
  assert.ok(s1.validators.length > 0 && s1.next.at === 51639354)
})

test('one bogus node can neither move a tip nor hide a halt', () => {
  const probes = new Map(crawl.probes)
  probes.set('bogus', { urls: ['http://1.2.3.4:3381'], hyper: true, peers: 0, info: { shardInfos: [{ shardId: 1, maxHeight: 99e9, blockDelay: 0 }, { shardId: '<img>', maxHeight: 1, blockDelay: 0 }] } })
  const b = summarize({ probes, seen: crawl.seen }, vals, 0).networks.hypersnap
  assert.deepEqual(b.shards.map((x) => [x.id, x.stalled, x.tip]), s.shards.map((x) => [x.id, x.stalled, x.tip]))
  assert.equal(node('arfonzo').state, b.nodes.find((n) => n.name === 'arfonzo').state)
})

test('a peer known from before stays listed without its capability', () => {
  const id = s.nodes.find((n) => n.state === 'gossip' && !n.validator).id
  const seen = new Map(crawl.seen)
  seen.set(id, { ...seen.get(id), caps: new Set() })
  assert.ok(!summarize({ probes: crawl.probes, seen }, vals, 0).networks.hypersnap.nodes.some((n) => n.id === id))
  assert.ok(summarize({ probes: crawl.probes, seen }, vals, 0, new Map([[id, 'hypersnap']])).networks.hypersnap.nodes.some((n) => n.id === id))
})
