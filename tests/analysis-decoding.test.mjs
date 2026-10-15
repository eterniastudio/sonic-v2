import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
function load(relativePath, dependencies) {
  const source = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  const module = { exports: {} }
  const factory = new Script(`(function(require,module,exports,__dirname){\n${compiled.outputText}\n})`, { filename: source.pathname }).runInThisContext()
  factory(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports, '/isolated/analysis')
  return module.exports
}
const decoding = load('../src/main/analysis/decode.ts', {
  'node:fs/promises': require('node:fs/promises'), 'node:path': path,
  '../lib/child': { run: () => assert.fail('Unexpected decoder launch') },
  '../lib/fsx': { ensureDir: () => {}, removeFile: () => {} }
})
const shared = load('../src/shared/analysis.ts', {})

function serviceFixture(t, options = {}) {
  const decodes = [], removed = [], jobs = [], assembled = []
  const { analysisService: service } = load('../src/main/analysis/service.ts', {
    'node:events': { EventEmitter }, '../lifecycle': { isStopping: () => false },
    'node:crypto': { createHash }, 'node:path': path,
    'node:fs': { createReadStream() {
      const stream = new EventEmitter()
      stream.destroy = error => queueMicrotask(() => stream.emit('error', error))
      queueMicrotask(() => { stream.emit('data', Buffer.from('audio')); stream.emit('end') })
      return stream
    } },
    'node:worker_threads': { Worker: class extends EventEmitter {
      constructor(_path, { workerData }) {
        super(); jobs.push(workerData)
        queueMicrotask(() => this.emit('message', { ok: true, tempo: shared.emptyTempoAnalysis(), key: shared.emptyKeyAnalysis() }))
      }
      async terminate() {}
    } },
    '@shared/analysis': shared,
    '../lib/fsx': { ensureDir: async () => {}, removeFile: async target => { removed.push(target) } },
    '../services/paths': { analysisDir: () => '/isolated/analysis' },
    '../services/engine': { engineService: { resolve: async () => ({ path: '/isolated/ffmpeg' }) } },
    '../services/settings': { settingsService: { get: () => ({ analysisConcurrency: 1 }) } },
    './cache': { analysisCache: { get: () => null, set: () => {} } },
    './decode': { planWindows: decoding.planWindows, async decodeWindow(window) {
      decodes.push(window)
      if (options.failTempo && decodes.length === 1) throw new Error('Injected tempo decode failure')
      if (options.abort) { service.cancel('request'); throw new Error('Cancelled') }
      const durationSec = Math.min(Number(window.durationSec.toFixed(3)), Math.max(0, (options.availableSec ?? Infinity) + 8 - window.offsetSec))
      return { path: window.outputPath, sampleRate: 22050, sampleCount: Math.round(durationSec * 22050), durationSec }
    } },
    '../services/ffprobe': { probeMediaFile: async () => ({ durationSec: 0 }) },
    './merge': { assembleAnalysis: input => { assembled.push(input); return input } }
  })
  t.after(() => service.shutdown())
  return { service, decodes, removed, jobs, assembled }
}

test('a 133-second track decodes once, shares exact key samples, and reports unique coverage', async t => {
  const f = serviceFixture(t)
  const result = await f.service.analyze({ requestId: 'request', inputPath: '/input.wav', durationSec: 133 })
  assert.equal(result.ok, true)
  assert.equal(f.decodes.length, 1)
  assert.equal(f.decodes[0].durationSec, 125)
  assert.equal(f.jobs[0].key[0].path, f.jobs[0].tempo.path)
  assert.equal(f.jobs[0].key[0].sampleOffset, 0)
  assert.equal(f.jobs[0].key[0].sampleCount, 90 * 22050)
  assert.equal(f.assembled[0].analyzedSeconds, 125)
  assert.equal(f.removed.length, 1)
})

test('long tracks retain an independent late key window and union overlapping coverage', async t => {
  const f = serviceFixture(t)
  await f.service.analyze({ requestId: 'request', inputPath: '/input.wav', durationSec: 200 })
  assert.equal(f.decodes.length, 2)
  assert.equal(f.jobs[0].key.length, 2)
  assert.notEqual(f.jobs[0].key[1].path, f.jobs[0].tempo.path)
  assert.equal(f.assembled[0].analyzedSeconds, 192)
  assert.equal(f.removed.length, 2)
})

test('shared short-track key slices retain FFmpeg millisecond rounding at duration boundaries', async t => {
  const f = serviceFixture(t)
  await f.service.analyze({ requestId: 'request', inputPath: '/input.wav', durationSec: 10.0009 })
  assert.equal(f.decodes.length, 1)
  assert.equal(f.jobs[0].key[0].sampleCount, Math.round(8.001 * 22050))
  assert.equal(f.jobs[0].key[0].sampleCount, f.jobs[0].tempo.sampleCount)
})

