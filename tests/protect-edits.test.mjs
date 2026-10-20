import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// Runs the real main-process sources with only filesystem faults and media
// tooling substituted, each against a fresh temporary profile.
function loadSource(relativePath, resolve) {
  const url = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    fileName: url.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    reportDiagnostics: true
  })
  const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? []
  assert.equal(errors.length, 0, errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  const module = { exports: {} }
  const factory = new Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`, { filename: url.pathname }).runInThisContext()
  factory(resolve, module, module.exports)
  return module.exports
}

const sharedModules = new Map()
function shared(name) {
  if (sharedModules.has(name)) return sharedModules.get(name)
  const result = loadSource(`../src/shared/${name}.ts`, dependency => {
    assert.ok(dependency.startsWith('./'), `Unexpected shared dependency: ${dependency}`)
    return shared(dependency.slice(2))
  })
  sharedModules.set(name, result)
  return result
}

function resolver(dependencies, label) {
  return name => {
    if (name.startsWith('@shared/')) return shared(name.slice(8))
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected ${label} dependency: ${name}`)
    return dependencies[name]
  }
}

const sha = value => createHash('sha256').update(value).digest('hex')
const fsx = loadSource('../src/main/lib/fsx.ts', require)
const fileIdentity = loadSource('../src/main/lib/fileIdentity.ts', require)

function record(id, patch = {}) {
  return {
    id, title: id, producer: null, bpm: null, altBpm: null, key: null, camelot: null,
    detune: null, presetId: 'mp3-320', format: 'mp3', filePath: `/${id}.mp3`, fileName: `${id}.mp3`,
    fileOwnership: 'sonic-export', sidecarPath: null, sizeBytes: 5, durationSec: 1,
    bitrateKbps: null, sampleRate: null, channels: null, sourceUrl: null, sourceKind: 'youtube',
    addedAt: 1, fingerprint: '', missing: false, analysisStatus: 'not-analyzed', namingTemplate: '{title}',
    analysis: null, overrides: [], sources: { title: {}, description: {}, filename: {} },
    embedded: {}, verification: null, ...patch
  }
}

