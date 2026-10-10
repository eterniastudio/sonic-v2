import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'

const output = path.resolve('test-results/snapshot-sharing/app.cjs')
await build({ entryPoints: ['src/renderer/src/store/app.ts'], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': path.resolve('src/shared') } })
const { useApp: store } = createRequire(import.meta.url)(output)
const clone = value => JSON.parse(JSON.stringify(value))
const rows = () => [
  { id: 'a', title: 'Alpha', overrides: ['title'], analysis: { bpm: 140 }, sources: { title: { title: 'Alpha' } } },
  { id: 'b', title: 'Beta', overrides: [], analysis: null, sources: { title: {} } }
]

test('identical cloned library snapshots keep the state and issue no notification', () => {
  store.setState({ library: rows() })
  const before = store.getState()
  let notifications = 0
  const unsubscribe = store.subscribe(() => notifications++)
  store.getState().setLibrarySnapshot(clone(before.library))
  unsubscribe()
  assert.equal(store.getState(), before)
  assert.equal(notifications, 0)
})

test('a nested library update replaces only its record and preserves all changed evidence', () => {
  const before = rows()
  store.setState({ library: before })
  const incoming = clone(before)
  incoming[0].analysis.bpm = 145
  incoming[0].overrides.push('bpm')
  incoming[0].sources.title.producer = 'New credit'
  store.getState().setLibrarySnapshot(incoming)
  const after = store.getState().library
  assert.equal(after[0], incoming[0])
  assert.equal(after[1], before[1])
  assert.deepEqual(after, incoming)
})

test('library additions, deletions and reordering preserve incoming order and surviving identities', () => {
  const before = rows()
  store.setState({ library: before })
  const incoming = [clone(before[1]), { id: 'c', title: 'Gamma' }, clone(before[0])]
  store.getState().setLibrarySnapshot(incoming)
  assert.deepEqual(store.getState().library.map(item => item.id), ['b', 'c', 'a'])
  assert.equal(store.getState().library[0], before[1])
  assert.equal(store.getState().library[2], before[0])
  store.getState().setLibrarySnapshot([clone(before[1])])
  assert.deepEqual(store.getState().library, [before[1]])
  assert.equal(store.getState().library[0], before[1])
})

test('equal queue snapshots are silent and queue controls keep unchanged job identities', () => {
  store.setState({ queue: { jobs: rows(), paused: false, concurrency: 2 } })
  const before = store.getState()
  store.getState().setQueueSnapshot(clone(before.queue))
  assert.equal(store.getState(), before)
  const incoming = clone(before.queue)
  incoming.paused = true
  incoming.concurrency = 3
  store.getState().setQueueSnapshot(incoming)
  assert.equal(store.getState().queue.jobs, before.queue.jobs)
  assert.equal(store.getState().queue.paused, true)
  assert.equal(store.getState().queue.concurrency, 3)
})

test('nested queue progress, removed properties and null changes are retained', () => {
  const jobs = rows()
  store.setState({ queue: { jobs, paused: false, concurrency: 2 } })
  const incoming = clone(store.getState().queue)
  delete incoming.jobs[0].sources.title.title
  incoming.jobs[0].analysis = null
  incoming.jobs[0].progress = 0.4
  store.getState().setQueueSnapshot(incoming)
  assert.equal(store.getState().queue.jobs[0], incoming.jobs[0])
  assert.equal(store.getState().queue.jobs[1], jobs[1])
  assert.deepEqual(store.getState().queue, incoming)
})
