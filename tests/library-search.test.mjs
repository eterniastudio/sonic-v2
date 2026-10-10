import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const output = path.resolve('test-results/library-search/search.cjs')
await mkdir(path.dirname(output), { recursive: true })
await build({
  entryPoints: ['src/renderer/src/features/library/librarySearch.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: { '@shared': path.resolve('src/shared') }
})
const { createLibraryIndex, searchLibrary, searchSmartCollection } = require(output)

function beat(id, patch = {}) {
  return {
    id, title: id, producer: null, sourceChannel: null, fileName: `${id}.flac`,
    key: null, camelot: null, bpm: null, format: 'flac', missing: false,
    analysisStatus: 'estimated', verification: null, addedAt: 0, ...patch
  }
}
const beats = [
  beat('old-title', { title: 'Magnetic Pulse', bpm: 140, key: 'A minor', camelot: '8A', addedAt: 1 }),
  beat('new-producer', { title: 'Another Track', producer: 'Magnetic Pulse', bpm: 70, key: 'C major', camelot: '8B', addedAt: 5 }),
  beat('double', { title: 'Fast Track', bpm: 280, key: 'A minor', camelot: '8A', addedAt: 4 }),
  beat('missing', { title: 'Missing Track', bpm: 141, key: 'A minor', camelot: '8A', missing: true, addedAt: 3 }),
  beat('review', { title: 'Needs Review', bpm: 139, key: 'A minor', camelot: '8A', analysisStatus: 'failed',
    verification: { fields: [{ field: 'bpm', verdict: 'mismatch' }] }, addedAt: 2 })
]
const index = createLibraryIndex(beats)
const defaults = {
  query: '', sort: 'newest', bands: new Set(), formats: new Set(), fileFilter: 'all',
  reviewFilter: 'all', bpm: '', bpmTolerance: 3, includeHalfDouble: false, key: ''
}
const ids = (patch) => searchLibrary(beats, index, { ...defaults, ...patch }).map((item) => item.id)

assert.deepEqual(ids({ query: 'magnetic pulse', sort: 'relevance' }).slice(0, 2), ['old-title', 'new-producer'])
assert.deepEqual(ids({ query: 'magnetic pulse', sort: 'newest' }).slice(0, 2), ['new-producer', 'old-title'])
assert.deepEqual(ids({ bpm: '140', fileFilter: 'present' }), ['review', 'old-title'])
assert.deepEqual(ids({ bpm: '140', fileFilter: 'present', includeHalfDouble: true }),
  ['new-producer', 'double', 'review', 'old-title'])
assert.deepEqual(ids({ key: '8a', fileFilter: 'present' }), ['double', 'review', 'old-title'])
assert.deepEqual(ids({ key: 'A minor', fileFilter: 'present' }), ['double', 'review', 'old-title'])
assert.deepEqual(ids({ fileFilter: 'missing' }), ['missing'])
assert.deepEqual(ids({ reviewFilter: 'incomplete' }), ['review'])
assert.deepEqual(ids({ reviewFilter: 'disagreement' }), ['review'])
assert.deepEqual(ids({ bpm: 'invalid' }), [])
assert.deepEqual(ids({ key: 'A' }), [])
assert.deepEqual(ids({ query: '140 pulse' }), ['old-title'])
assert.deepEqual(ids({ query: '140 8A pulse' }), ['old-title'])
assert.deepEqual(searchSmartCollection(beats, index, { query: '140 pulse' }, {}, 'newest').map(item => item.id), ['old-title'])

const statusUpdate = beats.map(item => ({ ...item, missing: true, analysisStatus: 'analyzing',
  analysis: { status: 'running' }, sidecarSync: { status: 'pending', error: null } }))
const reused = createLibraryIndex(statusUpdate, index)
assert.equal(reused, index, 'non-search metadata must reuse the existing index')
assert.deepEqual(searchLibrary(statusUpdate, reused, { ...defaults, query: '140 pulse', fileFilter: 'missing' }).map(item => item.id), ['old-title'])
assert.equal(searchLibrary(statusUpdate, reused, { ...defaults, query: '140 pulse' })[0], statusUpdate[0], 'results use current records')

for (const [field, value] of Object.entries({ title: 'Changed title', producer: 'New credit',
  sourceChannel: 'New channel', fileName: 'New filename.wav', key: 'D minor', camelot: '7A', format: 'wav', bpm: 145 })) {
  const changed = beats.map((item, position) => position === 0 ? { ...item, [field]: value } : item)
  assert.notEqual(createLibraryIndex(changed, index), index, `${field} changes must rebuild the index`)
}
const changedTempo = beats.map((item, position) => position === 0 ? { ...item, bpm: 145 } : item)
assert.deepEqual(searchLibrary(changedTempo, createLibraryIndex(changedTempo, index), { ...defaults, query: '145 pulse' }).map(item => item.id), ['old-title'])
assert.notEqual(createLibraryIndex(beats.slice(1), index), index)
assert.notEqual(createLibraryIndex([...beats, beat('added')], index), index)
assert.notEqual(createLibraryIndex([...beats].reverse(), index), index)
assert.deepEqual(beats.map(item => item.id), ['old-title', 'new-producer', 'double', 'missing', 'review'])
console.log('Library search and index reuse: all regression cases passed')
