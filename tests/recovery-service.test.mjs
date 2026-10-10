import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const audio = Buffer.from('RIFF recovery audio identity A WAVE data 0123456789')
const otherAudio = Buffer.from('RIFF recovery audio identity B WAVE data 0123456789')
const hash = value => createHash('sha256').update(value).digest('hex')
const owner = 71

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function beat(id, filePath, patch = {}) {
  return {
    id, title: id, producer: null, bpm: null, altBpm: null, key: null, camelot: null,
    detune: null, presetId: 'original', format: 'wav', filePath, fileName: path.basename(filePath),
    fileOwnership: 'external', sidecarPath: null, sizeBytes: audio.length, durationSec: 1,
    bitrateKbps: null, sampleRate: null, channels: null, sourceUrl: null, sourceKind: 'local',
    addedAt: 1, fingerprint: hash(audio), missing: true, fileAccessError: null,
    analysisStatus: 'not-analyzed', analysis: null, overrides: [],
    sources: { title: {}, description: {}, filename: {} }, embedded: {}, verification: null,
    ...patch
  }
}

async function fixture(t) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sonic-recovery-service-'))
  const oldRoot = path.join(profile, 'old')
  const selectedRoot = path.join(profile, 'selected')
  const libraryFile = path.join(profile, 'library.json')
  await Promise.all([fsp.mkdir(oldRoot), fsp.mkdir(selectedRoot)])
  await fsp.writeFile(libraryFile, '[]')
  let replacementFails = false
  let stopping = false
  let beforeOpen = null
  const releases = new Set()
  const opens = new Map()
  const modules = new Map()
  const fsHooks = { ...fs, renameSync: (from, to) => {
    if (replacementFails && path.resolve(to) === libraryFile) {
      throw Object.assign(new Error('Injected library replacement denied'), { code: 'EACCES' })
    }
    return fs.renameSync(from, to)
  } }
  const asyncHooks = { ...fsp, open: async (file, ...args) => {
    const key = path.resolve(String(file))
    opens.set(key, (opens.get(key) ?? 0) + 1)
    if (beforeOpen) await beforeOpen(key, args)
    return fsp.open(file, ...args)
  } }

  // Load the actual services and their actual shared rules. Only host paths,
  // lifecycle state, and deterministic filesystem faults/barriers are replaced.
  function load(file) {
    file = path.resolve(file)
    if (modules.has(file)) return modules.get(file).exports
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      reportDiagnostics: true
    })
    const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? []
    assert.equal(errors.length, 0, errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
    const module = { exports: {} }
    modules.set(file, module)
    const factory = new Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`, { filename: file }).runInThisContext()
    factory(dependency => {
      if (dependency === 'node:fs') return fsHooks
      if (dependency === 'node:fs/promises') return asyncHooks
      if (dependency.startsWith('node:')) return require(dependency)
      if (dependency.startsWith('@shared/')) return load(path.join(sourceRoot, 'shared', `${dependency.slice(8)}.ts`))
      assert.ok(dependency.startsWith('.'), `Unexpected dependency ${dependency} from ${file}`)
      const target = path.resolve(path.dirname(file), `${dependency}.ts`)
      if (target === path.join(sourceRoot, 'main', 'services', 'paths.ts')) return { libraryFile: () => libraryFile }
      if (target === path.join(sourceRoot, 'main', 'services', 'settings.ts')) return { settingsService: { get: () => ({ namingTemplate: '{title}' }) } }
      if (target === path.join(sourceRoot, 'main', 'lifecycle.ts')) return { isStopping: () => stopping }
      return load(target)
    }, module, module.exports)
    return module.exports
  }

  const identity = load(path.join(sourceRoot, 'main', 'lib', 'fileIdentity.ts'))
  const storage = load(path.join(sourceRoot, 'main', 'lib', 'jsonStore.ts'))
  const { libraryService: library } = load(path.join(sourceRoot, 'main', 'services', 'library.ts'))
  const { recoveryService: recovery } = load(path.join(sourceRoot, 'main', 'services', 'recovery.ts'))
  t.after(async () => {
    beforeOpen = null
    for (const release of releases) release()
    await recovery.shutdown()
    await library.shutdown()
    assert.ok(profile.startsWith(path.join(os.tmpdir(), 'sonic-recovery-service-')))
    await fsp.rm(profile, { recursive: true, force: true })
  })

  return {
    profile, oldRoot, selectedRoot, libraryFile, identity, storage, library, recovery,
    setFailure: value => { replacementFails = value },
    setStopping: value => { stopping = value },
    openCount: file => opens.get(path.resolve(file)) ?? 0,
    denyOpen: file => { beforeOpen = key => {
      if (key === path.resolve(file)) throw Object.assign(new Error('Injected candidate read denied'), { code: 'EACCES' })
    } },
    holdOpen: file => {
      const entered = deferred(), released = deferred()
      let used = false
      releases.add(released.resolve)
      beforeOpen = async key => {
        if (key === path.resolve(file) && !used) {
          used = true
          entered.resolve()
          await released.promise
        }
      }
      return { entered: entered.promise, release: released.resolve }
    },
    clearOpenHook: () => { beforeOpen = null },
    add: (id, patch = {}) => {
      library.add(beat(id, path.join(oldRoot, `${id}.wav`), patch))
      return library.get(id)
    },
    put: async (relativePath, data = audio) => {
      const file = path.join(profile, relativePath)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, data)
      return file
    },
    committed: () => JSON.parse(fs.readFileSync(libraryFile, 'utf8')),
    ready: async (ids, location, kind = 'file', windowOwner = owner) => {
      const planId = recovery.begin(windowOwner, ids, location, kind)
      const limit = Date.now() + 8000
      for (;;) {
        const review = recovery.status(planId, windowOwner)
        if (review.phase !== 'scanning') {
          assert.equal(review.phase, 'ready', JSON.stringify(review))
          return review
        }
        assert.ok(Date.now() < limit, 'recovery preview should finish within eight seconds')
        await nextTurn()
      }
    }
  }
}

function choose(review, beatId = review.items[0].beatId, candidateIndex = 0) {
  const item = review.items.find(value => value.beatId === beatId)
  assert.ok(item?.candidates[candidateIndex], `No candidate for ${beatId}: ${JSON.stringify(review)}`)
  return { beatId, candidateId: item.candidates[candidateIndex].id }
}

function assertUnchanged(f, expected) {
  assert.deepEqual(f.library.list(), expected)
  assert.deepEqual(f.committed(), expected)
}

test('same filename and size never substitute for the saved SHA-256 identity', async t => {
  const f = await fixture(t)
  assert.equal(audio.length, otherAudio.length)
  f.add('same-name')
  const before = structuredClone(f.library.list())
  const candidate = await f.put('selected/same-name.wav', otherAudio)
  const review = await f.ready(['same-name'], candidate)
  assert.equal(review.items[0].status, 'invalid')
  assert.match(review.items[0].error, /different content|fingerprint/i)
  assert.equal(review.items[0].candidates.length, 0)
  assert.equal(review.stats.hashed, 1)
  assertUnchanged(f, before)
})

test('records without a usable saved content identity stay unverifiable', async t => {
  const f = await fixture(t)
  f.add('empty', { fingerprint: '' })
  f.add('legacy', { fingerprint: 'legacy-filename-fingerprint' })
  await f.put('selected/empty.wav')
  await f.put('selected/legacy.wav')
  const before = structuredClone(f.library.list())
  const review = await f.ready(['empty', 'legacy'], f.selectedRoot, 'folder')
  assert.ok(review.items.every(item => item.status === 'unverifiable' && item.candidates.length === 0))
  assert.equal(review.stats.hashed, 0)
  await assert.rejects(f.recovery.apply(review.planId, owner, [{ beatId: 'empty', candidateId: 'invented' }]), /does not belong/)
  assertUnchanged(f, before)
})

test('multiple identical files remain ambiguous until an explicit scoped selection is applied', async t => {
  const f = await fixture(t)
  f.add('track')
  const a = await f.put('selected/one/first.wav')
  const b = await f.put('selected/two/second.wav')
  const before = structuredClone(f.library.list())
  const review = await f.ready(['track'], f.selectedRoot, 'folder')
  assert.equal(review.items[0].status, 'ambiguous')
  assert.deepEqual(new Set(review.items[0].candidates.map(candidate => candidate.path)), new Set([a, b]))
  assertUnchanged(f, before)
  const selection = choose(review, 'track', review.items[0].candidates.findIndex(candidate => candidate.path === b))
  const done = await f.recovery.apply(review.planId, owner, [selection])
  assert.deepEqual(done.committedIds, ['track'])
  assert.equal(f.library.get('track').filePath, b)
  assert.equal(f.library.get('track').missing, false)
  assert.equal(f.committed()[0].filePath, b)
  assert.deepEqual(await fsp.readFile(a), audio)
  assert.deepEqual(await fsp.readFile(b), audio)
})

test('apply rejects a candidate changed, removed, or made unreadable after preview', async t => {
  for (const condition of ['changed', 'replaced with identical bytes', 'removed', 'denied']) {
    await t.test(condition, async t => {
      const f = await fixture(t)
      f.add('track')
      const candidate = await f.put('selected/track.wav')
      const review = await f.ready(['track'], candidate)
      const before = structuredClone(f.library.list())
      if (condition === 'changed') await fsp.writeFile(candidate, otherAudio)
      if (condition === 'replaced with identical bytes') {
        await fsp.copyFile(candidate, `${candidate}.replacement`)
        await fsp.unlink(candidate)
        await fsp.rename(`${candidate}.replacement`, candidate)
      }
      if (condition === 'removed') await fsp.unlink(candidate)
      if (condition === 'denied') f.denyOpen(candidate)
      const done = await f.recovery.apply(review.planId, owner, [choose(review)])
      assert.equal(done.items[0].status, 'invalid')
      assert.equal(done.committedIds.length, 0)
      assert.match(done.items[0].error, /changed|ENOENT|denied/i)
      assertUnchanged(f, before)
    })
  }
})

test('cancelling a scan at a filesystem barrier prevents any recovery commit', async t => {
  const f = await fixture(t)
  f.add('track')
  const before = structuredClone(f.library.list())
  const candidate = await f.put('selected/track.wav')
  const gate = f.holdOpen(candidate)
  const planId = f.recovery.begin(owner, ['track'], candidate, 'file')
  await gate.entered
  assert.equal(f.recovery.status(planId, owner).phase, 'scanning')
  const cancelling = f.recovery.cancel(planId, owner)
  gate.release()
  const cancelled = await cancelling
  assert.equal(cancelled.phase, 'cancelled')
  assert.deepEqual(cancelled.committedIds, [])
  await assert.rejects(f.recovery.apply(planId, owner, [{ beatId: 'track', candidateId: 'invented' }]), /scan to finish/)
  assertUnchanged(f, before)
})

test('a failed replacement keeps old paths committed until real guarded storage retry succeeds', async t => {
  const f = await fixture(t)
  f.add('track')
  const candidate = await f.put('selected/track.wav')
  const review = await f.ready(['track'], candidate)
  const before = structuredClone(f.library.list())
  f.setFailure(true)
  const pending = await f.recovery.apply(review.planId, owner, [choose(review)])
  assert.equal(pending.phase, 'pending-save')
  assert.equal(pending.committedIds.length, 0)
  assert.ok(pending.pendingRevision > 0)
  assertUnchanged(f, before)
  const opensBeforeRetry = f.openCount(candidate)
  f.setFailure(false)
  await f.storage.retryStorage()
  assert.ok(f.openCount(candidate) > opensBeforeRetry, 'retry must re-open and re-hash the real candidate')
  const saved = f.recovery.status(review.planId, owner)
  assert.equal(saved.phase, 'complete')
  assert.deepEqual(saved.committedIds, ['track'])
  assert.equal(f.library.get('track').filePath, candidate)
  assert.equal(f.committed()[0].filePath, candidate)
  assert.equal(f.library.pendingRevision(), null)
})

test('a changed pending candidate cannot bypass validation through Retry saving; cancellation preserves the old revision', async t => {
  const f = await fixture(t)
  f.add('track')
  const candidate = await f.put('selected/track.wav')
  const review = await f.ready(['track'], candidate)
  const before = structuredClone(f.library.list())
  f.setFailure(true)
  const pending = await f.recovery.apply(review.planId, owner, [choose(review)])
  assert.equal(pending.phase, 'pending-save')
  f.setFailure(false)
  await fsp.writeFile(candidate, otherAudio)
  await assert.rejects(async () => { await f.storage.retryStorage() }, /changed after preview/)
  assert.equal(f.recovery.status(review.planId, owner).phase, 'pending-save')
  assertUnchanged(f, before)
  const cancelled = await f.recovery.cancel(review.planId, owner)
  assert.equal(cancelled.phase, 'cancelled')
  await f.storage.retryStorage()
  assert.equal(f.library.pendingRevision(), null)
  assertUnchanged(f, before)
})

test('metadata changed during preview is preserved when location-only recovery commits', async t => {
  const f = await fixture(t)
  f.add('track', { sourceKind: 'soundcloud', sourceUrl: 'https://soundcloud.com/producer/track',
    sourceChannel: 'Original producer', thumbnail: 'https://example.test/art.jpg' })
  const candidate = await f.put('selected/track.wav')
  const gate = f.holdOpen(candidate)
  const planId = f.recovery.begin(owner, ['track'], candidate, 'file')
  await gate.entered
  await f.library.updateMetadata('track', { title: 'User correction', bpm: 151, key: 'C minor' })
  const corrected = structuredClone(f.library.get('track'))
  gate.release()
  while (f.recovery.status(planId, owner).phase === 'scanning') await nextTurn()
  const preview = f.recovery.status(planId, owner)
  const done = await f.recovery.apply(planId, owner, [choose(preview)])
  assert.deepEqual(done.committedIds, ['track'])
  const saved = f.library.get('track')
  for (const field of ['title', 'bpm', 'key', 'camelot', 'overrides', 'sources', 'analysis', 'sourceKind', 'sourceUrl', 'sourceChannel', 'thumbnail']) {
    assert.deepEqual(saved[field], corrected[field], `${field} must survive recovery`)
  }
  assert.equal(saved.filePath, candidate)
})

test('concurrent metadata edits and removal share the recovery mutation boundary without lost updates or resurrection', async t => {
  const f = await fixture(t)
  f.add('edited')
  f.add('removed', { fingerprint: hash(otherAudio) })
  const editedPath = await f.put('selected/edited.wav')
  const removedPath = await f.put('selected/removed.wav', otherAudio)
  const review = await f.ready(['edited', 'removed'], f.selectedRoot, 'folder')
  const gate = f.holdOpen(editedPath)
  const applying = f.recovery.apply(review.planId, owner, [choose(review, 'edited'), choose(review, 'removed')])
  await gate.entered
  const editing = f.library.updateMetadata('edited', { title: 'Concurrent correction', bpm: 142 })
  const removing = f.library.remove('removed', false)
  gate.release()
  const [done, , removed] = await Promise.all([applying, editing, removing])
  assert.equal(removed.ok, true)
  assert.deepEqual(done.committedIds, ['edited'])
  assert.equal(f.library.get('edited').title, 'Concurrent correction')
  assert.equal(f.library.get('edited').bpm, 142)
  assert.equal(f.library.get('edited').filePath, editedPath)
  assert.equal(f.library.get('removed'), null)
  assert.ok(!f.committed().some(record => record.id === 'removed'))
  assert.deepEqual(await fsp.readFile(removedPath), otherAudio)
})

async function movedExport(f, sidecarMode = 'valid') {
  const original = await f.put('old/export.wav')
  const receiptPath = await f.put('old/receipts/export.wav.sonic.json', JSON.stringify({
    schema: 'sonic-v2/beat', schemaVersion: 2, id: 'receipt-original',
    output: { filePath: 'export.wav', fingerprint: hash(audio) },
    source: { kind: 'soundcloud', url: 'https://soundcloud.com/producer/original' },
    naming: { fileName: 'export.wav' }, metadata: { title: 'Stale sidecar title', bpm: 80 }
  }))
  const ownershipEvidence = { audio: await f.identity.capturePhysicalIdentity(original),
    sidecar: { id: 'receipt-original', file: await f.identity.capturePhysicalIdentity(receiptPath) } }
  f.add('export', { fileOwnership: 'sonic-export', filePath: original, sidecarPath: receiptPath, ownershipEvidence,
    sourceKind: 'soundcloud', sourceUrl: 'https://soundcloud.com/producer/original', sourceChannel: 'Original producer',
    title: 'Authoritative library title', bpm: 153, key: 'C minor', camelot: '5A', overrides: ['title', 'bpm'],
    sources: { title: { bpm: 153 }, description: {}, filename: {} },
    analysis: { engine: 'sonic-dsp/2', inputId: hash(audio), inputName: 'export.wav', analyzedAt: 100,
      analyzedSeconds: 1, sampleRate: 22050, channels: 1, durationSec: 1,
      tempo: { status: 'estimated', bpm: 153, bpmExact: 153.02, alternatives: [], confidence: 0.8, warning: null },
      key: { status: 'estimated', key: 'C minor', camelot: '5A', alternatives: [], confidence: 0.8, tuningCents: 0, warning: null },
      warnings: [] }, analysisStatus: 'estimated' })
  const movedRoot = path.join(f.selectedRoot, 'moved')
  await fsp.rename(f.oldRoot, movedRoot)
  const candidate = path.join(movedRoot, 'export.wav')
  const sidecar = path.join(movedRoot, 'receipts', 'export.wav.sonic.json')
  if (sidecarMode === 'missing') await fsp.unlink(sidecar)
  if (sidecarMode === 'malformed') await fsp.writeFile(sidecar, '{broken-json')
  if (sidecarMode === 'unrelated') {
    const parsed = JSON.parse(await fsp.readFile(sidecar, 'utf8'))
    parsed.id = 'receipt-from-another-export'
    await fsp.writeFile(sidecar, JSON.stringify(parsed))
  }
  if (sidecarMode === 'copied') {
    await fsp.copyFile(sidecar, `${sidecar}.copy`)
    await fsp.unlink(sidecar)
    await fsp.rename(`${sidecar}.copy`, sidecar)
  }
  return { candidate, sidecar, original }
}

test('an independently located owned sidecar reconnects without overriding authoritative metadata or writing its bytes', async t => {
  const f = await fixture(t)
  const { candidate, sidecar } = await movedExport(f)
  const sidecarBefore = await fsp.readFile(sidecar)
  const metadataBefore = structuredClone(f.library.get('export'))
  const review = await f.ready(['export'], f.selectedRoot, 'folder')
  assert.equal(review.items[0].candidates[0].sidecar, 'verified')
  assert.equal(review.items[0].candidates[0].ownership, 'retained')
  const done = await f.recovery.apply(review.planId, owner, [choose(review)])
  assert.deepEqual(done.committedIds, ['export'])
  const saved = f.library.get('export')
  assert.equal(saved.filePath, candidate)
  assert.equal(saved.sidecarPath, sidecar)
  assert.equal(saved.sidecarSync.status, 'pending')
  for (const field of ['title', 'bpm', 'key', 'camelot', 'analysis', 'analysisStatus', 'overrides', 'sources', 'sourceKind', 'sourceUrl']) {
    assert.deepEqual(saved[field], metadataBefore[field], `${field} must remain library-authoritative`)
  }
  assert.deepEqual(await fsp.readFile(sidecar), sidecarBefore)
  assert.deepEqual(await fsp.readFile(candidate), audio)
})

test('missing, malformed, unrelated, and copied sidecars never prevent identical audio from reconnecting', async t => {
  for (const mode of ['missing', 'malformed', 'unrelated', 'copied']) {
    await t.test(mode, async t => {
      const f = await fixture(t)
      const { candidate, sidecar } = await movedExport(f, mode)
      const before = mode === 'missing' ? null : await fsp.readFile(sidecar)
      const review = await f.ready(['export'], f.selectedRoot, 'folder')
      assert.equal(review.items[0].candidates[0].sidecar, 'unresolved')
      const done = await f.recovery.apply(review.planId, owner, [choose(review)])
      assert.deepEqual(done.committedIds, ['export'])
      const saved = f.library.get('export')
      assert.equal(saved.filePath, candidate)
      assert.equal(saved.fileOwnership, 'sonic-export')
      assert.equal(saved.sidecarPath, null)
      assert.equal(saved.recoveryInfo.sidecar, 'unresolved')
      assert.equal(saved.ownershipEvidence.sidecar, undefined)
      if (before) assert.deepEqual(await fsp.readFile(sidecar), before)
      else await assert.rejects(fsp.access(sidecar), { code: 'ENOENT' })
    })
  }
})

test('sidecar changes after preview lose sidecar adoption while identical owned audio still reconnects', async t => {
  const f = await fixture(t)
  const { candidate, sidecar } = await movedExport(f)
  const review = await f.ready(['export'], f.selectedRoot, 'folder')
  assert.equal(review.items[0].candidates[0].sidecar, 'verified')
  const changed = JSON.stringify({ unrelated: true })
  await fsp.writeFile(sidecar, changed)
  const done = await f.recovery.apply(review.planId, owner, [choose(review)])
  assert.deepEqual(done.committedIds, ['export'])
  assert.equal(f.library.get('export').filePath, candidate)
  assert.equal(f.library.get('export').sidecarPath, null)
  assert.equal(f.library.get('export').recoveryInfo.sidecar, 'unresolved')
  assert.equal(await fsp.readFile(sidecar, 'utf8'), changed)
})

test('copied bytes become external while a same-file rename retains export ownership', async t => {
  for (const operation of ['copy', 'rename', 'external-rename']) {
    await t.test(operation, async t => {
      const f = await fixture(t)
      const original = await f.put('old/owned.wav')
      const evidence = { audio: await f.identity.capturePhysicalIdentity(original) }
      f.add('owned', { filePath: original, fileOwnership: operation === 'external-rename' ? 'external' : 'sonic-export', ownershipEvidence: evidence })
      const candidate = path.join(f.selectedRoot, 'located.wav')
      if (operation === 'copy') { await fsp.copyFile(original, candidate); await fsp.unlink(original) }
      else await fsp.rename(original, candidate)
      const review = await f.ready(['owned'], candidate)
      const retained = operation === 'rename'
      assert.equal(review.items[0].candidates[0].ownership, retained ? 'retained' : 'read-only')
      const done = await f.recovery.apply(review.planId, owner, [choose(review)])
      assert.deepEqual(done.committedIds, ['owned'])
      const saved = f.library.get('owned')
      assert.equal(saved.fileOwnership, retained ? 'sonic-export' : 'external')
      assert.equal(saved.recoveryInfo.ownership, retained ? 'retained' : 'read-only')
      assert.equal(saved.sidecarPath, null)
      if (retained) assert.deepEqual(saved.ownershipEvidence.audio, evidence.audio)
      else assert.equal(saved.ownershipEvidence, undefined)
      assert.deepEqual(await fsp.readFile(candidate), audio)
    })
  }
})

test('review owners, record IDs, and candidate IDs are scoped and snapshots cannot rewrite authority', async t => {
  const f = await fixture(t)
  f.add('one')
  f.add('two')
  const onePath = await f.put('selected/one.wav')
  const twoPath = await f.put('selected/two.wav')
  const one = await f.ready(['one'], onePath)
  const two = await f.ready(['two'], twoPath)
  const before = structuredClone(f.library.list())
  assert.throws(() => f.recovery.status(one.planId, owner + 1), /unavailable in this window/)
  await assert.rejects(f.recovery.cancel(one.planId, owner + 1), /unavailable in this window/)
  await assert.rejects(f.recovery.apply(one.planId, owner + 1, [choose(one)]), /unavailable in this window/)
  await assert.rejects(f.recovery.apply(one.planId, owner, [{ beatId: 'one', candidateId: choose(two).candidateId }]), /does not belong/)
  await assert.rejects(f.recovery.apply(one.planId, owner, [{ beatId: 'two', candidateId: choose(one).candidateId }]), /does not belong/)
  const forged = structuredClone(one)
  forged.items[0].candidates[0].path = twoPath
  forged.items[0].candidates[0].ownership = 'retained'
  assert.equal(f.recovery.status(one.planId, owner).items[0].candidates[0].path, onePath)
  assertUnchanged(f, before)
  const done = await f.recovery.apply(one.planId, owner, [choose(forged)])
  assert.deepEqual(done.committedIds, ['one'])
  assert.equal(f.library.get('one').filePath, onePath)
  assert.equal(f.library.get('one').fileOwnership, 'external')
})

test('a candidate already referenced by another library record is excluded from recovery', async t => {
  const f = await fixture(t)
  f.add('missing')
  const candidate = await f.put('selected/already-used.wav')
  f.add('existing', { filePath: candidate, missing: false })
  const before = structuredClone(f.library.list())
  const review = await f.ready(['missing'], candidate)
  assert.equal(review.items[0].candidates.length, 0)
  assert.equal(review.completeSearch, false)
  assert.ok(review.errors.some(error => /another library record/.test(error.message)))
  assertUnchanged(f, before)
})

test('shutdown drains held scans and held applies without a late path mutation', async t => {
  for (const phase of ['scan', 'apply']) {
    await t.test(phase, async t => {
      const f = await fixture(t)
      f.add('track')
      const candidate = await f.put('selected/track.wav')
      const before = structuredClone(f.library.list())
      let planId, applying
      if (phase === 'apply') {
        const review = await f.ready(['track'], candidate)
        planId = review.planId
        const gate = f.holdOpen(candidate)
        applying = f.recovery.apply(planId, owner, [choose(review)])
        await gate.entered
        const shutdown = f.recovery.shutdown()
        gate.release()
        await Promise.all([shutdown, applying])
      } else {
        const gate = f.holdOpen(candidate)
        planId = f.recovery.begin(owner, ['track'], candidate, 'file')
        await gate.entered
        const shutdown = f.recovery.shutdown()
        gate.release()
        await shutdown
      }
      assert.equal(f.recovery.status(planId, owner).phase, 'cancelled')
      assert.throws(() => f.recovery.begin(owner, ['track'], candidate, 'file'), /closing/)
      assertUnchanged(f, before)
    })
  }
})

test('shutdown prevents a pending storage retry from committing recovery paths after services stop', async t => {
  const f = await fixture(t)
  f.add('track')
  const candidate = await f.put('selected/track.wav')
  const review = await f.ready(['track'], candidate)
  const before = structuredClone(f.library.list())
  f.setFailure(true)
  const pending = await f.recovery.apply(review.planId, owner, [choose(review)])
  assert.equal(pending.phase, 'pending-save')
  f.setFailure(false)
  const gate = f.holdOpen(candidate)
  const retry = Promise.resolve().then(() => f.storage.retryStorage())
  const outcome = retry.then(() => ({ ok: true }), error => ({ ok: false, error }))
  await gate.entered
  f.setStopping(true)
  const shutdown = f.recovery.shutdown()
  gate.release()
  await shutdown
  await f.library.shutdown()
  const result = await outcome
  assert.equal(result.ok, false, 'a retry that spans shutdown must fail before replacing the library')
  assert.match(String(result.error), /closing|stopp|abort/i)
  assertUnchanged(f, before)
})

test('directory junctions outside the selected root and back to the root are never traversed or adopted', async t => {
  const f = await fixture(t)
  f.add('track')
  const outside = await f.put('outside/track.wav')
  const outsideBytes = await fsp.readFile(outside)
  const outwardLink = path.join(f.selectedRoot, 'outside-junction')
  const cycleLink = path.join(f.selectedRoot, 'cycle-junction')
  const before = structuredClone(f.library.list())
  await fsp.symlink(path.dirname(outside), outwardLink, 'junction')
  await fsp.symlink(f.selectedRoot, cycleLink, 'junction')
  try {
    assert.equal((await fsp.lstat(outwardLink)).isSymbolicLink(), true)
    assert.equal((await fsp.lstat(cycleLink)).isSymbolicLink(), true)
    const review = await f.ready(['track'], f.selectedRoot, 'folder')
    assert.equal(review.stats.visited, 2, 'only the two directory entries may be visited; neither target may be traversed')
    assert.equal(review.stats.skippedLinks, 2)
    assert.equal(review.stats.files, 0)
    assert.equal(review.stats.hashed, 0)
    assert.equal(review.stats.hashedBytes, 0)
    assert.equal(review.items[0].candidates.length, 0)
    assert.equal(review.completeSearch, false)
    assert.deepEqual(new Set(review.errors.map(error => error.path)), new Set([outwardLink, cycleLink]))
    for (const linkedRoot of [outwardLink, cycleLink]) {
      const planId = f.recovery.begin(owner, ['track'], linkedRoot, 'folder')
      const deadline = Date.now() + 8000
      let rejected = f.recovery.status(planId, owner)
      while (rejected.phase === 'scanning') {
        assert.ok(Date.now() < deadline, 'selecting a linked root must terminate without walking its target')
        await nextTurn()
        rejected = f.recovery.status(planId, owner)
      }
      assert.equal(rejected.phase, 'error')
      assert.match(rejected.error, /linked files and folders/i)
      assert.equal(rejected.stats.visited, 0)
      assert.equal(rejected.stats.hashed, 0)
      assert.equal(rejected.items[0].candidates.length, 0)
    }
    assert.equal(f.openCount(outside), 0)
    assert.equal(f.openCount(path.join(outwardLink, 'track.wav')), 0)
    assert.deepEqual(await fsp.readFile(outside), outsideBytes)
    assertUnchanged(f, before)
  } finally {
    // Unlink only these test-owned junction entries, leaving both target directories intact.
    await fsp.unlink(outwardLink)
    await fsp.unlink(cycleLink)
  }
  assert.deepEqual(await fsp.readFile(outside), outsideBytes)
})

test('concurrent duplicate Apply submissions share one validation and one coherent library revision', async t => {
  const f = await fixture(t)
  f.add('track')
  const candidate = await f.put('selected/track.wav')
  const review = await f.ready(['track'], candidate)
  const selection = [choose(review)]
  const storageState = () => f.storage.storageStatus().find(state =>
    path.resolve(state.file).toLowerCase() === path.resolve(f.libraryFile).toLowerCase())
  const before = { ...storageState() }
  assert.equal(before.persisted, before.revision)
  const beforeLibrary = structuredClone(f.library.list())
  const opensBefore = f.openCount(candidate)
  const changed = []
  f.library.on('changed', records => changed.push(structuredClone(records)))
  const gate = f.holdOpen(candidate)
  const first = f.recovery.apply(review.planId, owner, selection)
  await gate.entered
  const second = f.recovery.apply(review.planId, owner, structuredClone(selection))
  assert.equal(f.recovery.status(review.planId, owner).phase, 'applying')
  assert.equal(storageState().revision, before.revision)
  assert.equal(changed.length, 0)
  assertUnchanged(f, beforeLibrary)
  gate.release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.deepEqual(firstResult, secondResult)
  assert.equal(firstResult.phase, 'complete')
  assert.deepEqual(firstResult.committedIds, ['track'])
  assert.equal(storageState().revision, before.revision + 1)
  assert.equal(storageState().persisted, before.persisted + 1)
  assert.equal(f.openCount(candidate), opensBefore + 1, 'both submissions must share the same content revalidation')
  assert.equal(changed.length, 1)
  assert.deepEqual(changed[0], f.library.list())
  assert.equal(f.library.get('track').filePath, candidate)
  assert.equal(f.library.get('track').missing, false)
  assert.deepEqual(f.committed(), f.library.list())
  assert.deepEqual(await fsp.readFile(candidate), audio)
})
