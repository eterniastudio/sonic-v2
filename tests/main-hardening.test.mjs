import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// Runs the checked-in sources with explicit dependency doubles; an unexpected
// import fails closed instead of loading Electron or a real service singleton.
function loadSource(relativePath, resolve, globals = {}) {
  const url = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    fileName: url.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    reportDiagnostics: true
  })
  const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? []
  assert.equal(errors.length, 0, errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  const module = { exports: {} }
  const names = Object.keys(globals)
  const factory = new Script(`(function(require, module, exports${names.map(name => `, ${name}`).join('')}) {\n${compiled.outputText}\n})`, { filename: url.pathname }).runInThisContext()
  factory(typeof resolve === 'function' ? resolve : name => {
    assert.ok(Object.hasOwn(resolve, name), `Unexpected dependency: ${name}`)
    return resolve[name]
  }, module, module.exports, ...names.map(name => globals[name]))
  return module.exports
}

const sharedModules = new Map()
function shared(name) {
  if (!sharedModules.has(name)) {
    const exports = {}
    sharedModules.set(name, exports)
    Object.assign(exports, loadSource(`../src/shared/${name}.ts`, dependency => {
      assert.ok(dependency.startsWith('./'), `Unexpected shared dependency: ${dependency}`)
      return shared(dependency.slice(2))
    }))
  }
  return sharedModules.get(name)
}

async function temporaryDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return directory
}

function loadStorage(overrides = {}) {
  return loadSource('../src/main/lib/jsonStore.ts', name => {
    if (name === 'node:fs') return { ...fs, ...overrides }
    assert.ok(['node:crypto', 'node:events', 'node:os', 'node:path'].includes(name), `Unexpected storage dependency: ${name}`)
    return require(name)
  })
}

function beat(id, patch = {}) {
  return {
    id, title: id, producer: null, bpm: null, altBpm: null, key: null, camelot: null,
    detune: null, presetId: 'original', format: 'wav', filePath: `/${id}.wav`, fileName: `${id}.wav`,
    fileOwnership: 'external', sidecarPath: null, sizeBytes: 12, durationSec: 1,
    bitrateKbps: null, sampleRate: null, channels: null, sourceUrl: null, sourceKind: 'local',
    addedAt: 1, fingerprint: id, missing: false, analysisStatus: 'not-analyzed',
    analysis: null, overrides: [], sources: { title: {}, description: {}, filename: {} },
    embedded: {}, verification: null, ...patch
  }
}

// ---------------------------------------------------------------- storage

test('commits are compact, legacy indented files still load, and the backup holds the previous commit', async t => {
  const directory = await temporaryDirectory(t, 'sonic-store-')
  const file = path.join(directory, 'library.json')
  await fsp.writeFile(file, JSON.stringify([{ id: 'legacy' }], null, 2))
  const { JsonStore } = loadStorage()
  const store = new JsonStore(file, [])
  assert.deepEqual(store.read(), [{ id: 'legacy' }])
  store.write([{ id: 'one' }])
  assert.equal(fs.readFileSync(file, 'utf8'), '[{"id":"one"}]')
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.backup`, 'utf8')), [{ id: 'legacy' }])
  store.write([{ id: 'two' }])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'two' }])
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.backup`, 'utf8')), [{ id: 'one' }])
  // The backup must survive a later in-place rewrite of the primary.
  assert.notEqual(fs.statSync(file).ino, fs.statSync(`${file}.backup`).ino)
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), [])
})