test('tempo decode failure still runs key independently and cleans both scratch paths', async t => {
  const f = serviceFixture(t, { failTempo: true })
  const result = await f.service.analyze({ requestId: 'request', inputPath: '/input.wav', durationSec: 133 })
  assert.equal(result.ok, true)
  assert.equal(f.decodes.length, 2)
  assert.equal(f.jobs[0].tempo, null)
  assert.equal(f.jobs[0].key.length, 1)
  assert.equal(f.assembled[0].analyzedSeconds, 90)
  assert.equal(f.removed.length, 2)
})

test('EOF clips a shared window to actual decoded samples and cancellation starts no worker', async t => {
  const short = serviceFixture(t, { availableSec: 7 })
  await short.service.analyze({ requestId: 'request', inputPath: '/input.wav', durationSec: 0 })
  assert.equal(short.jobs[0].key[0].sampleCount, 7 * 22050)
  assert.equal(short.assembled[0].analyzedSeconds, 7)
  const cancelled = serviceFixture(t, { abort: true })
  const result = await cancelled.service.analyze({ requestId: 'request', inputPath: '/input.wav', durationSec: 133 })
  assert.equal(result.cancelled, true)
  assert.equal(cancelled.jobs.length, 0)
  assert.equal(cancelled.decodes.length, 1)
  assert.equal(cancelled.removed.length, 1)
})

test('PCM reader preserves little-endian samples and rejects truncated bytes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sonic-pcm-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'audio.f32')
  const samples = [-1, 0, 0.25, 0.5, 1]
  const buffer = Buffer.alloc(samples.length * 4)
  samples.forEach((value, index) => buffer.writeFloatLE(value, index * 4))
  await writeFile(target, buffer)
  assert.deepEqual(Array.from(await decoding.readPcmFile(target)), samples)
  await writeFile(target, buffer.subarray(0, buffer.length - 1))
  await assert.rejects(decoding.readPcmFile(target), /truncated sample/)
})

test('worker reads shared PCM once and applies sample slices without copying', async () => {
  const samples = Float32Array.from([0, 1, 2, 3, 4, 5])
  const reads = [], inputs = []
  let finish
  const completed = new Promise(resolve => { finish = resolve })
  const window = { path: '/shared.f32', sampleRate: 22050, sourceDurationSec: 10 }
  load('../src/main/analysis/worker.ts', {
    'node:worker_threads': { parentPort: { postMessage: finish }, workerData: { tempo: window, key: [{ ...window, sampleOffset: 2, sampleCount: 3 }] } },
    '@shared/analysis': shared,
    './decode': { readPcmFile: async target => { reads.push(target); return samples } },
    './dsp': {
      estimateTempo: input => { inputs.push(input.pcm); return shared.emptyTempoAnalysis() },
      estimateKey: input => { inputs.push(input.pcm); return shared.emptyKeyAnalysis() }
    },
    './merge': { mergeKeyAnalyses: results => results[0] }
  })
  assert.equal((await completed).ok, true)
  assert.deepEqual(reads, ['/shared.f32'])
  assert.deepEqual(Array.from(inputs[1]), [2, 3, 4])
  assert.equal(inputs[0].buffer, inputs[1].buffer)
})

test('batch refresh offers old engines and failed work without repeating current or active results', () => {
  const beat = { missing: false, analysisStatus: 'estimated', analysis: { engine: shared.ANALYSIS_ENGINE } }
  assert.equal(shared.needsAnalysisRefresh(beat), false)
  assert.equal(shared.needsAnalysisRefresh({ ...beat, analysis: { engine: 'sonic-dsp/previous' } }), true)
  assert.equal(shared.needsAnalysisRefresh({ ...beat, analysis: null }), true)
  for (const analysisStatus of ['failed', 'cancelled']) assert.equal(shared.needsAnalysisRefresh({ ...beat, analysisStatus }), true)
  for (const analysisStatus of ['queued', 'analyzing']) assert.equal(shared.needsAnalysisRefresh({ ...beat, analysisStatus, analysis: null }), false)
  for (const analysisStatus of ['inconclusive', 'partial']) assert.equal(shared.needsAnalysisRefresh({ ...beat, analysisStatus }), false)
  assert.equal(shared.needsAnalysisRefresh({ ...beat, missing: true, analysis: null }), false)
  assert.equal(shared.needsAnalysisRefresh({ ...beat, fileAccessError: 'Access denied', analysis: null }), false)
})
