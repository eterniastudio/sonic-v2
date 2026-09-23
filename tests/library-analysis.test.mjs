import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// Execute the checked-in coordinator, not a copied implementation. Dependency
// doubles keep these contract tests away from Electron, user data and media tools.
// Unexpected imports fail closed rather than loading a real service singleton.
function loadSource(relativePath, dependencies = {}) {
  const url = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(readFileSync(url, 'utf8'), {
    fileName: url.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true
  })
  const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? []
  assert.equal(errors.length, 0, errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  const module = { exports: {} }
  const factory = new Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`, {
    filename: url.pathname
  }).runInThisContext()
  factory(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected real dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

const shared = loadSource('../src/shared/analysis.ts')

function analysis(tempoStatus = 'estimated', keyStatus = 'estimated') {
  return {
    engine: shared.ANALYSIS_ENGINE, inputId: 'test-fingerprint', inputName: 'fixture.wav',
    analyzedAt: 1, analyzedSeconds: 12, sampleRate: 22050, channels: 1, durationSec: 12,
    tempo: { ...shared.emptyTempoAnalysis(), status: tempoStatus, bpm: 120, bpmExact: 120 },
    key: { ...shared.emptyKeyAnalysis(), status: keyStatus, key: 'C major', camelot: '8B' },
    warnings: []
  }
}

function beat(id, patch = {}) {
  return {
    id, title: id, filePath: `/never-read/${id}.wav`, durationSec: 12, channels: 1,
    missing: false, analysis: null, analysisStatus: 'not-analyzed', overrides: [], ...patch
  }
}

function success(value = analysis()) {
  return { ok: true, analysis: value, fromCache: false, cancelled: false, error: null, elapsedMs: 1 }
}

function cancelled() {
  return { ok: false, analysis: null, fromCache: false, cancelled: true, error: null, elapsedMs: 0 }
}

async function flush() {
  await nextTurn()
  await nextTurn()
}

function fixture(t, options = {}) {
  const records = options.records ?? new Map((options.beats ?? [beat('a'), beat('b'), beat('c')]).map(b => [b.id, b]))
  const started = []
  const pending = new Map()
  const applied = []
  const errors = []
  const prefixes = []
  let stopping = false
  let concurrency = options.concurrency ?? 1
  const service = new EventEmitter()
  const storageEvents = options.storageEvents ?? new EventEmitter()
  service.engine = shared.ANALYSIS_ENGINE
  service.analyze = request => {
    started.push(request)
    return new Promise(resolve => pending.set(request.requestId, resolve))
  }
  function settle(requestId, outcome) {
    const resolve = pending.get(requestId)
    assert.ok(resolve, `No request to settle: ${requestId}`)
    pending.delete(requestId)
    resolve(outcome)
  }
  service.cancelPrefix = prefix => {
    prefixes.push(prefix)
    if (options.ignoreCancel) return
    for (const id of [...pending.keys()]) if (id.startsWith(prefix)) settle(id, cancelled())
  }
  service.cancelAll = () => {
    for (const id of [...pending.keys()]) settle(id, cancelled())
  }
  const library = {
    get: id => records.get(id) ?? null,
    analysisStatusesSaved: () => options.analysisStatusesSaved?.() ?? true,
    setAnalysisStatuses(ids, status) {
      if (options.onBatchStatus) return options.onBatchStatus(ids, status, records)
      for (const id of ids) this.setAnalysisStatus(id, status)
    },
    restoreAnalysisStatuses(ids) {
      if (options.onRestoreStatuses) return options.onRestoreStatuses(ids, records)
      for (const id of ids) {
        const current = records.get(id)
        if (current) this.setAnalysisStatus(id, current.analysis
          ? shared.deriveAnalysisStatus(current.analysis.tempo, current.analysis.key)
          : 'not-analyzed')
      }
    },
    setAnalysisStatus(id, status) {
      const current = records.get(id)
      if (current) records.set(id, { ...current, analysisStatus: status })
    },
    markAnalysisFailed(id) { this.setAnalysisStatus(id, 'failed') },
    async applyAnalysis(id, value) {
      applied.push({ id, analysis: value })
      if (options.onApply) return options.onApply(id, value, records)
      const current = records.get(id)
      if (!current) return null
      const next = { ...current, analysis: value, analysisStatus: shared.deriveAnalysisStatus(value.tempo, value.key) }
      records.set(id, next)
      return next
    }
  }
  let cacheSize = 3
  const { libraryAnalysis: coordinator } = loadSource('../src/main/analysis/libraryAnalysis.ts', {
    'node:events': { EventEmitter },
    '../lifecycle': { isStopping: () => stopping },
    '@shared/analysis': shared,
    './service': { analysisService: service },
    './cache': { analysisCache: { size: () => cacheSize, clear: () => { cacheSize = 0 } } },
    '../lib/jsonStore': { storageEvents },
    '../services/library': { libraryService: library },
    '../services/settings': { settingsService: { get: () => ({ analysisConcurrency: concurrency, analyzeOnDownload: true }) } }
  })
  coordinator.on('storage-error', error => errors.push(error))
  t.after(async () => {
    stopping = true
    service.cancelAll()
    await coordinator.shutdown()
  })
  return {
    coordinator, records, service, started, pending, applied, errors, prefixes,
    stop: () => { stopping = true },
    setConcurrency: value => { concurrency = value },
    finish(id, outcome = success()) {
      const requestId = [...pending.keys()].find(key => key.startsWith(`beat:${id}:`))
      assert.ok(requestId, `No pending beat: ${id}`)
      settle(requestId, outcome)
    }
  }
}

const contract = (name, fn) => test(name, { timeout: 2000 }, fn)

contract('batch IDs are deduplicated before statuses and queue counts change', async t => {
  const f = fixture(t)
  assert.equal(f.coordinator.queue(['a', 'a', 'a', 'b', 'b']), 2)
  assert.equal(f.started.length, 1)
  assert.equal(f.coordinator.queuedCount, 1)
  f.finish('a'); await flush()
  f.finish('b'); await flush()
  assert.deepEqual(f.started.map(r => r.inputPath), ['/never-read/a.wav', '/never-read/b.wav'])
  assert.equal(f.coordinator.status().running, 0)
})

contract('missing and removed beats are not accepted into a new batch', t => {
  const f = fixture(t, { beats: [beat('a'), beat('missing', { missing: true })] })
  assert.equal(f.coordinator.queue(['missing', 'gone', 'a']), 1)
  assert.equal(f.records.get('missing').analysisStatus, 'not-analyzed')
  assert.equal(f.started.length, 1)
})

contract('overlapping batches do not schedule an already running or queued beat', async t => {
  const f = fixture(t)
  assert.equal(f.coordinator.queue(['a', 'b']), 2)
  assert.equal(f.coordinator.queue(['a', 'b', 'c']), 1)
  f.finish('a'); await flush()
  f.finish('b'); await flush()
  f.finish('c'); await flush()
  assert.equal(f.started.length, 3)
})

contract('queued work respects concurrency and drains in FIFO order', async t => {
  const f = fixture(t, { concurrency: 2 })
  f.coordinator.queue(['a', 'b', 'c'])
  assert.equal(f.started.length, 2)
  assert.equal(f.coordinator.status().running, 2)
  f.finish('b'); await flush()
  assert.equal(f.started[2].inputPath, '/never-read/c.wav')
  assert.equal(f.coordinator.status().running, 2)
  f.finish('a'); f.finish('c'); await flush()
  assert.equal(f.coordinator.status().running, 0)
})

contract('a beat that becomes missing while waiting does not stay queued', async t => {
  const f = fixture(t)
  f.coordinator.queue(['a', 'b', 'c'])
  f.records.set('b', { ...f.records.get('b'), missing: true })
  f.finish('a'); await flush()
  assert.equal(f.records.get('b').analysisStatus, 'not-analyzed')
  assert.equal(f.started[1].inputPath, '/never-read/c.wav')
  assert.equal(f.coordinator.queuedCount, 0)
})

contract('removal while waiting neither resurrects a beat nor stalls the next one', async t => {
  const f = fixture(t)
  f.coordinator.queue(['a', 'b', 'c'])
  f.records.delete('b')
  f.finish('a'); await flush()
  assert.equal(f.records.has('b'), false)
  assert.equal(f.started[1].inputPath, '/never-read/c.wav')
})

for (const [tempo, key, expected] of [
  ['estimated', 'estimated', 'estimated'],
  ['estimated', 'inconclusive', 'partial'],
  ['inconclusive', 'inconclusive', 'inconclusive']
]) {
  contract(`cancelling queued re-analysis restores the previous ${expected} result`, t => {
    const previous = analysis(tempo, key)
    const f = fixture(t, { beats: [beat('a'), beat('b', { analysis: previous, analysisStatus: expected })] })
    f.coordinator.queue(['a', 'b'])
    f.coordinator.cancel('b')
    assert.equal(f.records.get('b').analysisStatus, expected)
    assert.equal(f.records.get('b').analysis, previous)
    assert.equal(f.coordinator.queuedCount, 0)
  })
}

contract('cancelling active re-analysis preserves the existing analysis', async t => {
  const previous = analysis()
  const f = fixture(t, { beats: [beat('a', { analysis: previous, analysisStatus: 'estimated' })] })
  const task = f.coordinator.analyze('a', { force: true })
  f.coordinator.cancel('a')
  assert.equal((await task).ok, false)
  assert.equal(f.records.get('a').analysisStatus, 'estimated')
  assert.equal(f.records.get('a').analysis, previous)
  assert.equal(f.applied.length, 0)
})

contract('a late successful worker reply cannot apply after cancellation', async t => {
  const f = fixture(t, { ignoreCancel: true })
  const task = f.coordinator.analyze('a')
  f.coordinator.cancel('a')
  f.finish('a')
  const outcome = await task
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error, null)
  assert.equal(f.applied.length, 0)
  assert.equal(f.records.get('a').analysisStatus, 'not-analyzed')
})

contract('library cancelAll does not cancel download-job analysis', async t => {
  const f = fixture(t)
  const external = f.service.analyze({ requestId: 'job:download:1', inputPath: '/never-read/download.wav' })
  f.coordinator.queue(['a', 'b'])
  f.coordinator.cancelAll()
  await flush()
  assert.ok(f.pending.has('job:download:1'))
  assert.equal(f.coordinator.status().running, 0)
  assert.equal(f.coordinator.queuedCount, 0)
  assert.equal(f.records.get('b').analysisStatus, 'not-analyzed')
  f.service.cancelAll()
  await external
})

contract('progress is forwarded only for library requests', t => {
  const f = fixture(t)
  const events = []
  f.coordinator.on('progress', value => events.push(value))
  for (const requestId of ['job:download:1', 'unknown', 'beat::1', 'beat:a:1']) {
    f.service.emit('progress', { requestId, phase: 'analyzing', message: 'Working' })
  }
  assert.deepEqual(events, [{ beatId: 'a', jobId: null, phase: 'analyzing', message: 'Working' }])
})

contract('a rejected changed-file result leaves a retryable terminal status', async t => {
  const f = fixture(t, { onApply: () => null })
  const task = f.coordinator.analyze('a')
  f.finish('a')
  const outcome = await task
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /changed/i)
  assert.equal(f.records.get('a').analysisStatus, 'failed')
  assert.equal(f.coordinator.isRunning('a'), false)
})

contract('a beat deleted during analysis is not resurrected', async t => {
  const f = fixture(t)
  const task = f.coordinator.analyze('a')
  f.records.delete('a')
  f.finish('a')
  assert.equal((await task).ok, false)
  assert.equal(f.records.has('a'), false)
})

contract('save failures retain acoustic evidence without reporting command success', async t => {
  const value = analysis()
  const f = fixture(t, { onApply: () => { throw new Error('disk full') } })
  const task = f.coordinator.analyze('a')
  f.finish('a', success(value))
  const outcome = await task
  assert.equal(outcome.ok, false)
  assert.equal(outcome.analysis, value)
  assert.match(outcome.error, /audio analysis completed/i)
  assert.match(outcome.error, /disk full/)
  assert.equal(f.records.get('a').analysisStatus, 'failed')
})

contract('a sidecar failure does not erase an already committed analysis', async t => {
  const value = analysis()
  const f = fixture(t, { onApply: (id, result, records) => {
    records.set(id, { ...records.get(id), analysis: result, analysisStatus: 'estimated' })
    throw new Error('sidecar denied')
  } })
  const task = f.coordinator.analyze('a')
  f.finish('a', success(value))
  const outcome = await task
  assert.equal(outcome.ok, false)
  assert.equal(outcome.analysis, value)
  assert.equal(f.records.get('a').analysisStatus, 'estimated')
  assert.equal(f.records.get('a').analysis, value)
  assert.doesNotMatch(outcome.error, /not committed/)
})

contract('background save failures are surfaced and do not stall the batch', async t => {
  const f = fixture(t, { onApply: () => { throw new Error('sidecar denied') } })
  f.coordinator.queue(['a', 'b'])
  f.finish('a'); await flush()
  assert.equal(f.errors.length, 1)
  assert.match(f.errors[0], /sidecar denied/)
  assert.equal(f.started[1].inputPath, '/never-read/b.wav')
})

contract('a real JsonStore save failure preserves the pending revision for explicit retry', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-analysis-contract-'))
  const file = path.join(directory, 'library.json')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let rejectReplacement = false
  const { JsonStore, retryStorage, storageStatus } = loadSource('../src/main/lib/jsonStore.ts', {
    'node:fs': { ...fs, renameSync(source, destination) {
      if (rejectReplacement && destination === file) throw new Error('injected replacement failure')
      fs.renameSync(source, destination)
    } },
    'node:crypto': { randomUUID },
    'node:events': { EventEmitter },
    'node:os': { default: os },
    'node:path': { default: path }
  })
  const store = new JsonStore(file, [beat('a')])
  const records = {
    get: id => store.read().find(entry => entry.id === id),
    set(id, value) { store.write([...store.read().filter(entry => entry.id !== id), value]) }
  }
  const f = fixture(t, { records })
  const task = f.coordinator.analyze('a')
  rejectReplacement = true
  f.finish('a')
  const outcome = await task
  assert.equal(outcome.ok, false)
  assert.ok(outcome.analysis)
  assert.match(outcome.error, /injected replacement failure/)
  // Real JsonStore keeps the last committed cache, not an optimistic new value.
  // A best-effort status cleanup must not overwrite its unsaved analysis revision.
  assert.equal(records.get('a').analysisStatus, 'analyzing')
  assert.equal(storageStatus()[0].persisted < storageStatus()[0].revision, true)
  rejectReplacement = false
  retryStorage()
  assert.equal(records.get('a').analysisStatus, 'estimated')
  assert.equal(storageStatus()[0].error, null)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].analysisStatus, 'estimated')
})

contract('failed batch admission resumes only after its whole queued revision is retried', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-analysis-batch-'))
  const file = path.join(directory, 'library.json')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let rejectReplacement = false
  const storage = loadSource('../src/main/lib/jsonStore.ts', {
    'node:fs': { ...fs, renameSync(source, destination) {
      if (rejectReplacement && destination === file) throw new Error('injected batch replacement failure')
      fs.renameSync(source, destination)
    } },
    'node:crypto': { randomUUID },
    'node:events': { EventEmitter },
    'node:os': { default: os },
    'node:path': { default: path }
  })
  const store = new storage.JsonStore(file, [beat('a'), beat('b')])
  store.write([beat('a'), beat('b')])
  const records = {
    get: id => store.read().find(entry => entry.id === id),
    set(id, value) { store.write(store.read().map(entry => entry.id === id ? value : entry)) }
  }
  const f = fixture(t, {
    records,
    storageEvents: storage.storageEvents,
    analysisStatusesSaved: () => storage.storageStatus().every(item => item.error === null && item.persisted === item.revision),
    onBatchStatus(ids, status) {
      const selected = new Set(ids)
      store.write(store.read().map(entry => selected.has(entry.id) ? { ...entry, analysisStatus: status } : entry))
    },
    onRestoreStatuses(ids) {
      if (ids.length === 0) return
      const selected = new Set(ids)
      store.write(store.read().map(entry => selected.has(entry.id) ? {
        ...entry,
        analysisStatus: entry.analysis
          ? shared.deriveAnalysisStatus(entry.analysis.tempo, entry.analysis.key)
          : 'not-analyzed'
      } : entry))
    }
  })
  rejectReplacement = true
  assert.throws(() => f.coordinator.queue(['a', 'b']), /injected batch replacement failure/)
  assert.equal(f.started.length, 0)
  assert.equal(f.coordinator.queuedCount, 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(entry => entry.analysisStatus), ['not-analyzed', 'not-analyzed'])
  assert.throws(() => f.coordinator.queue(['a']), /waiting for a storage retry/)
  rejectReplacement = false
  storage.retryStorage()
  await flush()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(entry => entry.analysisStatus), ['analyzing', 'queued'])
  assert.equal(f.started.length, 1)
  f.finish('a'); await flush()
  assert.equal(f.started.length, 2)
  f.finish('b'); await flush()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(entry => entry.analysisStatus), ['estimated', 'estimated'])
})

contract('cancelling a blocked admission restores queued statuses after retry', async t => {
  const storageEvents = new EventEmitter()
  let saved = false
  let fail = true
  const f = fixture(t, {
    storageEvents,
    analysisStatusesSaved: () => saved,
    onBatchStatus(ids, status, records) {
      if (fail) throw new Error('injected admission failure')
      for (const id of ids) records.set(id, { ...records.get(id), analysisStatus: status })
    }
  })
  assert.throws(() => f.coordinator.queue(['a', 'b']), /admission failure/)
  f.coordinator.cancelAll()
  assert.equal(f.started.length, 0)
  fail = false
  for (const id of ['a', 'b']) f.records.set(id, { ...f.records.get(id), analysisStatus: 'queued' })
  saved = true
  storageEvents.emit('changed')
  await flush()
  assert.equal(f.coordinator.queuedCount, 0)
  assert.equal(f.started.length, 0)
  assert.deepEqual(['a', 'b'].map(id => f.records.get(id).analysisStatus), ['not-analyzed', 'not-analyzed'])
})

contract('normal close settles a retried blocked admission before reporting saved', async t => {
  let saved = false
  let fail = true
  const f = fixture(t, {
    analysisStatusesSaved: () => saved,
    onBatchStatus() { if (fail) throw new Error('injected admission failure') }
  })
  assert.throws(() => f.coordinator.queue(['a', 'b']), /admission failure/)
  await f.coordinator.shutdown()
  for (const id of ['a', 'b']) f.records.set(id, { ...f.records.get(id), analysisStatus: 'queued' })
  fail = false
  saved = true
  // requestShutdown calls this synchronously after retryStorage and before
  // logging shutdown-saved or asking Electron to quit.
  f.coordinator.settlePendingAdmission()
  assert.equal(f.coordinator.queuedCount, 0)
  assert.equal(f.started.length, 0)
  assert.deepEqual(['a', 'b'].map(id => f.records.get(id).analysisStatus), ['not-analyzed', 'not-analyzed'])
})

contract('analysis failure releases capacity for the next queued beat', async t => {
  const f = fixture(t)
  f.coordinator.queue(['a', 'b'])
  f.finish('a', { ...cancelled(), cancelled: false, error: 'ffmpeg missing' })
  await flush()
  assert.equal(f.records.get('a').analysisStatus, 'failed')
  assert.equal(f.started[1].inputPath, '/never-read/b.wav')
})

contract('direct requests reject duplicate active work and pass the force flag', async t => {
  const f = fixture(t)
  const first = f.coordinator.analyze('a', { force: true })
  assert.equal((await f.coordinator.analyze('a')).ok, false)
  assert.equal(f.started.length, 1)
  assert.equal(f.started[0].force, true)
  f.finish('a')
  assert.equal((await first).ok, true)
})

contract('shutdown refuses new direct and queued work even without the global flag', async t => {
  const f = fixture(t)
  f.coordinator.queue(['a', 'b'])
  await f.coordinator.shutdown()
  assert.equal(f.coordinator.queue(['c']), 0)
  const outcome = await f.coordinator.analyze('c')
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /closing/)
  assert.equal(f.started.length, 1)
})

contract('the global shutdown gate and cache diagnostics retain their contracts', async t => {
  const f = fixture(t)
  assert.equal(f.coordinator.status().cacheEntries, 3)
  assert.equal(f.coordinator.clearCache(), 3)
  assert.equal(f.coordinator.status().cacheEntries, 0)
  f.stop()
  assert.equal(f.coordinator.queue(['a']), 0)
  assert.equal((await f.coordinator.analyze('a')).ok, false)
  assert.equal(f.started.length, 0)
})