async function profile(t, prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

function loadStorage(failFor) {
  return loadSource('../src/main/lib/jsonStore.ts', name => {
    if (name === 'node:fs') return { ...fs, renameSync: (from, to) => {
      if (failFor() === to) throw Object.assign(new Error('injected replacement failure'), { code: 'EACCES' })
      return fs.renameSync(from, to)
    } }
    return require(name)
  })
}

async function libraryFixture(t, options = {}) {
  const root = await profile(t, 'sonic-protect-library-')
  const libraryFile = path.join(root, 'library.json')
  const audio = path.join(root, 'Old.mp3')
  const sidecar = `${audio}.sonic.json`
  await fsp.writeFile(audio, 'audio')
  const fingerprint = sha('audio')
  const identity = await fileIdentity.capturePhysicalIdentity(audio)
  await fsp.writeFile(sidecar, JSON.stringify({ schema: 'sonic-v2/beat', id: 'sc_1', naming: { template: '{title}', fileName: 'Old.mp3' },
    metadata: { title: 'Old' }, source: { kind: 'youtube', url: null }, output: { filePath: 'Old.mp3', fingerprint } }))
  const beat = record('beat_1', { title: 'Old', filePath: audio, fileName: 'Old.mp3', fingerprint, sidecarPath: sidecar,
    ...(options.evidence ? { ownershipEvidence: { audio: identity, sidecar: { id: 'sc_1', file: await fileIdentity.capturePhysicalIdentity(sidecar) } } } : {}) })
  await fsp.writeFile(libraryFile, JSON.stringify([beat]))
  let failWrite = false
  const storage = loadStorage(() => failWrite ? libraryFile : null)
  const calls = { link: 0, rename: [] }
  const promises = {
    ...fsp,
    link: async (from, to) => {
      calls.link++
      if (options.linkError) throw Object.assign(new Error('injected link failure'), { code: options.linkError })
      return fsp.link(from, to)
    },
    rename: async (from, to) => {
      calls.rename.push([from, to])
      if (options.renameFails?.(from, to)) throw Object.assign(new Error('injected rename failure'), { code: 'EBUSY' })
      return fsp.rename(from, to)
    }
  }
  const identityModule = { ...fileIdentity, capturePhysicalIdentity: async file => {
    if (options.identityFails?.(file)) throw new Error('injected identity failure')
    return fileIdentity.capturePhysicalIdentity(file)
  } }
  const { libraryService } = loadSource('../src/main/services/library.ts', resolver({
    'node:crypto': require('node:crypto'), 'node:events': require('node:events'), 'node:fs': fs,
    'node:fs/promises': promises, 'node:path': path, '../lib/jsonStore': storage, '../lib/fileIdentity': identityModule,
    '../lib/fsx': { ...fsx, sha256File: options.sha256File ?? fsx.sha256File },
    './paths': { libraryFile: () => libraryFile }, './settings': { settingsService: { get: () => ({ namingTemplate: '{title}' }) } },
    '../lifecycle': { isStopping: () => false }
  }, 'library'))
  t.after(() => libraryService.shutdown())
  return { root, audio, sidecar, library: libraryService, storage, calls, setFailWrite: value => { failWrite = value } }
}

test('a title edit on a volume without hard links renames exclusively and keeps the sidecar paired', async t => {
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'EISDIR', 'ENOSYS']) {
    const { root, audio, sidecar, library, calls } = await libraryFixture(t, { linkError: code, evidence: true })
    await library.updateMetadata('beat_1', { title: 'New' })
    const beat = library.get('beat_1')
    assert.equal(calls.link, 1)
    assert.equal(beat.filePath, path.join(root, 'New.mp3'), code)
    assert.equal(beat.sidecarPath, `${path.join(root, 'New.mp3')}.sonic.json`)
    assert.equal(fs.existsSync(audio), false)
    assert.equal(fs.existsSync(sidecar), false)
    assert.equal(await fsp.readFile(beat.filePath, 'utf8'), 'audio')
    assert.equal(JSON.parse(await fsp.readFile(beat.sidecarPath, 'utf8')).output.filePath, 'New.mp3')
    assert.ok(fileIdentity.samePhysicalFile(beat.ownershipEvidence.audio, await fileIdentity.capturePhysicalIdentity(beat.filePath)))
    assert.deepEqual((await fsp.readdir(root)).filter(name => name.endsWith('.mp3')), ['New.mp3'])
  }
})

test('a link failure other than missing support is not retried as a move', async t => {
  const { audio, library, calls } = await libraryFixture(t, { linkError: 'EACCES' })
  await assert.rejects(library.updateMetadata('beat_1', { title: 'New' }), /injected link failure/)
  assert.equal(calls.rename.length, 0)
  assert.equal(library.get('beat_1').filePath, audio)
  assert.equal(library.get('beat_1').title, 'Old')
})

test('a failed fallback move releases its reservation and new sidecar, leaving the original untouched', async t => {
  const { root, audio, sidecar, library } = await libraryFixture(t, { linkError: 'EPERM', renameFails: from => from.endsWith('Old.mp3') })
  await assert.rejects(library.updateMetadata('beat_1', { title: 'New' }), /injected rename failure/)
  assert.deepEqual((await fsp.readdir(root)).filter(name => name.startsWith('New')), [])
  assert.equal(fs.existsSync(`${path.join(root, 'New.mp3')}.sonic.json`), false)
  assert.equal(await fsp.readFile(audio, 'utf8'), 'audio')
  assert.ok(fs.existsSync(sidecar))
  assert.equal(library.get('beat_1').filePath, audio)
})

test('a fallback move is rolled back when the commit cannot be attempted', async t => {
  const { root, audio, library } = await libraryFixture(t, { linkError: 'EPERM', evidence: true, identityFails: file => file.endsWith('New.mp3') })
  await assert.rejects(library.updateMetadata('beat_1', { title: 'New' }), /injected identity failure/)
  assert.equal(await fsp.readFile(audio, 'utf8'), 'audio')
  assert.equal(fs.existsSync(path.join(root, 'New.mp3')), false)
  assert.equal(library.get('beat_1').filePath, audio)
  assert.equal(library.get('beat_1').title, 'Old')
})

