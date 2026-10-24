// Behaviour of the October 24 performance paths: record-cached library commits,
// library push deltas, the lazily built search index, and import lookups.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
async function load(entry, name) {
  const outfile = path.resolve(`test-results/performance-paths/${name}.cjs`)
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    alias: { '@shared': path.resolve('src/shared') } })
  return require(outfile)
}
const storage = await load('src/main/lib/jsonStore.ts', 'jsonStore')
const { applySnapshotDelta, reuseSnapshotItems } = await load('src/renderer/src/store/snapshots.ts', 'snapshots')
const { LibraryDeltaEncoder } = await load('src/main/libraryDelta.ts', 'delta')
const { createLibraryIndex, searchLibrary } = await load('src/renderer/src/features/library/librarySearch.ts', 'search')

const record = (id, patch = {}) => ({ id, title: `Title ${id}`, nested: { list: [{ value: id }] }, ...patch })

test('a record-cached store writes the same bytes, copies only new records, and freezes what it owns', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'sonic-record-cache-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const file = path.join(profile, 'library.json')
  fs.writeFileSync(file, JSON.stringify([record('a'), record('b'), record('c')], null, 2))
  const store = new storage.JsonStore(file, [], raw => raw, { recordCache: true })
  const loaded = store.read()
  assert.ok(Object.isFrozen(loaded[0]) && Object.isFrozen(loaded[0].nested.list[0]))
  assert.throws(() => { 'use strict'; loaded[0].title = 'mutated' }, TypeError)

  const replacement = { ...loaded[1], title: 'Edited', nested: { list: [{ value: 'edited' }] } }
  const next = [loaded[0], replacement, loaded[2], record('d')]
  const committed = store.write(next)
  const nextBytes = JSON.stringify(next)
  assert.equal(await readFile(file, 'utf8'), nextBytes)
  assert.equal(committed[0], loaded[0], 'unchanged records keep their identity')
  assert.equal(committed[2], loaded[2])
  assert.notEqual(committed[1], replacement, 'a new record is copied, so later caller changes cannot reach the store')
  assert.deepEqual(committed[1], replacement)
  assert.ok(Object.isFrozen(committed[1]) && Object.isFrozen(committed[3].nested))
  replacement.title = 'changed after commit'
  assert.equal(store.read()[1].title, 'Edited')

  // Removal, reordering and a second commit of an owned record serialize exactly.
  const reordered = [committed[3], committed[0]]
  store.write(reordered)
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(reordered))
  assert.equal(fs.readFileSync(`${file}.backup`, 'utf8'), nextBytes)
})

test('a record-cached store keeps failed-write and retry semantics', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'sonic-record-retry-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const file = path.join(profile, 'library.json')
  fs.writeFileSync(file, JSON.stringify([record('a')]))
  const store = new storage.JsonStore(file, [], raw => raw, { recordCache: true })
  const before = store.read()
  fs.mkdirSync(`${file}.backup`) // A directory cannot be replaced by the backup rename.
  assert.throws(() => store.write([...before, record('b')]))
  assert.equal(store.read(), before, 'the acknowledged snapshot stays in place')
  assert.throws(() => store.write([record('other')]), /must be retried/)
  fs.rmdirSync(`${file}.backup`)
  storage.retryStorage()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [record('a'), record('b')])
  assert.equal(store.read()[0], before[0])
})

test('library deltas rebuild the pushed list exactly and fall back when they cannot', () => {
  const encoder = new LibraryDeltaEncoder()
  const first = [record('a'), record('b'), record('c')]
  assert.ok('full' in encoder.encode(first), 'the first push is complete')
  const renderer = structuredClone(first)
  const second = [first[2], { ...first[0], title: 'Edited' }, first[1], record('d')]
  const encoded = encoder.encode(second)
  assert.ok('delta' in encoded)
  assert.deepEqual(encoded.delta.ids, ['c', 'a', 'b', 'd'])
  assert.deepEqual(encoded.delta.changed.map(item => item.id), ['a', 'd'])
  const applied = applySnapshotDelta(renderer, encoded.delta.ids, structuredClone(encoded.delta.changed))
  assert.deepEqual(applied, second)
  assert.equal(applied[0], renderer[2], 'unchanged rows keep their renderer objects')
  assert.equal(applied[2], renderer[1])
  assert.deepEqual(applied, reuseSnapshotItems(renderer, structuredClone(second)))

  // An equal "changed" record keeps the renderer object; an unchanged push keeps the array.
  const same = applySnapshotDelta(renderer, ['a', 'b', 'c'], [structuredClone(renderer[0])])
  assert.equal(same, renderer)
  // Removal is expressed by omission from the ids.
  assert.deepEqual(applySnapshotDelta(renderer, ['b'], []), [renderer[1]])
  // An id the renderer has never seen cannot be rebuilt.
  assert.equal(applySnapshotDelta([], ['a'], []), null)
  // Mostly changed lists are sent whole.
  assert.ok('full' in encoder.encode(second.map(item => ({ ...item }))))
})

test('the lazily built search index answers exactly as an eagerly built one', () => {
  const library = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, title: `Night ${i % 7} beat`, producer: `P${i % 3}`,
    sourceChannel: null, fileName: `b${i}.wav`, key: i % 2 ? 'A minor' : 'C major', camelot: i % 2 ? '8A' : '8B',
    format: 'wav', bpm: 100 + i, addedAt: i, missing: false, fileAccessError: null, analysisStatus: 'estimated', verification: null }))
  const index = createLibraryIndex(library)
  assert.equal(index.built, false, 'creating an index does not build it')
  assert.equal(createLibraryIndex(library.map(beat => ({ ...beat, missing: true })), index), index)
  const edited = library.map((beat, i) => i === 3 ? { ...beat, title: 'Gold rain' } : beat)
  const replaced = createLibraryIndex(edited, index)
  assert.notEqual(replaced, index)
  const options = { query: 'night', sort: 'relevance', bands: new Set(), formats: new Set(), fileFilter: 'all', reviewFilter: 'all',
    bpm: '', bpmTolerance: 0, includeHalfDouble: false, key: '' }
  const viaLazy = searchLibrary(edited, replaced, options).map(beat => beat.id)
  assert.equal(replaced.built, true)
  assert.deepEqual(viaLazy, searchLibrary(edited, createLibraryIndex(edited), options).map(beat => beat.id))
  assert.deepEqual(searchLibrary(edited, replaced, { ...options, query: 'gold' }).map(beat => beat.id), ['b3'])
  assert.deepEqual(searchLibrary(edited, replaced, { ...options, query: '', sort: 'newest', key: '8A' }).map(beat => beat.id),
    edited.filter(beat => beat.camelot === '8A').sort((a, b) => b.addedAt - a.addedAt).map(beat => beat.id))
})
