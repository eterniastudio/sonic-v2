import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// Executes the checked-in modules with dependency doubles; unexpected imports fail.
function load(relativePath, dependencies = {}) {
  const url = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  const module = { exports: {} }
  const factory = new Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`, { filename: url.pathname }).runInThisContext()
  factory((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

const shared = load('../src/shared/analysis.ts')

function cacheWith(entries) {
  const store = { value: entries }
  class JsonStore {
    constructor(_file, _fallback, normalize) { this.normalize = normalize }
    read() { return this.normalize(store.value) }
    write(value) { store.value = value }
  }
  const { analysisCache } = load('../src/main/analysis/cache.ts', {
    '@shared/analysis': shared,
    '../lib/jsonStore': { JsonStore },
    '../services/paths': { analysisCacheFile: () => '/isolated/analysis-cache.json' }
  })
  return { cache: analysisCache, store }
}

const record = (patch = {}) => ({ engine: shared.ANALYSIS_ENGINE, pipeline: shared.ANALYSIS_PIPELINE, analyzedAt: 1, ...patch })

test('the analysis cache key includes the window-plan/merge pipeline version', () => {
  const current = record()
  const { cache } = cacheWith([
    { inputId: 'old-engine', engine: 'sonic-dsp/3', analysis: record({ engine: 'sonic-dsp/3' }) },
    { inputId: 'no-pipeline', engine: shared.ANALYSIS_ENGINE, analysis: record({ pipeline: undefined }) },
    { inputId: 'old-pipeline', engine: shared.ANALYSIS_ENGINE, pipeline: 'windows/0+merge/0', analysis: record({ pipeline: 'windows/0+merge/0' }) },
    { inputId: 'current', engine: shared.ANALYSIS_ENGINE, pipeline: shared.ANALYSIS_PIPELINE, analysis: current }
  ])
  assert.equal(cache.get('old-engine'), null)
  assert.equal(cache.get('no-pipeline'), null)
  assert.equal(cache.get('old-pipeline'), null)
  assert.equal(cache.get('current'), current)
})

test('storing a result replaces every older-version entry for the same bytes', () => {
  const { cache, store } = cacheWith([
    { inputId: 'a', engine: 'sonic-dsp/3', analysis: record({ engine: 'sonic-dsp/3' }) },
    { inputId: 'a', engine: shared.ANALYSIS_ENGINE, pipeline: 'windows/0+merge/0', analysis: record() },
    { inputId: 'b', engine: 'sonic-dsp/3', analysis: record({ engine: 'sonic-dsp/3' }) }
  ])
  const fresh = record({ analyzedAt: 2 })
  cache.set('a', fresh)
  assert.deepEqual(store.value.filter((entry) => entry.inputId === 'a'), [{ inputId: 'a', engine: shared.ANALYSIS_ENGINE, pipeline: shared.ANALYSIS_PIPELINE, analysis: fresh }])
  assert.equal(store.value.filter((entry) => entry.inputId === 'b').length, 1)
  assert.equal(cache.get('a'), fresh)
})

test('library refresh treats an older engine or pipeline as stale', () => {
  const beat = { missing: false, analysisStatus: 'estimated', analysis: { engine: shared.ANALYSIS_ENGINE, pipeline: shared.ANALYSIS_PIPELINE } }
  assert.equal(shared.ANALYSIS_ENGINE, 'sonic-dsp/5')
  assert.equal(shared.needsAnalysisRefresh(beat), false)
  assert.equal(shared.needsAnalysisRefresh({ ...beat, analysis: { engine: 'sonic-dsp/3' } }), true)
  // sonic-dsp/4 results (pre-October 24 tempo/key decisions) must reanalyse.
  assert.equal(shared.needsAnalysisRefresh({ ...beat, analysis: { engine: 'sonic-dsp/4', pipeline: shared.ANALYSIS_PIPELINE } }), true)
  assert.equal(shared.needsAnalysisRefresh({ ...beat, analysis: { engine: shared.ANALYSIS_ENGINE, pipeline: 'windows/0+merge/0' } }), true)
})

test('assembled analyses record the pipeline version', () => {
  const merge = load('../src/main/analysis/merge.ts', { '@shared/analysis': shared })
  const assembled = merge.assembleAnalysis({
    tempo: shared.emptyTempoAnalysis(), key: shared.emptyKeyAnalysis(), inputId: 'x', inputName: 'x.wav',
    analyzedAt: 1, sampleRate: 22050, channels: 1, durationSec: 30, analyzedSeconds: 30, windowDescription: ''
  })
  assert.equal(assembled.engine, shared.ANALYSIS_ENGINE)
  assert.equal(assembled.pipeline, shared.ANALYSIS_PIPELINE)
})
