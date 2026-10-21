// Library commit cost: N local imports into an existing library, and the
// status writes of a batch analysis. Runs the real library and storage sources.
//   node tests/storage-commit-benchmark.mjs                 (working tree)
//   SONIC_BENCH_REF=HEAD node tests/storage-commit-benchmark.mjs   (a git revision, for comparison)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ref = process.env.SONIC_BENCH_REF || null
const existing = Number(process.env.SONIC_BENCH_EXISTING || 5000)
const imports = Number(process.env.SONIC_BENCH_IMPORTS || 1000)
const analyzed = Number(process.env.SONIC_BENCH_ANALYZED || 100)

function source(relativePath) {
  if (!ref) return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  return execFileSync('git', ['show', `${ref}:${path.posix.normalize(path.posix.join('tests', relativePath))}`], { encoding: 'utf8' })
}
function loadSource(relativePath, resolve) {
  const compiled = ts.transpileModule(source(relativePath), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  const module = { exports: {} }
  new Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`).runInThisContext()(resolve, module, module.exports)
  return module.exports
}
const sharedModules = new Map()
function shared(name) {
  if (!sharedModules.has(name)) {
    const url = new URL(`../src/shared/${name}.ts`, import.meta.url)
    const compiled = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } })
    const module = { exports: {} }
    sharedModules.set(name, module.exports)
    new Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`).runInThisContext()(
      dependency => shared(dependency.slice(2)), module, module.exports)
    sharedModules.set(name, module.exports)
  }
  return sharedModules.get(name)
}

function beat(id) {
  return {
    id, title: `Imported instrumental ${id}`, producer: 'Producer', bpm: 140, altBpm: 70, key: 'A minor', camelot: '8A',
    detune: 0, presetId: 'original', format: 'wav', filePath: `C:\\Users\\producer\\Music\\Beats\\${id}.wav`, fileName: `${id}.wav`,
    fileOwnership: 'external', sidecarPath: null, publishedTags: null, sizeBytes: 52_000_000, durationSec: 180,
    bitrateKbps: 1411, sampleRate: 44100, channels: 2, sourceUrl: null, sourceChannel: null, thumbnail: null,
    sourceKind: 'local', addedAt: Date.now(), fingerprint: 'f'.repeat(64), missing: false, fileAccessError: null,
    analysisStatus: 'estimated', overrides: [], sources: { title: {}, description: {}, filename: { bpm: 140, key: 'A minor' } },
    embedded: { title: `Imported instrumental ${id}` },
    analysis: { engine: 'sonic-dsp/3', inputId: 'a'.repeat(64), inputName: `${id}.wav`, analyzedAt: Date.now(), analyzedSeconds: 120,
      sampleRate: 22050, channels: 1, durationSec: 180,
      tempo: { bpm: 140, confidence: 0.82, candidates: Array.from({ length: 5 }, (_, i) => ({ bpm: 70 * (i + 1), score: 0.9 - i / 10 })) },
      key: { key: 'A minor', camelot: '8A', confidence: 0.71, scores: Array.from({ length: 24 }, (_, i) => ({ key: `k${i}`, score: i / 24 })) },
      warnings: [] },
    verification: null
  }
}

async function scenario() {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sonic-commit-bench-'))
  const libraryFile = path.join(profile, 'library.json')
  await fsp.writeFile(libraryFile, JSON.stringify(Array.from({ length: existing }, (_, i) => beat(`existing-${i}`)), null, 2))
  const storage = loadSource('../src/main/lib/jsonStore.ts', require)
  const dependencies = {
    'node:crypto': require('node:crypto'), 'node:events': require('node:events'), 'node:fs': fs, 'node:fs/promises': fsp,
    'node:path': require('node:path'), '../lib/jsonStore': storage,
    '../lib/fileIdentity': loadSource('../src/main/lib/fileIdentity.ts', require),
    '../lib/fsx': { fileExists: async () => true, sha256File: async () => 'a'.repeat(64) },
    './paths': { libraryFile: () => libraryFile }, './settings': { settingsService: { get: () => ({ namingTemplate: '{title}' }) } },
    '../lifecycle': { isStopping: () => false }
  }
  const { libraryService } = loadSource('../src/main/services/library.ts', name => {
    if (name.startsWith('@shared/')) return shared(name.slice(8))
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected library dependency: ${name}`)
    return dependencies[name]
  })
  const revision = () => storage.storageStatus()[0]?.revision ?? 0
  libraryService.list()

  // Local import: the production call pattern of each revision.
  const incoming = Array.from({ length: imports }, (_, i) => beat(`import-${i}`))
  let start = performance.now(), before = revision()
  if (typeof libraryService.addMany === 'function') {
    for (let i = 0; i < incoming.length; i += 250) libraryService.addMany(incoming.slice(i, i + 250))
  } else for (const record of incoming) libraryService.add(record)
  const importMs = performance.now() - start, importCommits = revision() - before

  // Batch analysis status traffic: queued for all, then analyzing + result per beat.
  const ids = libraryService.list().slice(0, analyzed).map(record => record.id)
  start = performance.now(); before = revision()
  libraryService.setAnalysisStatuses(ids, 'queued')
  for (const id of ids) {
    libraryService.setAnalysisStatus(id, 'analyzing')
    libraryService.update(id, { analysisStatus: 'estimated', analysis: { ...beat(id).analysis, analyzedAt: Date.now() } })
  }
  const analysisMs = performance.now() - start, analysisCommits = revision() - before
  const bytes = (await fsp.stat(libraryFile)).size
  const reread = JSON.parse(await fsp.readFile(libraryFile, 'utf8'))
  assert.equal(reread.length, existing + imports)
  await libraryService.shutdown()
  await fsp.rm(profile, { recursive: true, force: true })
  return { ref: ref ?? 'working-tree', existing, imports, importMs: Math.round(importMs), importCommits,
    analyzed, analysisMs: Math.round(analysisMs), analysisCommits, analysisMsPerBeat: +(analysisMs / analyzed).toFixed(1), libraryBytes: bytes }
}

console.log(JSON.stringify(await scenario()))
