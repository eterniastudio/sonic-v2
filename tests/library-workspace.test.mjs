import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'

const output = path.resolve('test-results/library-workspace/store.cjs')
await build({ entryPoints: ['src/renderer/src/store/libraryWorkspace.ts'], outfile: output,
  bundle: true, platform: 'node', format: 'cjs' })
const { useLibraryWorkspace: store, reconcileWorkspace } = createRequire(import.meta.url)(output)

test('returning to an unchanged scope is a no-op, including shortlist and scroll', () => {
  store.setState({ selectionScope: 'collection:one', selectedIds: new Set(['a', 'b']),
    selectedId: 'c', selectionAnchor: 'b', scrollTop: 420 })
  const before = store.getState()
  reconcileWorkspace('collection:one', ['a', 'b'], ['a', 'b', 'c'])
  assert.equal(store.getState(), before)
  // Reordering does not change the result scope or the range anchor.
  reconcileWorkspace('collection:one', ['b', 'a'], ['a', 'b', 'c'])
  assert.equal(store.getState(), before)
})

test('changed results prune targets and anchor but retain an existing hidden inspector', () => {
  store.setState({ selectionScope: 'smart:favorite', selectedIds: new Set(['a', 'b']),
    selectedId: 'c', selectionAnchor: 'a', scrollTop: 420 })
  reconcileWorkspace('smart:favorite', ['b', 'd'], ['a', 'b', 'c', 'd'])
  assert.deepEqual([...store.getState().selectedIds], ['b'])
  assert.equal(store.getState().selectionAnchor, null)
  assert.equal(store.getState().selectedId, 'c')
  assert.equal(store.getState().scrollTop, 420)
  reconcileWorkspace('smart:favorite', [], ['b'])
  assert.equal(store.getState().selectedIds.size, 0)
  assert.equal(store.getState().selectedId, null)
})

test('explicit filter, collection or smart-rule changes clear selection even with identical results', () => {
  for (const scope of ['query:changed', 'collection:two', 'smart:changed-rules']) {
    store.setState({ selectionScope: 'previous', selectedIds: new Set(['a']),
      selectedId: 'a', selectionAnchor: 'a', scrollTop: 420 })
    reconcileWorkspace(scope, ['a'], ['a'])
    assert.equal(store.getState().selectedIds.size, 0)
    assert.equal(store.getState().selectionAnchor, null)
    assert.equal(store.getState().scrollTop, 0)
    assert.equal(store.getState().selectedId, 'a')
  }
})