test('a fallback move whose library write is pending keeps the new name for the retry', async t => {
  const { root, library, storage, setFailWrite } = await libraryFixture(t, { linkError: 'EPERM' })
  setFailWrite(true)
  await assert.rejects(library.updateMetadata('beat_1', { title: 'New' }), /injected replacement failure/)
  assert.equal(await fsp.readFile(path.join(root, 'New.mp3'), 'utf8'), 'audio')
  setFailWrite(false)
  storage.retryStorage()
  assert.equal(library.get('beat_1').filePath, path.join(root, 'New.mp3'))
})

test('a rename commit merges into the latest record instead of reverting concurrent writes', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const reading = new Promise(resolve => { entered = resolve })
  const { library } = await libraryFixture(t, { sha256File: async file => { entered(); await gate; return fsx.sha256File(file) } })
  const edit = library.updateMetadata('beat_1', { title: 'New', bpm: 140 })
  await reading
  library.update('beat_1', { sourceChannel: 'Fresh channel', thumbnail: 'https://example.com/art.jpg' })
  library.setAnalysisStatus('beat_1', 'queued')
  release()
  await edit
  const beat = library.get('beat_1')
  assert.equal(beat.title, 'New')
  assert.equal(beat.bpm, 140)
  assert.match(beat.fileName, /^New .*\.mp3$/)
  assert.equal(beat.sourceChannel, 'Fresh channel')
  assert.equal(beat.thumbnail, 'https://example.com/art.jpg')
  assert.equal(beat.analysisStatus, 'queued')
})

test('adding a record while a library save is pending fails with a clear message', async t => {
  const { library, setFailWrite } = await libraryFixture(t)
  setFailWrite(true)
  assert.throws(() => library.update('beat_1', { title: 'Unsaved' }), /injected replacement failure/)
  setFailWrite(false)
  assert.throws(() => library.add(record('beat_2')), /library save is pending/i)
  assert.throws(() => library.assertWritable(), /library save is pending/i)
})

// ------------------------------------------------------------------ publish

async function publishFixture(t, options = {}) {
  const root = await profile(t, 'sonic-protect-publish-')
  const downloadDir = path.join(root, 'downloads')
  await fsp.mkdir(downloadDir)
  const staged = path.join(root, 'staged.mp3')
  await fsp.writeFile(staged, 'export')
  const library = {
    pending: null, records: new Map(), added: [],
    assertWritable() { if (this.pending !== null) throw new Error('A library save is pending. Retry saving before changing files or records.') },
    pendingRevision() { return this.pending },
    get(id) { return this.records.get(id) ?? null },
    add(beat) {
      this.assertWritable()
      this.added.push(beat)
      if (options.addFails === 'pending') { this.pending = 7; throw new Error('injected library write failure') }
      if (options.addFails === 'plain') throw new Error('injected validation failure')
      this.records.set(beat.id, beat)
    }
  }
  const hidden = new Set(options.hidden ?? [])
  const publish = loadSource('../src/main/services/publish.ts', resolver({
    electron: { app: { getVersion: () => 'test' } },
    'node:fs': { ...fs, existsSync: file => !hidden.has(path.basename(file)) && fs.existsSync(file) },
    'node:fs/promises': fsp, 'node:stream/promises': require('node:stream/promises'), 'node:path': path,
    '../lib/fsx': fsx, '../lib/jsonStore': { storageDiagnostic: () => undefined }, './paths': { libraryFile: () => path.join(root, 'library.json') },
    '../lib/id': { createId: prefix => `${prefix}_${Math.random().toString(16).slice(2)}` }, './library': { libraryService: library },
    './settings': { settingsService: { get: () => ({ downloadDir, namingTemplate: '{title}', writeSidecar: true, sidecarInSubfolder: false }) } },
    '../lib/fileIdentity': fileIdentity
  }, 'publish'))
  const input = {
    jobId: 'job_1', stagedPath: staged, extension: 'mp3', presetId: 'mp3-320', sourceKind: 'youtube', sourceUrl: null,
    videoId: null, uploader: null, sourceTitle: null, evidence: [], conflicts: [], channels: 'stereo', lufs: null, embedTags: true,
    fingerprint: sha('export'), index: 1, durationSec: 1, analysis: null, audioEvidence: [], verification: null, overrides: [],
    sources: { title: {}, description: {}, filename: {} }, embedded: {}, engine: { ytdlp: null, ffmpeg: null },
    output: { sizeBytes: 6, format: 'mp3', bitrateKbps: null, sampleRate: null, channels: null },
    metadata: { title: 'Beat', producer: null, bpm: null, altBpm: null, key: null, camelot: null, detune: null, tuning: null, genre: null }
  }
  return { publish, library, input, downloadDir, staged }
}

