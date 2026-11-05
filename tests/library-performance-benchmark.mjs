// Library hot paths outside React: search indexing, library pushes to the
// renderer (full list vs. delta), and filtered search.
//   node tests/library-performance-benchmark.mjs
//   SONIC_BENCH_SIZES=5000,20000 node tests/library-performance-benchmark.mjs
//   SONIC_BENCH_REF=HEAD node tests/library-performance-benchmark.mjs   (renderer sources of a git revision)
// Electron's IPC serializes with the V8 structured-clone serializer, which
// `v8.serialize`/`v8.deserialize` reproduce here.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import v8 from 'node:v8'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const ref = process.env.SONIC_BENCH_REF || null
async function load(entry, name) {
  let source = entry
  if (ref) {
    try { source = path.resolve(`test-results/library-performance/ref/${entry}`); fs.mkdirSync(path.dirname(source), { recursive: true })
      fs.writeFileSync(source, execFileSync('git', ['show', `${ref}:${entry}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) }
    catch { return {} }
  }
  const outfile = path.resolve(`test-results/library-performance/${ref ? 'ref-' : ''}${name}.cjs`)
  await build({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    alias: { '@shared': path.resolve('src/shared'), '@': path.resolve('src/renderer/src') } })
  return require(outfile)
}
const { createLibraryIndex, searchLibrary } = await load('src/renderer/src/features/library/librarySearch.ts', 'search')
const { reuseSnapshotItems, applySnapshotDelta } = await load('src/renderer/src/store/snapshots.ts', 'snapshots')
const { LibraryDeltaEncoder } = await load('src/main/libraryDelta.ts', 'delta')

const sizes = (process.env.SONIC_BENCH_SIZES || '1000,10000').split(',').map(Number)
const repetitions = Number(process.env.SONIC_BENCH_REPETITIONS || 20)
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
function time(fn, count = repetitions) {
  for (let i = 0; i < 3; i++) fn()
  const samples = []
  for (let i = 0; i < count; i++) { const start = performance.now(); fn(); samples.push(performance.now() - start) }
  return +median(samples).toFixed(2)
}

/** Same record shape as tests/storage-commit-benchmark.mjs. */
function record(index) {
  const id = `beat-${index}`
  return {
    id, title: `Instrumental beat ${index % 997} ${['Night', 'Gold', 'Rain', 'Echo'][index % 4]}`, producer: `Producer ${index % 211}`,
    bpm: 70 + (index % 110), altBpm: null, key: 'A minor', camelot: '8A', detune: 0, presetId: 'original', format: index % 3 ? 'wav' : 'mp3',
    filePath: `C:\\Users\\producer\\Music\\Beats\\${id}.wav`, fileName: `audio-${index}.wav`, fileOwnership: 'external', sidecarPath: null,
    publishedTags: null, sizeBytes: 52_000_000, durationSec: 180, bitrateKbps: 1411, sampleRate: 44100, channels: 2, sourceUrl: null,
    sourceChannel: 'Original channel', thumbnail: null, sourceKind: 'local', addedAt: 1_700_000_000_000 + index, fingerprint: 'f'.repeat(64),
    missing: false, fileAccessError: null, analysisStatus: 'estimated', overrides: index % 7 ? [] : ['bpm'],
    sources: { title: {}, description: {}, filename: index % 2 ? { bpm: 70 + (index % 110) } : {} }, embedded: { title: id },
    analysis: { engine: 'sonic-dsp/4', inputId: 'a'.repeat(64), inputName: `${id}.wav`, analyzedAt: 1, analyzedSeconds: 120,
      sampleRate: 22050, channels: 1, durationSec: 180,
      tempo: { status: 'estimated', bpm: 70 + (index % 110), bpmExact: 70 + (index % 110), confidence: 0.82, warning: null,
        alternatives: Array.from({ length: 5 }, (_, i) => ({ bpm: 70 * (i + 1), relation: i ? 'other' : 'half', strength: 0.9 - i / 10 })) },
      key: { status: 'estimated', key: 'A minor', camelot: '8A', confidence: 0.71, correlation: 0.8, warning: null,
        alternatives: Array.from({ length: 23 }, (_, i) => ({ key: `k${i}`, camelot: null, correlation: i / 24 })) },
      warnings: [] },
    verification: null
  }
}

for (const count of sizes) {
  const library = Array.from({ length: count }, (_, index) => record(index))
  const result = { ref: ref ?? 'working-tree', tracks: count, repetitions }

  // 1. Search index. Unindexed changes reuse it (measured 2026-10-04). An indexed
  //    change (analysis fills a BPM, a title edit) replaces it; that cost is paid
  //    on every such library push, while the first query pays for building.
  const index = createLibraryIndex(library)
  const updated = library.map(beat => ({ ...beat, missing: true, analysisStatus: 'analyzing' }))
  result.indexReuseMs = time(() => assert.equal(createLibraryIndex(updated, index), index))
  const retitled = library.map((beat, position) => position === 7 ? { ...beat, bpm: 141 } : beat)
  result.indexedChangeMs = time(() => createLibraryIndex(retitled, index), 5)
  result.indexedChangeThenSearchMs = time(() => createLibraryIndex(retitled, index).search('night beat'), 5)
  assert.deepEqual(createLibraryIndex(retitled).search('night beat').map(hit => hit.id).slice(0, 50),
    createLibraryIndex(retitled, index).search('night beat').map(hit => hit.id).slice(0, 50))

  // 2. One record changes (an analysis result, a rename): push it to the renderer.
  //    The renderer already holds the previous list; it must end with identical
  //    contents and keep every unchanged record object.
  const rendererPrevious = v8.deserialize(v8.serialize(library))
  // Search timings run before the push section allocates its copies, so both revisions measure the same heap.
  searchTimings(result, library, index)
  if (!applySnapshotDelta) { console.log(JSON.stringify(result)); continue }
  const edited = library.map((beat, position) => position === Math.floor(count / 2) ? { ...beat, bpm: 141, analysisStatus: 'estimated' } : beat)
  const fullBytes = v8.serialize(edited).length
  result.pushFullMs = time(() => {
    const received = v8.deserialize(v8.serialize(edited))
    const next = reuseSnapshotItems(rendererPrevious, received)
    assert.equal(next[0], rendererPrevious[0])
  })
  const encoder = new LibraryDeltaEncoder()
  let deltaBytes = 0
  result.pushDeltaMs = time(() => {
    encoder.encode(library)
    const encoded = encoder.encode(edited)
    assert.ok('delta' in encoded && encoded.delta.changed.length === 1)
    const bytes = v8.serialize(encoded.delta)
    deltaBytes = bytes.length
    const received = v8.deserialize(bytes)
    const next = applySnapshotDelta(rendererPrevious, received.ids, received.changed)
    assert.equal(next[0], rendererPrevious[0])
  })
  {
    encoder.encode(library)
    const { delta } = encoder.encode(edited)
    assert.deepEqual(applySnapshotDelta(rendererPrevious, delta.ids, v8.deserialize(v8.serialize(delta.changed))), edited)
    assert.deepEqual(reuseSnapshotItems(rendererPrevious, v8.deserialize(v8.serialize(edited))), edited)
  }
  result.pushFullKB = Math.round(fullBytes / 1024)
  result.pushDeltaKB = Math.round(deltaBytes / 1024)

  console.log(JSON.stringify(result))
}

// 3. Filtering a search result by key, and sorting it by title.
function searchTimings(result, library, index) {
  const options = { query: '', sort: 'newest', bands: new Set(), formats: new Set(), fileFilter: 'all', reviewFilter: 'all',
    bpm: '', bpmTolerance: 0, includeHalfDouble: false, key: '' }
  result.keyFilterMs = time(() => searchLibrary(library, index, { ...options, key: 'Am' }), 5)
  result.sortTitleMs = time(() => searchLibrary(library, index, { ...options, sort: 'title' }), 5)
  return result
}
