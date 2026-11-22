// The history bookkeeping over two crawls: a halt that ends, and a node that goes missing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { open, record } from './store.mjs'

const node = (id) => ({ id, name: id, url: `http://${id}:3381`, ip: null, state: 'synced', shards: [] })
const shard = (stalled, delay) => ({ id: 1, tip: 10, delay, stalled, validators: [] })

test('incidents close, missing nodes go offline, uptime counts both', () => {
  const db = open(':memory:')
  const t0 = Date.UTC(2026, 10, 21, 12)
  const a = record(db, { nodes: [node('a'), node('b')], shards: [shard(true, 100)] }, t0)
  assert.deepEqual([...a.incidents].map((r) => ({ ...r })), [{ shard: 1, start: t0 - 100_000, end: null }])
  assert.equal(a.since, t0)

  const b = record(db, { nodes: [node('a')], shards: [shard(false, 1)] }, t0 + 60_000)
  assert.deepEqual([...b.incidents].map((r) => ({ ...r })), [{ shard: 1, start: t0 - 100_000, end: t0 + 60_000 }])
  const gone = b.nodes.find((n) => n.id === 'b')
  assert.equal(gone.state, 'offline')
  assert.equal(gone.lastSeen, t0)
  assert.equal(gone.uptime.d1, 0.5)
  assert.equal(b.nodes.find((n) => n.id === 'a').uptime.d1, 1)
  assert.equal(b.shards[0].uptime.d1, 0.5)
  assert.equal(b.since, t0)
})
