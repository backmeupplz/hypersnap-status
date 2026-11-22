// A real crawl from 2026-11-21 (fixture.json + fixture-validators.toml): shard 1 halted network-wide, haatz behind on
// shards 0 and 2, 159.195.236.247 behind on shard 1, and upstream Snapchain nodes in the same gossip mesh.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseValidators, peerIdOf, summarize } from './status.mjs'

const raw = JSON.parse(readFileSync(new URL('fixture.json', import.meta.url)))
const crawl = { probes: new Map(raw.probes), seen: new Map(raw.seen.map(([k, v]) => [k, { ...v, by: new Set(v.by) }])) }
const vals = parseValidators(readFileSync(new URL('fixture-validators.toml', import.meta.url), 'utf8'))
const s = summarize(crawl, vals, 0)
const node = (name) => s.nodes.find((n) => n.name === name)

test('peer ids come from validator keys', () => {
  assert.equal(peerIdOf('ae46d4ae50bee1a9cf6d798ddddd1d7f54c8314eaf85ac0efa3bf685c9506119'), '12D3KooWMYfkXiNcn9LifPkLYiHtGmXYnknYG1yFBD53rUseUMUc')
})

test('only Hypersnap nodes are listed', () => {
  assert.ok(!s.nodes.some((n) => n.version === '0.17.0' || n.ip === '107.20.169.236'))
  assert.ok(s.other > 0)
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
