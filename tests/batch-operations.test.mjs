import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function load(relativePath, dependencies) {
  const source = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  const module = { exports: {} }
  const factory = new Script(`(function(require,module,exports){\n${compiled.outputText}\n})`, { filename: source.pathname }).runInThisContext()
  factory(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected real dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

const contract = load('../src/shared/batch.ts', {})
const { BatchOperations } = load('../src/main/services/batchOperations.ts', {
  'node:crypto': require('node:crypto'),
  'node:fs/promises': { stat: async () => ({ isFile: () => true }) },
  'node:path': require('node:path'),
  '@shared/batch': contract,
  '../lifecycle': { isStopping: () => false },
  '../lib/jsonStore': { storageStatus: () => [] },
  '../lib/fsx': { sha256File: () => { throw new Error('real audio hashed') } },
  '../analysis/libraryAnalysis': { libraryAnalysis: { analyze: () => { throw new Error('real analyzer invoked') }, cancel: () => {} } },
  './library': { libraryService: { get: () => { throw new Error('real library invoked') } } },
  './reexport': { reexportBeat: () => { throw new Error('real exporter invoked') } }
})

async function untilFinished(service, id) {
  for (let i = 0; i < 100; i++) {
    const value = service.status(id)
    if (value?.status !== 'running') return value
    await nextTurn()
  }
  assert.fail('Batch did not finish')
}

function fixture(overrides = {}) {
  const called = []
  const beats = new Map(['a', 'b', 'c'].map(id => [id, { id, filePath: `/isolated/${id}.wav`, missing: false }]))
  const deps = {
    getBeat: id => beats.get(id) ?? null,
    fileExists: async () => true,
    hashFile: async () => 'saved-fingerprint',
    analyze: async id => { called.push(id); return { ok: true, error: null, analysis: {} } },
    cancelAnalysis: () => {},
    exportBeat: async (id, preset) => { called.push(`${id}:${preset}`); return { ok: true, error: null, outputPath: `/isolated/out/${id}.flac` } },
    findRegisteredOutput: () => null,
    isStopping: () => false,
    hasPendingStorage: () => false,
    ...overrides
  }
  return { service: new BatchOperations(deps), called, beats }
}

test('IPC contract rejects malformed, duplicated and unbounded snapshots', () => {
  for (const value of [null, {}, { action: 'remove', beatIds: ['a'] },
    { action: 'analyze', beatIds: [] }, { action: 'analyze', beatIds: ['a', 'a'] },
    { action: 'analyze', beatIds: Array.from({ length: 1001 }, (_, i) => `${i}`) },
    { action: 'export', beatIds: ['a'] }, { action: 'export', beatIds: ['a'], presetId: '../bad' },
    { action: 'export', beatIds: ['a'], presetId: 'original' },
    { action: 'analyze', beatIds: ['a'], presetId: 'flac' }]) {
    assert.throws(() => contract.validateBatchRequest(value))
  }
})

test('sequential export snapshots IDs, skips removed or missing records, preserves output paths', async () => {
  const { service, called, beats } = fixture()
  const input = { action: 'export', beatIds: ['a', 'b', 'c'], presetId: 'flac' }
  const started = service.start(input)
  input.beatIds.push('d')
  beats.delete('b')
  beats.get('c').missing = true
  const result = await untilFinished(service, started.id)
  assert.deepEqual(called, ['a:flac'])
  assert.deepEqual(result.items.map(item => item.status), ['completed', 'skipped', 'skipped'])
  assert.equal(result.items[0].outputPath, '/isolated/out/a.flac')
  assert.deepEqual(result.request.beatIds, ['a', 'b', 'c'])
})

test('failed IDs retry in a new session while original diagnostic remains intact', async () => {
  let fail = true
  const { service } = fixture({ exportBeat: async () => fail
    ? { ok: false, error: 'disk full', outputPath: null }
    : { ok: true, error: null, outputPath: '/isolated/retry.flac' } })
  const first = service.start({ action: 'export', beatIds: ['a'], presetId: 'flac' })
  assert.equal((await untilFinished(service, first.id)).items[0].error, 'disk full')
  fail = false
  const retried = service.retry(first.id)
  assert.notEqual(retried.id, first.id)
  assert.equal((await untilFinished(service, retried.id)).items[0].status, 'completed')
  assert.equal(service.status(first.id).items[0].error, 'disk full')
})

test('unsaved storage revision blocks new work and failed retry before duplicate export', async () => {
  let unsaved = false
  let attempts = 0
  const { service } = fixture({
    hasPendingStorage: () => unsaved,
    exportBeat: async () => { attempts++; return { ok: false, error: 'library write failed after publication', outputPath: null } }
  })
  const first = service.start({ action: 'export', beatIds: ['a'], presetId: 'flac' })
  await untilFinished(service, first.id)
  unsaved = true
  assert.throws(() => service.retry(first.id), /Retry saving/)
  assert.throws(() => service.start({ action: 'export', beatIds: ['a'], presetId: 'flac' }), /Retry saving/)
  assert.equal(attempts, 1)
  unsaved = false
  const retry = service.retry(first.id)
  await untilFinished(service, retry.id)
  assert.equal(attempts, 2)
})

test('published output with failed library commit is reconciled after storage retry without another export', async () => {
  let unsaved = false
  let registered = false
  let exports = 0
  const outputPath = '/isolated/out/published.flac'
  const { service } = fixture({
    hasPendingStorage: () => unsaved,
    findRegisteredOutput: (path, beatId) => registered && path === outputPath && beatId === 'published_1'
      ? 'saved-fingerprint' : null,
    exportBeat: async () => {
      exports++
      unsaved = true
      return { ok: false, error: 'Library commit failed.', pendingSave: true,
        outputPath, publishedBeatId: 'published_1' }
    }
  })
  const first = service.start({ action: 'export', beatIds: ['a'], presetId: 'flac' })
  assert.equal((await untilFinished(service, first.id)).items[0].status, 'pending-save')
  assert.throws(() => service.retry(first.id), /Retry saving/)
  assert.equal(exports, 1)
  unsaved = false
  registered = true
  const retry = service.retry(first.id)
  const done = await untilFinished(service, retry.id)
  assert.equal(done.items[0].status, 'completed')
  assert.equal(done.items[0].outputPath, outputPath)
  assert.equal(exports, 1)
  assert.equal(service.status(first.id).items[0].status, 'pending-save')
})

test('unregistered prior output is never republished by batch retry', async () => {
  let unsaved = false
  let exports = 0
  const { service } = fixture({
    hasPendingStorage: () => unsaved,
    exportBeat: async () => {
      exports++
      unsaved = true
      return { ok: false, error: 'Library commit failed.', pendingSave: true,
        outputPath: '/isolated/out/orphan.flac', publishedBeatId: 'published_2' }
    }
  })
  const first = service.start({ action: 'export', beatIds: ['a'], presetId: 'flac' })
  await untilFinished(service, first.id)
  unsaved = false
  const retry = service.retry(first.id)
  assert.equal((await untilFinished(service, retry.id)).items[0].status, 'failed')
  const again = service.retry(retry.id)
  assert.equal((await untilFinished(service, again.id)).items[0].status, 'failed')
  assert.equal(exports, 1)
})

test('registered output missing from disk is not reported as recovered or republished', async () => {
  let unsaved = false
  let exports = 0
  const { service } = fixture({
    hasPendingStorage: () => unsaved,
    findRegisteredOutput: () => 'saved-fingerprint',
    fileExists: async path => path !== '/isolated/out/gone.flac',
    exportBeat: async () => {
      exports++
      unsaved = true
      return { ok: false, error: 'Library commit failed.', pendingSave: true,
        outputPath: '/isolated/out/gone.flac', publishedBeatId: 'published_3' }
    }
  })
  const first = service.start({ action: 'export', beatIds: ['a'], presetId: 'flac' })
  await untilFinished(service, first.id)
  unsaved = false
  const retried = service.retry(first.id)
  const result = await untilFinished(service, retried.id)
  assert.equal(result.items[0].status, 'failed')
  assert.match(result.items[0].error, /missing/)
  assert.equal(exports, 1)
})

test('replacement at the registered output path fails fingerprint reconciliation without republishing', async () => {
  let unsaved = false
  let exports = 0
  const { service } = fixture({
    hasPendingStorage: () => unsaved,
    findRegisteredOutput: (path, beatId) => path === '/isolated/out/replaced.flac' && beatId === 'published_4'
      ? 'original-audio-hash' : null,
    fileExists: async () => true,
    hashFile: async () => 'replacement-audio-hash',
    exportBeat: async () => {
      exports++
      unsaved = true
      return { ok: false, error: 'Library commit failed.', pendingSave: true,
        outputPath: '/isolated/out/replaced.flac', publishedBeatId: 'published_4' }
    }
  })
  const first = service.start({ action: 'export', beatIds: ['a'], presetId: 'flac' })
  await untilFinished(service, first.id)
  unsaved = false
  const retried = service.retry(first.id)
  const result = await untilFinished(service, retried.id)
  assert.equal(result.items[0].status, 'failed')
  assert.match(result.items[0].error, /fingerprint/)
  assert.equal(exports, 1)
})

test('pending publication without output identity cannot be retried blindly', async () => {
  let exports = 0
  const { service } = fixture({ exportBeat: async () => {
    exports++
    return { ok: false, error: 'unknown publish boundary', pendingSave: true,
      outputPath: null, publishedBeatId: null }
  } })
  const first = service.start({ action: 'export', beatIds: ['a'], presetId: 'flac' })
  assert.equal((await untilFinished(service, first.id)).items[0].status, 'pending-save')
  assert.throws(() => service.retry(first.id), /cannot be identified safely/)
  assert.equal(exports, 1)
})

test('export cancellation lets the in-flight publication settle and cancels later items', async () => {
  let resolveExport
  const { service, called } = fixture({ exportBeat: id => {
    called.push(id)
    return new Promise(resolve => { resolveExport = resolve })
  } })
  const session = service.start({ action: 'export', beatIds: ['a', 'b'], presetId: 'flac' })
  await nextTurn()
  service.cancel(session.id)
  resolveExport({ ok: true, error: null, outputPath: '/isolated/out/a.flac' })
  const done = await untilFinished(service, session.id)
  assert.deepEqual(called, ['a'])
  assert.equal(done.status, 'cancelled')
  assert.deepEqual(done.items.map(item => item.status), ['completed', 'cancelled'])
  const resumed = service.retry(session.id)
  assert.deepEqual(resumed.request.beatIds, ['b'])
  await nextTurn()
  resolveExport({ ok: true, error: null, outputPath: '/isolated/out/b.flac' })
  assert.deepEqual((await untilFinished(service, resumed.id)).items.map(item => item.status), ['completed'])
  assert.deepEqual(service.status(session.id).items.map(item => item.status), ['completed', 'cancelled'])
})

test('analysis cancellation calls its owner and does not mark unresolved work successful', async () => {
  let resolveAnalysis
  const cancelled = []
  const { service } = fixture({
    analyze: () => new Promise(resolve => { resolveAnalysis = resolve }),
    cancelAnalysis: id => cancelled.push(id)
  })
  const session = service.start({ action: 'analyze', beatIds: ['a', 'b'] })
  await nextTurn()
  service.cancel(session.id)
  resolveAnalysis({ ok: false, error: null, analysis: null })
  const done = await untilFinished(service, session.id)
  assert.deepEqual(cancelled, ['a'])
  assert.deepEqual(done.items.map(item => item.status), ['cancelled', 'cancelled'])
})

test('shutdown blocks new intake and waits for current export to settle', async () => {
  let resolveExport
  const { service } = fixture({ exportBeat: () => new Promise(resolve => { resolveExport = resolve }) })
  const session = service.start({ action: 'export', beatIds: ['a', 'b'], presetId: 'flac' })
  await nextTurn()
  const closing = service.shutdown()
  assert.throws(() => service.start({ action: 'analyze', beatIds: ['c'] }), /closing/)
  resolveExport({ ok: false, error: 'conversion cancelled', outputPath: null })
  await closing
  const done = service.status(session.id)
  assert.deepEqual(done.items.map(item => item.status), ['failed', 'cancelled'])
})