test('publishing with a pending library save writes nothing to the download folder', async t => {
  const { publish, library, input, downloadDir, staged } = await publishFixture(t)
  library.pending = 3
  await assert.rejects(publish.publishExport(input), /library save is pending/i)
  assert.deepEqual(await fsp.readdir(downloadDir), [])
  assert.ok(fs.existsSync(staged))
  assert.equal(library.added.length, 0)
})

test('a name claimed by a concurrent export moves on to the next free name', async t => {
  const { publish, input, downloadDir } = await publishFixture(t, { hidden: ['Beat.mp3'] })
  await fsp.writeFile(path.join(downloadDir, 'Beat.mp3'), 'winner')
  const result = await publish.publishExport(input)
  assert.equal(result.fileName, 'Beat (2).mp3')
  assert.equal(await fsp.readFile(path.join(downloadDir, 'Beat.mp3'), 'utf8'), 'winner')
  assert.equal(await fsp.readFile(result.filePath, 'utf8'), 'export')
})

test('a failed library write reports a pending publication and keeps its files', async t => {
  const { publish, input, downloadDir } = await publishFixture(t, { addFails: 'pending' })
  const error = await publish.publishExport(input).then(() => null, failure => failure)
  assert.ok(error instanceof publish.PendingPublicationError)
  assert.equal(error.outputPath, path.join(downloadDir, 'Beat.mp3'))
  assert.deepEqual((await fsp.readdir(downloadDir)).sort(), ['Beat.mp3', 'Beat.mp3.sonic.json'])
})

test('a record rejected without a pending revision rolls its files back', async t => {
  const { publish, input, downloadDir } = await publishFixture(t, { addFails: 'plain' })
  const error = await publish.publishExport(input).then(() => null, failure => failure)
  assert.ok(error && !(error instanceof publish.PendingPublicationError))
  assert.deepEqual(await fsp.readdir(downloadDir), [])
})

// -------------------------------------------------------------- acquire

function loadAcquire(staging) {
  return loadSource('../src/main/services/acquire.ts', resolver({
    'node:fs/promises': fsp, 'node:path': path, '../lib/child': {}, '../lib/fsx': fsx, './engine': {}, './probe': {},
    './paths': { stagingDir: () => staging }, './settings': { settingsService: { get: () => ({}) } }
  }, 'acquire'))
}

test('a resumed job picks its real download, never partial conversion output or fragments', async t => {
  const staging = await profile(t, 'sonic-protect-staging-')
  const files = { 'job_ab.out.mp3': 'x'.repeat(4000), 'job_ab.webm.part': 'x'.repeat(5000), 'job_ab.webm.part-Frag3': 'x'.repeat(6000),
    'job_ab.f251.webm': 'x'.repeat(7000), 'job_ab.temp.webm': 'x'.repeat(7000), 'job_ab.webm.ytdl': 'x', 'job_ab.webm': 'x'.repeat(1000), 'job_abc.webm': 'x'.repeat(9000) }
  for (const [name, body] of Object.entries(files)) await fsp.writeFile(path.join(staging, name), body)
  const { findStagedFile } = loadAcquire(staging)
  assert.equal(await findStagedFile('job_ab'), path.join(staging, 'job_ab.webm'))
  await fsp.rm(path.join(staging, 'job_ab.webm'))
  assert.equal(await findStagedFile('job_ab'), null)
})