test('a volume without hard links still receives a full backup copy', async t => {
  const directory = await temporaryDirectory(t, 'sonic-store-nolink-')
  const file = path.join(directory, 'settings.json')
  let attempts = 0
  const { JsonStore } = loadStorage({ linkSync: () => { attempts++; throw Object.assign(new Error('not supported'), { code: 'EPERM' }) } })
  const store = new JsonStore(file, { value: 0 })
  store.write({ value: 1 })
  store.write({ value: 2 })
  assert.ok(attempts >= 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.backup`, 'utf8')), { value: 1 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: 2 })
})

test('a primary recovered from its backup is never linked over that good backup', async t => {
  const directory = await temporaryDirectory(t, 'sonic-store-recover-')
  const file = path.join(directory, 'library.json')
  await fsp.writeFile(`${file}.backup`, JSON.stringify([{ id: 'good' }]))
  await fsp.writeFile(file, '[{"id":"trunc')
  const { JsonStore } = loadStorage()
  const store = new JsonStore(file, [])
  assert.deepEqual(store.read(), [{ id: 'good' }])
  store.write([{ id: 'next' }])
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.backup`, 'utf8')), [{ id: 'good' }])
  assert.ok(fs.readdirSync(directory).some(name => name.includes('.damaged-')))
})

test('staged state stays in memory, rides along with the next commit, and respects a pending save', async t => {
  const directory = await temporaryDirectory(t, 'sonic-store-stage-')
  const file = path.join(directory, 'library.json')
  let failPrimary = false
  const storage = loadStorage({ renameSync: (from, to) => {
    if (failPrimary && to === file) throw new Error('injected replacement failure')
    return fs.renameSync(from, to)
  } })
  const store = new storage.JsonStore(file, [])
  store.write([{ id: 'a', status: 'idle' }])
  const committed = fs.readFileSync(file, 'utf8')
  const revision = storage.storageStatus()[0].revision
  store.stage([{ id: 'a', status: 'analyzing' }])
  assert.equal(store.read()[0].status, 'analyzing')
  assert.equal(fs.readFileSync(file, 'utf8'), committed)
  assert.equal(storage.storageStatus()[0].revision, revision)
  store.write([...store.read(), { id: 'b', status: 'idle' }])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(entry => entry.status), ['analyzing', 'idle'])
  // The backup is the previous durable commit, not the staged in-memory view.
  assert.equal(fs.readFileSync(`${file}.backup`, 'utf8'), committed)

  failPrimary = true
  assert.throws(() => store.write([{ id: 'c' }]), /injected replacement failure/)
  assert.throws(() => store.stage([{ id: 'd' }]), /must be retried/)
  failPrimary = false
  storage.retryStorage()
  assert.deepEqual(store.read(), [{ id: 'c' }])
})

// ---------------------------------------------------------------- library batching

