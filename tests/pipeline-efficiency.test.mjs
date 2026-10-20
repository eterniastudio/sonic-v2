import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// Run the checked-in services with isolated process/storage doubles. No user
// profile, audio file, media executable or network request is accessed.
function load(relativePath, dependencies) {
  const source = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  const module = { exports: {} }
  const factory = new Script(`(function(require,module,exports){\n${compiled.outputText}\n})`, { filename: source.pathname }).runInThisContext()
  factory(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected real dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const sourceUrls = load('../src/shared/url.ts', {})

async function until(predicate) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return
    await nextTurn()
  }
  assert.fail('Controlled work did not reach the expected phase')
}

function analysisFixture(t, overrides = {}) {
  const reads = [], resolutions = [], probes = []
  const cached = { inputId: createHash('sha256').update('fixture-bytes').digest('hex'), engine: 'test-engine' }
  const { analysisService: service } = load('../src/main/analysis/service.ts', {
    'node:events': { EventEmitter },
    '../lifecycle': { isStopping: () => false },
    'node:crypto': { createHash },
    'node:fs': { createReadStream(filePath) {
      reads.push(filePath)
      const stream = new EventEmitter()
      stream.destroy = error => queueMicrotask(() => stream.emit('error', error))
      queueMicrotask(() => { stream.emit('data', Buffer.from('fixture-bytes')); stream.emit('end') })
      return stream
    } },
    'node:path': path,
    'node:worker_threads': { Worker: class { constructor() { assert.fail('Unexpected real DSP work') } } },
    '@shared/analysis': { ANALYSIS_ENGINE: 'test-engine' },
    '../lib/fsx': { ensureDir: async () => {}, removeFile: async () => {} },
    '../services/paths': { analysisDir: () => '/isolated/analysis' },
    '../services/engine': { engineService: { async resolve(...args) {
      resolutions.push(args)
      return overrides.resolve ? overrides.resolve(...args) : { path: null }
    } } },
    '../services/settings': { settingsService: { get: () => ({ analysisConcurrency: 1 }) } },
    './cache': { analysisCache: { get: id => overrides.cacheMiss ? null : (assert.equal(id, cached.inputId), cached) } },
    './decode': { decodeWindow: async () => { assert.fail('Unexpected decode') }, planWindows: () => { assert.fail('Unexpected window planning') } },
    '../services/ffprobe': { async probeMediaFile(...args) { probes.push(args); return { durationSec: 12 } } },
    './merge': { assembleAnalysis: () => { assert.fail('Unexpected acoustic merge') } }
  })
  t.after(() => service.shutdown())
  return { service, reads, resolutions, probes, cached }
}

test('cached analysis with unknown duration uses no media-tool resolution or metadata subprocess', async t => {
  const f = analysisFixture(t)
  const result = await f.service.analyze({ requestId: 'cached', inputPath: '/isolated/input.wav', durationSec: 0 })
  assert.equal(result.ok, true)
  assert.equal(result.fromCache, true)
  assert.equal(result.analysis, f.cached)
  assert.equal(f.reads.length, 1)
  assert.equal(f.resolutions.length, 0)
  assert.equal(f.probes.length, 0)
  assert.equal(f.service.active, 0)
})

test('analysis preparation is bounded before disk reads and queued cancellation consumes no IO', async t => {
  const resolving = deferred()
  const f = analysisFixture(t, { cacheMiss: true, resolve: () => resolving.promise })
  const first = f.service.analyze({ requestId: 'first', inputPath: '/isolated/first.wav', durationSec: 12 })
  await until(() => f.resolutions.length === 1)
  const second = f.service.analyze({ requestId: 'second', inputPath: '/isolated/second.wav', durationSec: 12 })
  await until(() => f.service.waiting.length === 1)
  assert.deepEqual(f.reads, ['/isolated/first.wav'])
  f.service.cancel('second')
  assert.equal((await second).cancelled, true)
  assert.equal(f.service.waiting.length, 0)
  assert.equal(f.resolutions.length, 1)
  resolving.resolve({ path: null })
  assert.match((await first).error, /ffmpeg is not installed/)
  assert.equal(f.service.active, 0)
})

