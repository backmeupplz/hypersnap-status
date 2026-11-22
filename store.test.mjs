// The history bookkeeping over two crawls of both networks: a halt that ends, a node that goes missing, and two
// networks that share shard ids without touching each other's incidents or nodes.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { open, record } from './store.mjs'

const node = (id) => ({ id, name: id, url: `http://${id}:3381`, ip: null, state: 'synced', shards: [] })
const shard = (stalled, delay) => ({ id: 1, tip: 10, delay, stalled, validators: [] })

test('incidents close, missing nodes go offline, networks stay apart', () => {
  const db = open(':memory:')
  const t0 = Date.UTC(2026, 10, 21, 12)
  const t1 = t0 + 60_000
  const h0 = record(db, 'hypersnap', { nodes: [node('a'), node('b')], shards: [shard(true, 100)] }, t0)
  const s0 = record(db, 'snapchain', { nodes: [node('x')], shards: [shard(false, 1)] }, t0)
  assert.deepEqual(h0.incidents, [{ shard: 1, start: t0 - 100_000, end: null }])
  assert.deepEqual(s0.incidents, [])
  assert.equal(h0.since, t0)
  assert.equal(record(db, 'snapchain', { nodes: [], shards: [] }, t0 + 1).since, t0)
  assert.equal(s0.nodes.length, 1) // Hypersnap's nodes aren't Snapchain's offline ones

  // Snapchain's live shard 1 leaves Hypersnap's shard-1 halt open
  const s1 = record(db, 'snapchain', { nodes: [node('x')], shards: [shard(false, 1)] }, t1)
  assert.deepEqual(s1.incidents, [])
  const h1 = record(db, 'hypersnap', { nodes: [node('a')], shards: [shard(true, 160)] }, t1)
  assert.deepEqual(h1.incidents, [{ shard: 1, start: t0 - 100_000, end: null }])
  const gone = h1.nodes.find((n) => n.id === 'b')
  assert.equal(gone.state, 'offline')
  assert.equal(gone.lastSeen, t0)
  assert.equal(gone.uptime.d1, 0.5)
  assert.equal(h1.shards[0].uptime.d1, 0)
  assert.equal(s1.shards[0].uptime.d1, 1)

  const h2 = record(db, 'hypersnap', { nodes: [node('a')], shards: [shard(false, 1)] }, t1 + 60_000)
  assert.deepEqual(h2.incidents, [{ shard: 1, start: t0 - 100_000, end: t1 + 60_000 }])
})

test('a database from before Snapchain was tracked migrates once and keeps its rows as Hypersnap', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hs-')), 'status.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE peers (id TEXT PRIMARY KEY, first INTEGER, last INTEGER, url TEXT, json TEXT);
    CREATE TABLE incidents (n INTEGER PRIMARY KEY, shard INTEGER, start INTEGER, end INTEGER);
    INSERT INTO peers VALUES ('a', 1, ${Date.now()}, null, '{"id":"a","name":"a"}'); INSERT INTO incidents (shard, start) VALUES (1, 5)`)
  old.close()
  open(file).close()
  const db = open(file) // the second boot finds the columns already there
  const h = record(db, 'hypersnap', { nodes: [], shards: [shard(true, 1)] }, Date.now())
  assert.equal(h.nodes[0].state, 'offline')
  assert.deepEqual(h.incidents, [{ shard: 1, start: 5, end: null }])
  assert.equal(record(db, 'snapchain', { nodes: [], shards: [] }, Date.now()).nodes.length, 0)
})
