import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'

const output = path.resolve('test-results/library-performance/search.cjs')
await build({ entryPoints: ['src/renderer/src/features/library/librarySearch.ts'], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': path.resolve('src/shared') } })
const { createLibraryIndex } = createRequire(import.meta.url)(output)
const repetitions = 20
for (const count of [1000, 10000]) {
  const library = Array.from({ length: count }, (_, id) => ({ id: String(id), title: `Instrumental beat ${id}`,
    producer: 'Channel producer', sourceChannel: 'Original channel', fileName: `audio-${id}.wav`,
    bpm: 140, key: 'A minor', camelot: '8A', format: 'wav', missing: false }))
  const index = createLibraryIndex(library)
  const updated = library.map(beat => ({ ...beat, missing: true, analysisStatus: 'analyzing' }))
  for (let i = 0; i < 3; i++) { createLibraryIndex(updated); createLibraryIndex(updated, index) }
  let start = performance.now()
  for (let i = 0; i < repetitions; i++) createLibraryIndex(updated)
  const rebuildMs = (performance.now() - start) / repetitions
  start = performance.now()
  let reused = 0
  for (let i = 0; i < repetitions; i++) if (createLibraryIndex(updated, index) === index) reused++
  const reuseMs = (performance.now() - start) / repetitions
  assert.equal(reused, repetitions)
  console.log(JSON.stringify({ tracks: count, repetitions, reused, rebuildMs: +rebuildMs.toFixed(2), reuseMs: +reuseMs.toFixed(2) }))
}