test('the staging sweep removes only orphaned jobs and idle partial outputs', async t => {
  const staging = await profile(t, 'sonic-protect-sweep-')
  for (const name of ['job_aa.out.mp3', 'job_aa.webm', 'job_bb.webm', 'job_bb.out.wav', 'job_cc.out.mp3', 'ffmpeg.zip']) await fsp.writeFile(path.join(staging, name), 'x')
  await fsp.mkdir(path.join(staging, 'reexport-123'))
  const { sweepStaging } = loadAcquire(staging)
  await sweepStaging(id => id === 'job_aa' || id === 'job_cc', id => id === 'job_cc')
  assert.deepEqual((await fsp.readdir(staging)).sort(), ['ffmpeg.zip', 'job_aa.webm', 'job_cc.out.mp3', 'reexport-123'])
})

// ---------------------------------------------------------------- queue

function job(id, patch = {}) {
  return {
    id, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', sourceKind: 'youtube', sourceTitle: 'Beat',
    sourceDescription: null, uploader: null, thumbnail: null, durationSec: 60, stage: 'ready', progress: 0, speed: null,
    eta: null, message: null, error: null, presetId: 'mp3-320', metadata: shared('metadata').createDraft({ declared: { title: 'Beat' } }),
    outputPath: null, libraryId: null, revision: 0, createdAt: 1, updatedAt: 1, ...patch
  }
}

async function queueFixture(t, jobs, options = {}) {
  const root = await profile(t, 'sonic-protect-queue-')
  const staging = path.join(root, 'staging')
  await fsp.mkdir(staging)
  for (const name of options.staged ?? []) await fsp.writeFile(path.join(staging, name), 'x')
  const queueFile = path.join(root, 'queue.json')
  await fsp.writeFile(queueFile, JSON.stringify({ version: 1, paused: true, concurrency: 1, jobs }))
  const storage = loadStorage(() => null)
  const calls = { acquire: 0, publish: 0 }
  const library = Object.assign(new EventEmitter(), {
    pending: null, records: new Map(),
    assertWritable() { if (this.pending !== null) throw new Error('A library save is pending. Retry saving before changing files or records.') },
    pendingRevision() { return this.pending }, get(id) { return this.records.get(id) ?? null }, list: () => [], scheduleRescan: () => undefined
  })
  class PendingPublicationError extends Error {
    constructor(outputPath, beatId) { super('Export files preserved; library save needs retry'); this.outputPath = outputPath; this.beatId = beatId }
  }
  const acquire = loadAcquire(staging)
  const { queueService } = loadSource('../src/main/services/queue.ts', resolver({
    'node:events': require('node:events'), 'node:path': path, '../lifecycle': { isStopping: () => false },
    '../analysis/service': { analysisService: { on: () => undefined, cancelPrefix: () => undefined, cancel: () => undefined } },
    '../lib/jsonStore': storage, '../lib/id': { createId: prefix => `${prefix}_1` }, '../lib/fsx': { sha256File: async () => 'f'.repeat(64) },
    './acquire': { ...acquire, acquireAudio: async id => { calls.acquire++; const file = path.join(staging, `${id}.webm`); await fsp.writeFile(file, 'src'); return { filePath: file, extension: 'webm', reused: false } } },
    './cover': { fetchCover: async () => null, forgetCover: async () => undefined, pruneCovers: async () => 0 }, './engine': { engineService: { resolve: async () => ({ version: null }) } },
    './ffprobe': { probeMediaFile: async () => ({ tags: {}, durationSec: 60, sizeBytes: 6, container: 'mp3', bitrateKbps: 320, audio: null }),
      readEmbeddedMetadata: async () => ({}), tagsToMetadata: () => ({}) },
    './library': { libraryService: library }, './paths': { queueFile: () => queueFile, stagingDir: () => staging },
    './probe': { probeUrl: async () => ({ error: 'unused' }) },
    './publish': { PendingPublicationError, buildTagContext: () => ({}), publishExport: async () => { calls.publish++; throw new PendingPublicationError(path.join(root, 'Beat.mp3'), 'beat_pending') } },
    './settings': { settingsService: { get: () => ({ skipExisting: false, analyzeOnDownload: false, embedThumbnail: false, channelMode: 'stereo', normalizeLufs: null, embedTags: true, rescanIntervalMs: 0, autoStart: false }) } },
    './transcode': { sourceExtensionFor: () => 'mp3', transcode: async () => undefined }
  }, 'queue'))
  t.after(async () => { await queueService.stopAll() })
  queueService.init()
  return { queue: queueService, library, storage, calls, staging }
}