test('analysis deadline includes capacity waiting and force bypasses cache', async t => {
  const f = analysisFixture(t)
  f.service.active = 1
  const result = await f.service.analyze({ requestId: 'deadline', inputPath: '/isolated/input.wav', durationSec: 0, timeoutMs: 10 })
  assert.match(result.error, /timed out after 10 ms/)
  assert.equal(f.reads.length, 0)
  assert.equal(f.service.waiting.length, 0)
  f.service.active = 0
  const forced = await f.service.analyze({ requestId: 'forced', inputPath: '/isolated/input.wav', durationSec: 12, force: true })
  assert.match(forced.error, /ffmpeg is not installed/)
  assert.equal(forced.fromCache, false)
  assert.equal(f.resolutions.length, 1)
})

function draft() {
  return { final: {}, declared: {}, embedded: {}, analyzed: {}, evidence: [], audioEvidence: [], overrides: [], conflicts: [], analysis: null }
}

function job(id, stage = 'ready') {
  return { id, stage, error: null, url: `https://www.youtube.com/watch?v=${id}`, sourceTitle: id, metadata: draft(), durationSec: 12, revision: 0, presetId: 'mp3-320' }
}

function queueFixture(t, jobs = [job('a')], overrides = {}) {
  const downloads = [], metadataReads = [], outputReads = [], publications = [], probes = [], cancelledAnalyses = []
  const analyzer = Object.assign(new EventEmitter(), {
    analyze: request => overrides.analyze?.(request) ?? Promise.resolve({ ok: false }),
    cancel: id => { cancelledAnalyses.push(id); overrides.cancelAnalysis?.(id) },
    cancelPrefix: () => {}
  })
  const settings = { analyzeOnDownload: false, embedThumbnail: false, autoStart: false, skipExisting: false, rescanIntervalMs: 0, channelMode: 'source', normalizeLufs: null, ...overrides.settings }
  const { queueService: service } = load('../src/main/services/queue.ts', {
    'node:events': { EventEmitter }, '../lifecycle': { isStopping: () => false }, 'node:path': path,
    '@shared/metadata': {
      createDraft: input => ({ ...draft(), ...input }), emptyMetadata: () => ({}),
      withEmbedded: (value, embedded) => ({ ...value, embedded }), withAnalyzed: value => value,
      buildAudioEvidence: () => [], parseDeclared: () => ({ values: {}, evidence: [], bySource: {} })
    },
    '@shared/analysis': { analyzedValuesFrom: () => ({}) }, '../analysis/service': { analysisService: analyzer },
    '@shared/url': sourceUrls,
    '../lib/jsonStore': { JsonStore: class { read() { return { version: 1, paused: false, concurrency: 2, jobs } } write() {} }, storageEvents: { on() {} } },
    '../lib/id': { createId: () => 'new-job' }, '../lib/fsx': { sha256File: async () => 'fingerprint' },
    './acquire': {
      async acquireAudio(id, url, options) {
        downloads.push({ id, url, signal: options.signal })
        return overrides.acquire ? overrides.acquire(id, options.signal) : { filePath: '/isolated/input.wav', extension: 'wav' }
      }, cleanStaging: async () => {}, sweepStaging: async () => {}
    },
    './cover': { fetchCover: async () => null },
    './engine': { engineService: { resolve: async () => ({ version: 'test' }) } },
    './ffprobe': {
      async readEmbeddedMetadata(filePath, signal) {
        metadataReads.push(signal)
        return overrides.readMetadata ? overrides.readMetadata(signal) : {}
      },
      async probeMediaFile(filePath, signal) {
        outputReads.push(signal)
        return overrides.readOutput ? overrides.readOutput(signal) : { tags: {}, durationSec: 12, sizeBytes: 20, container: 'mp3', audio: null }
      }, tagsToMetadata: () => ({})
    },
    './library': { libraryService: { scheduleRescan() {}, on() {}, assertWritable() {}, pendingRevision: () => null, get: () => null, list: () => overrides.library ?? [] } },
    './paths': { queueFile: () => '/isolated/queue.json', stagingDir: () => '/isolated/staging' },
    './probe': { async probeUrl(url, signal) {
      probes.push({ url, signal })
      return overrides.probe ? overrides.probe(signal) : { title: 'Source', error: null, durationSec: 12 }
    } },
    './publish': { buildTagContext: () => ({}), PendingPublicationError: class extends Error {}, async publishExport(options) { publications.push(options); return { filePath: '/isolated/out.mp3', beat: { id: 'saved' }, fileName: 'out.mp3' } } },
    './settings': { settingsService: { get: () => settings } },
    './transcode': { sourceExtensionFor: () => 'mp3', transcode: async () => {} }
  })
  service.init()
  t.after(() => service.stopAll())
  return { service, downloads, metadataReads, outputReads, publications, probes, cancelledAnalyses }
}