async function libraryFixture(t, records) {
  const profile = await temporaryDirectory(t, 'sonic-library-batch-')
  const libraryFile = path.join(profile, 'library.json')
  await fsp.writeFile(libraryFile, JSON.stringify(records))
  const storage = loadStorage()
  const dependencies = {
    'node:crypto': require('node:crypto'), 'node:events': require('node:events'),
    'node:fs': fs, 'node:fs/promises': fsp, 'node:path': require('node:path'),
    '../lib/jsonStore': storage,
    '../lib/fileIdentity': loadSource('../src/main/lib/fileIdentity.ts', require),
    '../lib/fsx': { fileExists: async () => true, sha256File: async () => { throw new Error('Unexpected audio read') } },
    './paths': { libraryFile: () => libraryFile }, './settings': { settingsService: { get: () => ({ namingTemplate: '{title}' }) } },
    '../lifecycle': { isStopping: () => false }
  }
  const { libraryService } = loadSource('../src/main/services/library.ts', name => {
    if (name.startsWith('@shared/')) return shared(name.slice(8))
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected library dependency: ${name}`)
    return dependencies[name]
  })
  t.after(() => libraryService.shutdown())
  const revision = () => storage.storageStatus().find(entry => entry.file === path.resolve(libraryFile).toLowerCase()).revision
  return { library: libraryService, file: libraryFile, revision }
}

test('addMany commits a batch in one revision with the same result as sequential adds', async t => {
  const f = await libraryFixture(t, [beat('kept', { addedAt: 1 })])
  f.library.list()
  const before = f.revision()
  let changes = 0
  f.library.on('changed', () => changes++)
  f.library.addMany([beat('first', { addedAt: 2, sidecarPath: '/x.json' }), beat('second', { addedAt: 3 }), beat('first', { addedAt: 4, title: 'later' })])
  assert.equal(f.revision() - before, 1)
  assert.equal(changes, 1)
  const stored = JSON.parse(fs.readFileSync(f.file, 'utf8'))
  assert.deepEqual(stored.map(entry => entry.id), ['first', 'second', 'kept'])
  assert.equal(stored[0].title, 'later')
  assert.equal(stored[0].sidecarPath, null)
  const unchanged = f.revision()
  f.library.addMany([])
  assert.equal(f.revision(), unchanged)
})

test('queued and analyzing markers are not committed; settled statuses are', async t => {
  const f = await libraryFixture(t, [beat('a'), beat('b')])
  f.library.list()
  const before = f.revision()
  f.library.setAnalysisStatuses(['a', 'b'], 'queued')
  f.library.setAnalysisStatus('a', 'analyzing')
  assert.equal(f.revision(), before)
  assert.equal(f.library.get('a').analysisStatus, 'analyzing')
  assert.equal(f.library.get('b').analysisStatus, 'queued')
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).map(entry => entry.analysisStatus), ['not-analyzed', 'not-analyzed'])
  f.library.markAnalysisFailed('a')
  assert.equal(f.revision(), before + 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).map(entry => entry.analysisStatus), ['failed', 'queued'])
  f.library.restoreAnalysisStatuses(['b'])
  assert.equal(f.revision(), before + 2)
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8'))[1].analysisStatus, 'not-analyzed')
})

// ---------------------------------------------------------------- engine

function engineFixture({ files = new Set(), manifest, actualHash = 'a'.repeat(64), settings = {} } = {}) {
  const runs = [], downloads = [], removed = [], moves = []
  const engine = loadSource('../src/main/services/engine.ts', {
    'node:events': { EventEmitter },
    'node:fs': { chmodSync() {}, existsSync: file => files.has(file),
      readdirSync: () => ['ffmpeg.exe', 'ffprobe.exe'], statSync: () => ({ isFile: () => true, isDirectory: () => false }) },
    'node:path': path,
    '../lib/net': {
      fetchText: async url => { if (manifest instanceof Error) throw manifest; return typeof manifest === 'function' ? manifest(url) : manifest ?? '' },
      downloadToFile: async (...args) => { downloads.push(args) }
    },
    '../lib/child': { run: async (...args) => { runs.push(args); return { code: 0, aborted: false, timedOut: false, stdout: 'ffmpeg version 7.1-test Copyright', stderr: '' } } },
    '../lib/fsx': { ensureDir: async () => {}, removeDir: async () => {}, removeFile: async file => { removed.push(file) },
      sha256File: async () => actualHash, moveFile: async (...args) => { moves.push(args) } },
    './paths': { engineDir: () => 'C:\\fixture\\engine', stagingDir: () => 'C:\\fixture\\staging' },
    './settings': { settingsService: { get: () => ({ ytdlpPath: null, ffmpegPath: null, ffprobePath: null, ...settings }) } }
  }, { process: { platform: 'win32', env: {} } })
  return { engine, service: engine.engineService, runs, downloads, removed, moves }
}

test('checksum manifests match exact file names and verification fails closed', () => {
  const { engine } = engineFixture()
  const hash = 'ab'.repeat(32)
  const manifest = `${'cd'.repeat(32)}  ffmpeg-master-latest-win64-gpl-shared.zip\n${hash} *ffmpeg-master-latest-win64-gpl.zip\r\nnot-a-hash  other.zip`
  assert.equal(engine.parseChecksumManifest(manifest, 'ffmpeg-master-latest-win64-gpl.zip'), hash)
  assert.equal(engine.parseChecksumManifest(manifest, 'missing.zip'), null)
  assert.equal(engine.parseChecksumManifest(manifest, 'other.zip'), null)
  engine.verifyChecksum(hash.toUpperCase(), hash, 'FFmpeg')
  assert.throws(() => engine.verifyChecksum('ef'.repeat(32), hash, 'FFmpeg'), /FFmpeg download did not match its published checksum/)
  assert.throws(() => engine.verifyChecksum('', '', 'FFmpeg'), /did not match/)
})

test('FFmpeg setup requires the release checksum before downloading and verifies before extracting', async () => {
  const name = 'ffmpeg-master-latest-win64-gpl.zip'
  for (const manifest of [new Error('manifest unavailable'), '', `${'a'.repeat(64)}  ffmpeg-master-latest-win64-lgpl.zip`]) {
    const f = engineFixture({ manifest })
    await assert.rejects(f.service.installFfmpeg(), /checksum/)
    assert.equal(f.downloads.length, 0)
    assert.equal(f.runs.length, 0)
  }
  let requested = null
  const mismatch = engineFixture({ manifest: url => { requested = url; return `${'a'.repeat(64)}  ${name}` }, actualHash: 'b'.repeat(64) })
  await assert.rejects(mismatch.service.installFfmpeg(), /FFmpeg download did not match its published checksum/)
  assert.equal(requested, 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256')
  assert.equal(mismatch.downloads.length, 1)
  assert.equal(mismatch.runs.length, 0, 'an unverified archive is never extracted')
  assert.equal(mismatch.moves.length, 0)
  assert.ok(mismatch.removed.some(file => file.endsWith('ffmpeg.zip')))
  const accepted = engineFixture({ manifest: `${'a'.repeat(64)}  ${name}` })
  await accepted.service.installFfmpeg()
  assert.equal(accepted.runs.length, 1)
  assert.equal(accepted.moves.length, 2)
})

test('resolved tools are cached until invalidated, a setting changes, or the binary disappears', async () => {
  const managed = path.join('C:\\fixture\\engine', 'ffmpeg.exe')
  const files = new Set([managed])
  const settings = { ffmpegPath: null }
  const f = engineFixture({ files, settings })
  const first = await f.service.resolve('ffmpeg')
  assert.equal(first.path, managed)
  assert.equal(first.version, '7.1-test')
  for (let i = 0; i < 5; i++) assert.deepEqual(await f.service.resolve('ffmpeg'), first)
  assert.equal(f.runs.length, 1)
  f.service.invalidate()
  await f.service.resolve('ffmpeg')
  assert.equal(f.runs.length, 2)
  await f.service.resolve('ffmpeg', true)
  assert.equal(f.runs.length, 3)
  const explicit = 'D:\\tools\\ffmpeg.exe'
  files.add(explicit); settings.ffmpegPath = explicit
  assert.equal((await f.service.resolve('ffmpeg')).path, explicit)
  assert.equal(f.runs.length, 4)
  files.delete(explicit)
  assert.equal((await f.service.resolve('ffmpeg')).path, managed)
  assert.equal(f.runs.length, 5)
})

// ---------------------------------------------------------------- playback identity

test('playback identity hashes once per unchanged file and again after any change', async () => {
  const stamps = { size: 10, mtimeMs: 1, ino: 7, dev: 1 }
  let hashes = 0, changeDuringRead = false
  const current = () => ({ ...stamps, isFile: () => true, isSymbolicLink: () => false })
  const { playbackSessionService } = loadSource('../src/main/services/playbackSession.ts', {
    '../lib/jsonStore': { JsonStore: class { read() { return { schemaVersion: 1, lastTrackId: null, volume: 1, positions: [] } } } },
    'node:fs/promises': { lstat: async () => current() },
    './paths': { playbackSessionFile: () => '/unused/playback.json' },
    './library': { libraryService: { get: id => ({ id, filePath: `/audio/${id}.wav` }) } },
    '../lib/fsx': { sha256File: async () => { hashes++; if (changeDuringRead) stamps.mtimeMs++; return `${hashes}`.padStart(64, '0') } }
  })
  const first = await playbackSessionService.identity('a')
  const second = await playbackSessionService.identity('a')
  assert.equal(hashes, 1)
  assert.deepEqual(second, first)
  stamps.mtimeMs = 2
  const changed = await playbackSessionService.identity('a')
  assert.equal(hashes, 2)
  assert.notEqual(changed.fingerprint, first.fingerprint)
  stamps.ino = 8
  await playbackSessionService.identity('a')
  assert.equal(hashes, 3)
  changeDuringRead = true; stamps.size = 11
  await assert.rejects(playbackSessionService.identity('a'), /changed while Sonic checked it/)
  changeDuringRead = false
  await playbackSessionService.identity('a')
  assert.equal(hashes, 5, 'a file that changed mid-read is never served from the cache')
  await playbackSessionService.identity('b')
  assert.equal(hashes, 6)
})

// ---------------------------------------------------------------- covers

function coverFixture(directory, download) {
  return loadSource('../src/main/services/cover.ts', {
    'node:path': path, 'node:crypto': require('node:crypto'), 'node:fs/promises': fsp,
    '../lib/net': { downloadToFile: download },
    '../lib/fsx': { ensureDir: target => fsp.mkdir(target, { recursive: true }), removeFile: target => fsp.unlink(target).catch(() => undefined) },
    './paths': { coverCacheDir: () => directory }
  })
}
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])

test('covers are published atomically and a truncated cached JPEG is fetched again', async t => {
  const directory = await temporaryDirectory(t, 'sonic-covers-')
  let fail = false, downloads = 0
  const { fetchCover } = coverFixture(directory, async (_url, destination) => {
    downloads++
    await fsp.writeFile(destination, fail ? jpeg.subarray(0, 4) : jpeg)
    if (fail) throw new Error('connection reset')
  })
  fail = true
  assert.equal(await fetchCover('https://i.ytimg.com/a.jpg', 'job-1'), null)
  assert.deepEqual(await fsp.readdir(directory), [], 'an interrupted download leaves nothing behind')
  await fsp.writeFile(path.join(directory, 'job-1.jpg'), jpeg.subarray(0, 4))
  fail = false
  const target = await fetchCover('https://i.ytimg.com/a.jpg', 'job-1')
  assert.equal(target, path.join(directory, 'job-1.jpg'))
  assert.deepEqual(await fsp.readFile(target), jpeg)
  assert.equal(await fetchCover('https://i.ytimg.com/a.jpg', 'job-1'), target)
  assert.equal(downloads, 2)
  assert.equal(await fetchCover(null, 'job-2'), null)
})

test('pruning keeps live jobs and fresh partials and removes everything else', async t => {
  const directory = await temporaryDirectory(t, 'sonic-covers-prune-')
  const { pruneCovers } = coverFixture(directory, async () => assert.fail('Unexpected download'))
  for (const name of ['live.jpg', 'gone.jpg', 'other.jpg.part', 'fresh.1.jpg.part', 'notes.txt']) await fsp.writeFile(path.join(directory, name), jpeg)
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  await fsp.utimes(path.join(directory, 'other.jpg.part'), old, old)
  assert.equal(await pruneCovers(['live']), 2)
  assert.deepEqual((await fsp.readdir(directory)).sort(), ['fresh.1.jpg.part', 'live.jpg', 'notes.txt'])
  assert.equal(await coverFixture(path.join(directory, 'absent'), async () => {}).pruneCovers([]), 0)
})

// ---------------------------------------------------------------- smoke harness

test('the smoke harness is inert in packaged builds even when requested', () => {
  const load = isPackaged => loadSource('../src/main/smoke.ts', name => {
    if (name === 'electron') return { app: { isPackaged, getPath: () => '/unused' } }
    if (name === 'node:fs' || name === 'node:path') return require(name)
    return {}
  })
  const attached = []
  const window = { webContents: { on: event => attached.push(event), once: event => attached.push(event) } }
  const previous = process.env.SONIC_SMOKE_REPORT
  process.env.SONIC_SMOKE_REPORT = path.join(os.tmpdir(), 'sonic-smoke-never-written.json')
  try {
    load(true).installSmokeTest(window)
    assert.deepEqual(attached, [])
  } finally {
    if (previous === undefined) delete process.env.SONIC_SMOKE_REPORT
    else process.env.SONIC_SMOKE_REPORT = previous
  }
})