const settled = async (queue, id, stage) => {
  for (let i = 0; i < 200 && queue.getJob(id).stage !== stage; i++) await delay(5)
  assert.equal(queue.getJob(id).stage, stage)
}

test('metadata edits are rejected once conversion has started or the export is complete', async t => {
  const stages = ['converting', 'tagging', 'publishing', 'complete']
  const { queue } = await queueFixture(t, [job('job_ready'), job('job_failed', { stage: 'failed' }), ...stages.map(stage => job(`job_${stage}`, { stage }))])
  for (const stage of stages) {
    const id = `job_${stage}`
    // Restored in-flight stages resume as queued; set the live stage directly.
    queue.getJob(id).stage = stage
    const before = JSON.stringify(queue.getJob(id).metadata)
    for (const patch of [{ metadataEdit: { field: 'title', value: 'Late' } }, { clearOverrides: ['title'] }, { adoptAnalyzed: ['bpm'] }]) {
      assert.throws(() => queue.updateJob(id, patch), /Library inspector/, `${stage} ${Object.keys(patch)[0]}`)
    }
    assert.equal(JSON.stringify(queue.getJob(id).metadata), before)
  }
  for (const id of ['job_ready', 'job_failed']) assert.equal(queue.updateJob(id, { metadataEdit: { field: 'title', value: 'Edited' } }).metadata.final.title, 'Edited')
})

test('a pending publication is finished by the library retry, never downloaded or exported again', async t => {
  const { queue, library, storage, calls } = await queueFixture(t, [job('job_ab', { stage: 'queued' })])
  queue.start(['job_ab'])
  await settled(queue, 'job_ab', 'failed')
  const failed = queue.getJob('job_ab')
  assert.equal(failed.libraryId, 'beat_pending')
  assert.ok(failed.outputPath.endsWith('Beat.mp3'))
  assert.equal(calls.publish, 1)
  assert.throws(() => queue.updateJob('job_ab', { metadataEdit: { field: 'title', value: 'Late' } }), /Library inspector/)

  library.pending = 4
  // The worker releases the job only after its staging cleanup settles.
  for (let i = 0; i < 200 && !/Retry saving the library/.test(queue.getJob('job_ab').error); i++) { queue.retry('job_ab'); await delay(5) }
  queue.start(['job_ab'])
  await delay(30)
  assert.equal(queue.getJob('job_ab').stage, 'failed')
  assert.match(queue.getJob('job_ab').error, /Retry saving the library/)
  assert.deepEqual(calls, { acquire: 1, publish: 1 })

  library.pending = null
  library.records.set('beat_pending', { id: 'beat_pending' })
  storage.storageEvents.emit('changed')
  assert.equal(queue.getJob('job_ab').stage, 'complete')
  assert.equal(queue.getJob('job_ab').message, 'Beat.mp3')
  assert.deepEqual(calls, { acquire: 1, publish: 1 })
})

test('a job does not start downloading while the library cannot record its export', async t => {
  const { queue, library, calls } = await queueFixture(t, [job('job_ab', { stage: 'queued' })])
  library.pending = 2
  queue.start(['job_ab'])
  await settled(queue, 'job_ab', 'failed')
  assert.match(queue.getJob('job_ab').error, /library save is pending/i)
  assert.equal(queue.getJob('job_ab').libraryId, null)
  assert.equal(calls.acquire, 0)
})

test('queue start sweeps leftovers of removed jobs and stale partial outputs', async t => {
  const { staging } = await queueFixture(t, [job('job_ab', { stage: 'failed' })], { staged: ['job_ab.out.mp3', 'job_ab.webm', 'job_ff.webm.part'] })
  for (let i = 0; i < 100 && fs.readdirSync(staging).length !== 1; i++) await delay(5)
  assert.deepEqual(fs.readdirSync(staging), ['job_ab.webm'])
})