test('repeated Start while a job is downloading retains one worker and the original cancel controller', async t => {
  const f = queueFixture(t, [job('a')], { acquire: (id, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })) })
  f.service.start(['a'])
  assert.equal(f.downloads.length, 1)
  const firstController = f.service.controllers.get('a')
  f.service.start(['a'])
  f.service.start(['a'])
  assert.equal(f.downloads.length, 1)
  assert.equal(f.service.controllers.get('a'), firstController)
  await f.service.cancel('a')
  assert.equal(f.downloads[0].signal.aborted, true)
  assert.equal(f.service.getJob('a').stage, 'cancelled')
  assert.equal(f.service.controllers.size, 0)
})

test('SoundCloud share intake retains canonical source, metadata and artwork through publication', async t => {
  const url = 'https://soundcloud.com/producer/beat'
  const thumbnail = 'https://i1.sndcdn.com/test.jpg'
  const f = queueFixture(t, [], { probe: async () => ({ url, videoId: '12345', title: 'Beat', uploader: 'Producer', thumbnail, durationSec: 12, error: null }) })
  f.service.add(['https://on.soundcloud.com/AbCd'])
  await until(() => f.service.getJob('new-job')?.stage === 'ready')
  const queued = f.service.getJob('new-job')
  assert.equal(queued.sourceKind, 'soundcloud')
  assert.equal(queued.url, url)
  assert.equal(queued.videoId, '12345')
  f.service.start(['new-job'])
  await until(() => f.service.getJob('new-job').stage === 'complete')
  assert.equal(f.downloads[0].url, url)
  assert.equal(f.publications[0].sourceKind, 'soundcloud')
  assert.equal(f.publications[0].sourceUrl, url)
  assert.equal(f.publications[0].thumbnail, thumbnail)
  assert.equal(f.publications[0].uploader, 'Producer')
})

test('existing-source checks match exact SoundCloud tracks, never ID substrings from other providers', async t => {
  const url = 'https://soundcloud.com/producer/beat'
  const source = { ...job('sc'), url, videoId: '12345', sourceKind: 'soundcloud' }
  const f = queueFixture(t, [source], { settings: { skipExisting: true }, library: [
    { id: 'wrong', sourceKind: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=12345abcdef', filePath: '/wrong.mp3' },
    { id: 'correct', sourceKind: 'soundcloud', sourceUrl: `${url}?utm_source=copy`, filePath: '/correct.mp3' }
  ] })
  f.service.start(['sc'])
  await until(() => f.service.getJob('sc').stage === 'complete')
  assert.equal(f.service.getJob('sc').libraryId, 'correct')
  assert.equal(f.downloads.length, 0)
})

test('Start leaves probing and completed jobs intact and retains explicit start intent without a source title', async t => {
  const pending = deferred()
  const f = queueFixture(t, [job('a', 'probing'), job('b', 'complete'), { ...job('c', 'failed'), sourceTitle: null }], {
    probe: signal => new Promise(resolve => { signal.addEventListener('abort', () => resolve({ error: 'Cancelled' }), { once: true }); pending.promise.then(resolve) })
  })
  f.service.start(['a', 'b', 'c'])
  assert.equal(f.service.getJob('a').stage, 'probing')
  assert.equal(f.service.getJob('b').stage, 'complete')
  assert.equal(f.service.getJob('c').stage, 'downloading')
  assert.equal(f.downloads.length, 1)
  assert.equal(f.probes.length, 1)
  pending.resolve({ title: 'Source', durationSec: 12, error: null })
  await until(() => f.service.getJob('c').stage === 'complete')
  assert.equal(f.service.getJob('a').stage, 'ready')
})

test('cancel during embedded metadata reading aborts that read and never starts conversion or publication', async t => {
  const f = queueFixture(t, [job('a')], { readMetadata: signal => new Promise((resolve, reject) => {
    assert.ok(signal instanceof AbortSignal)
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
  }) })
  f.service.start(['a'])
  await until(() => f.metadataReads.length === 1)
  await f.service.cancel('a')
  assert.equal(f.metadataReads[0].aborted, true)
  assert.equal(f.outputReads.length, 0)
  assert.equal(f.publications.length, 0)
  assert.equal(f.service.getJob('a').stage, 'cancelled')
})

test('cancel during tag readback aborts its subprocess and prevents publication', async t => {
  const f = queueFixture(t, [job('a')], { readOutput: signal => new Promise((resolve, reject) => {
    assert.ok(signal instanceof AbortSignal)
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
  }) })
  f.service.start(['a'])
  await until(() => f.outputReads.length === 1)
  await f.service.cancel('a')
  assert.equal(f.outputReads[0].aborted, true)
  assert.equal(f.publications.length, 0)
})

test('queue shutdown directly cancels its active acoustic analysis and waits for it', async t => {
  const acoustic = deferred()
  const f = queueFixture(t, [job('a')], {
    settings: { analyzeOnDownload: true }, analyze: () => acoustic.promise,
    cancelAnalysis: () => acoustic.resolve({ ok: false, cancelled: true })
  })
  f.service.start(['a'])
  await until(() => f.service.getJob('a').stage === 'analyzing')
  await f.service.stopAll()
  assert.deepEqual(f.cancelledAnalyses, ['job:a:0'])
  assert.equal(f.publications.length, 0)
  assert.equal(f.service.controllers.size, 0)
})

test('uncancelled queue processing still publishes one completed result', async t => {
  const f = queueFixture(t)
  f.service.start(['a'])
  await until(() => f.service.getJob('a').stage === 'complete')
  assert.equal(f.publications.length, 1)
  assert.ok(f.metadataReads[0] instanceof AbortSignal)
  assert.equal(f.metadataReads[0], f.outputReads[0])
})

test('embedded metadata convenience reader forwards cancellation and reports actual timeouts', async () => {
  const controller = new AbortController()
  const resolutions = [], runs = []
  let timedOut = false
  const service = load('../src/main/services/ffprobe.ts', {
    '@shared/metadata': { parseText: () => ({ values: {} }) },
    './engine': { engineService: { async resolve(...args) { resolutions.push(args); return { path: '/isolated/ffprobe' } } } },
    '../lib/child': { async run(command, args, options) {
      runs.push(options)
      return timedOut ? { code: null, timedOut: true, stderr: '' } : { code: 0, stdout: '{"format":{"tags":{"title":"Fixture"}}}' }
    } }
  })
  assert.deepEqual(await service.readEmbeddedMetadata('/isolated/input.wav', controller.signal), { title: 'Fixture' })
  assert.equal(resolutions[0][2], controller.signal)
  assert.equal(runs[0].signal, controller.signal)
  timedOut = true
  await assert.rejects(service.probeMediaFile('/isolated/input.wav'), /Reading audio metadata timed out/)
})

for (const target of ['acquire', 'transcode', 'probe']) {
  test(`${target} cancellation covers media-tool resolution and prevents process launch`, async () => {
    const controller = new AbortController()
    const resolutions = []
    const engineService = { async resolve(name, force, signal) {
      resolutions.push({ name, signal })
      controller.abort()
      return { path: '/isolated/tool' }
    } }
    const common = { './engine': { engineService }, '../lib/child': { run: () => assert.fail('Cancelled request launched a process') } }
    let result
    if (target === 'acquire') {
      const service = load('../src/main/services/acquire.ts', {
        ...common, 'node:fs/promises': {}, 'node:path': path, '../lib/fsx': {},
        './probe': {}, './paths': {}, './settings': {}, '@shared/url': sourceUrls
      })
      result = service.acquireAudio('a', 'https://soundcloud.com/artist/track', { signal: controller.signal, onProgress() {} })
    } else if (target === 'transcode') {
      const service = load('../src/main/services/transcode.ts', {
        ...common, 'node:path': path, '@shared/presets': {}, '../lib/fsx': {}
      })
      result = service.transcode({ signal: controller.signal })
    } else {
      const service = load('../src/main/services/probe.ts', {
        ...common, '@shared/url': { parseVideoUrl: () => ({ ok: true, normalized: 'https://example.invalid', videoId: 'a' }) }, './settings': {}
      })
      result = service.probeUrl('https://example.invalid', controller.signal)
    }
    if (target === 'probe') assert.equal((await result).error, 'Cancelled')
    else await assert.rejects(result, /abort/i)
    assert.equal(resolutions.length, 1)
    assert.equal(resolutions[0].signal, controller.signal)
  })
}

test('URL probe preserves its cancelled outcome during shared ffmpeg resolution', async () => {
  const controller = new AbortController()
  const resolutions = []
  const service = load('../src/main/services/probe.ts', {
    '@shared/url': { parseVideoUrl: () => ({ ok: true, normalized: 'https://example.invalid', videoId: 'a' }) },
    './settings': { settingsService: { get: () => ({ cookiesFromBrowser: 'none' }) } },
    './engine': { engineService: { async resolve(name, force, signal) {
      resolutions.push({ name, signal })
      if (name === 'ffmpeg') controller.abort()
      return { path: '/isolated/tool' }
    } } },
    '../lib/child': { run: () => assert.fail('Cancelled URL probe launched a process') }
  })
  assert.equal((await service.probeUrl('https://example.invalid', controller.signal)).error, 'Cancelled')
  assert.deepEqual(resolutions.map(value => value.name), ['yt-dlp', 'ffmpeg'])
  assert.ok(resolutions.every(value => value.signal === controller.signal))
})

test('queue shutdown during probe ffmpeg resolution leaves the interrupted job ready for retry', async t => {
  let resolvingFfmpeg = false
  const probeService = load('../src/main/services/probe.ts', {
    '@shared/url': { parseVideoUrl: () => ({ ok: true, normalized: 'https://example.invalid', videoId: 'a' }) },
    './settings': { settingsService: { get: () => ({ cookiesFromBrowser: 'none' }) } },
    './engine': { engineService: { async resolve(name, force, signal) {
      if (name === 'ffmpeg') {
        resolvingFfmpeg = true
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      }
      return { path: '/isolated/tool' }
    } } },
    '../lib/child': { run: () => assert.fail('Shutdown URL probe launched a process') }
  })
  const f = queueFixture(t, [job('a', 'probing')], { probe: signal => probeService.probeUrl('https://example.invalid', signal) })
  await until(() => resolvingFfmpeg)
  await f.service.stopAll()
  assert.equal(f.service.getJob('a').stage, 'ready')
  assert.equal(f.service.getJob('a').error, null)
  assert.equal(f.downloads.length, 0)
})

test('genuine probe exceptions still leave a failed job with diagnostic evidence', async t => {
  const f = queueFixture(t, [job('a', 'probing')], { probe: async () => { throw new Error('provider failure') } })
  await until(() => f.service.getJob('a').stage === 'failed')
  assert.match(f.service.getJob('a').error, /provider failure/)
})

for (const phase of ['source', 'readback']) {
  test(`re-export shutdown aborts its ${phase} metadata probe without publishing`, async () => {
    const signals = []
    let waiting = false
    const service = load('../src/main/services/reexport.ts', {
      'node:path': path,
      'node:fs/promises': { mkdtemp: async () => '/isolated/reexport', rmdir: async () => {} },
      '@shared/presets': { getPreset: () => ({ extension: 'flac' }) },
      '@shared/metadata': { buildAudioEvidence: () => [] },
      '../lib/fsx': { ensureDir: async () => {}, fileExists: async () => true, removeFile: async () => {}, sha256File: async () => 'saved' },
      './ffprobe': { async probeMediaFile(filePath, signal) {
        assert.ok(signal instanceof AbortSignal)
        signals.push(signal)
        if (phase === 'source' || signals.length === 2) {
          waiting = true
          await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }))
        }
        return { durationSec: 12 }
      }, tagsToMetadata: () => ({}) },
      './library': { libraryService: { pendingRevision: () => null, get: () => ({ id: 'a', filePath: '/isolated/source.wav', fingerprint: 'saved' }) } },
      './paths': { stagingDir: () => '/isolated/staging', libraryFile: () => '/isolated/library.json' },
      './publish': { buildTagContext: () => ({}), PendingPublicationError: class extends Error {}, publishExport: () => assert.fail('Cancelled re-export published output') },
      './settings': { settingsService: { get: () => ({}) } },
      './transcode': { transcode: async options => assert.equal(options.signal, signals[0]) },
      './engine': { engineService: { resolve: () => assert.fail('Cancelled re-export resolved publication versions') } },
      '../lifecycle': { isStopping: () => false },
      '../lib/jsonStore': { storageDiagnostic: () => assert.fail('Unexpected staging cleanup failure') }
    })
    const task = service.reexportBeat('a', 'flac')
    await until(() => waiting)
    await service.stopReexports()
    assert.equal((await task).ok, false)
    assert.match((await task).error, /Cancelled/)
    assert.ok(signals.every(signal => signal.aborted))
    assert.equal(signals.length, phase === 'source' ? 1 : 2)
  })
}
