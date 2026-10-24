import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// Run the actual library and storage sources. Only media/filesystem observations
// are controlled; commits use a fresh temporary profile for every test.
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

async function fixture(t, records, options = {}) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sonic-library-storage-'))
  const libraryFile = path.join(profile, 'library.json')
  await fsp.writeFile(libraryFile, JSON.stringify(records))
  let failReplacement = false
  const storage = loadSource('../src/main/lib/jsonStore.ts', name => {
    if (name === 'node:fs') return { ...fs, renameSync: (from, to) => {
      if (failReplacement && to === libraryFile) throw Object.assign(new Error('injected replacement failure'), { code: 'EACCES' })
      return fs.renameSync(from, to)
    } }
    assert.ok(['node:crypto', 'node:events', 'node:os', 'node:path'].includes(name), `Unexpected storage dependency: ${name}`)
    return require(name)
  })
  const dependencies = {
    'node:crypto': require('node:crypto'), 'node:events': require('node:events'),
    'node:fs': fs, 'node:fs/promises': { ...fsp, stat: options.stat ?? (async () => ({ isFile: () => true, size: 12 })) },
    'node:path': require('node:path'),
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
  t.after(async () => {
    await libraryService.shutdown()
    await fsp.rm(profile, { recursive: true, force: true })
  })
  return { library: libraryService, storage, file: libraryFile,
    setFailure: value => { failReplacement = value },
    readCommitted: () => new storage.JsonStore(libraryFile, [], value => value).read() }
}

test('library views sort/index once, preserve caller array isolation, and refresh after writes and storage retries', async t => {
  const { library, storage, file, setFailure } = await fixture(t, [
    beat('older', { addedAt: 1 }), beat('newer', { addedAt: 2 }), beat('middle', { addedAt: 1.5 })
  ])
  let idReads = 0, dateReads = 0
  // Committed records are frozen once loaded, so instrument them as they load.
  new storage.JsonStore(file, [], records => {
    for (const record of records) {
      const id = record.id, addedAt = record.addedAt
      Object.defineProperties(record, {
        id: { enumerable: true, get: () => { idReads++; return id } },
        addedAt: { enumerable: true, get: () => { dateReads++; return addedAt } }
      })
    }
    return records
  }).read()
  assert.deepEqual(library.list().map(record => record.title), ['newer', 'middle', 'older'])
  assert.ok(idReads > 0 && dateReads > 0)
  idReads = 0; dateReads = 0
  const callerCopy = library.list()
  callerCopy.reverse(); callerCopy.pop()
  for (let i = 0; i < 100; i++) {
    assert.equal(library.get('middle').title, 'middle')
    assert.deepEqual(library.list().map(record => record.title), ['newer', 'middle', 'older'])
  }
  assert.equal(idReads, 0, 'repeated lookups should use the ID index')
  assert.equal(dateReads, 0, 'unchanged revisions should not be sorted again')
  library.update('older', { title: 'committed edit', addedAt: 3 })
  assert.equal(library.get('older').title, 'committed edit')
  assert.equal(library.list()[0].id, 'older')
  setFailure(true)
  assert.throws(() => library.update('middle', { title: 'retried edit', addedAt: 4 }), /injected replacement failure/)
  assert.equal(library.get('middle').title, 'middle')
  assert.equal(library.list()[0].id, 'older')
  setFailure(false)
  storage.retryStorage()
  assert.equal(library.get('middle').title, 'retried edit')
  assert.equal(library.list()[0].id, 'middle')
  assert.equal((await library.remove('middle', false)).ok, true)
  assert.equal(library.get('middle'), null)
  assert.equal(library.list().length, 2)
})

test('rescans share in-flight work and bound concurrency to eight with one stat per record', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let active = 0, maximum = 0, calls = 0
  const { library } = await fixture(t, Array.from({ length: 40 }, (_, i) => beat(`beat-${i}`)), {
    stat: async () => {
      calls++; active++; maximum = Math.max(maximum, active)
      await gate
      await nextTurn()
      active--
      return { isFile: () => true, size: 20 }
    }
  })
  const first = library.rescan()
  try {
    assert.equal(library.rescan(), first)
    await nextTurn()
    assert.equal(calls, 8)
  } finally { release() }
  await first
  assert.equal(calls, 40)
  assert.equal(maximum, 8)
  assert.ok(library.list().every(record => record.sizeBytes === 20 && !record.missing))
  const second = library.rescan()
  assert.notEqual(second, first)
  await second
  assert.equal(calls, 80)
})

test('rescans and purge preserve inaccessible records while handling proven absence and zero-byte files', async t => {
  const errors = []
  const records = [
    beat('ENOENT'), beat('ENOTDIR'), beat('EACCES'), beat('EBUSY'), beat('ENETDOWN'),
    beat('empty', { missing: true }), beat('folder')
  ]
  const { library } = await fixture(t, records, { stat: async file => {
    const code = path.parse(file).name
    if (code.startsWith('E')) throw Object.assign(new Error(`injected ${code}`), { code })
    return { isFile: () => code !== 'folder', size: 0 }
  } })
  library.on('storage-error', message => errors.push(message))
  await library.rescan()
  assert.equal(library.get('ENOENT').missing, true)
  assert.equal(library.get('ENOTDIR').missing, true)
  for (const id of ['EACCES', 'EBUSY', 'ENETDOWN']) {
    assert.equal(library.get(id).missing, false)
    assert.equal(library.get(id).sizeBytes, 12)
  }
  assert.equal(library.get('empty').missing, false)
  assert.equal(library.get('empty').sizeBytes, 0)
  assert.equal(library.get('folder').missing, true)
  await library.purgeMissing()
  assert.equal(library.get('ENOENT'), null)
  assert.equal(library.get('ENOTDIR'), null)
  for (const id of ['EACCES', 'EBUSY', 'ENETDOWN', 'empty', 'folder']) assert.ok(library.get(id))
  assert.equal(errors.length, 2, 'emit one combined failure message per scan')
  assert.match(errors[0], /3 library file\(s\).*kept/)
})

test('a held rescan preserves metadata edits, moved records, removals, and additions', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { library } = await fixture(t, [beat('edited'), beat('moved'), beat('removed')], {
    stat: async () => { await gate; return { isFile: () => true, size: 24 } }
  })
  const scan = library.rescan()
  try {
    await library.updateMetadata('edited', { title: 'Manual correction', bpm: 151 })
    library.update('moved', { filePath: '/new-location.wav', sizeBytes: 99 })
    await library.remove('removed', false)
    library.add(beat('added', { sizeBytes: 77 }))
  } finally { release() }
  await scan
  assert.equal(library.get('edited').title, 'Manual correction')
  assert.equal(library.get('edited').bpm, 151)
  assert.ok(library.get('edited').overrides.includes('bpm'))
  assert.equal(library.get('edited').sizeBytes, 24)
  assert.equal(library.get('moved').filePath, '/new-location.wav')
  assert.equal(library.get('moved').sizeBytes, 99)
  assert.equal(library.get('removed'), null)
  assert.equal(library.get('added').sizeBytes, 77)
})

test('purge keeps a record whose metadata changed while absence was being checked', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { library } = await fixture(t, [beat('edited')], { stat: async () => {
    await gate
    throw Object.assign(new Error('injected missing file'), { code: 'ENOENT' })
  } })
  const purge = library.purgeMissing()
  try { await library.updateMetadata('edited', { title: 'Keep this correction', bpm: 151 }) }
  finally { release() }
  await purge
  assert.equal(library.get('edited').title, 'Keep this correction')
  assert.equal(library.get('edited').bpm, 151)
})

test('a failed scan commit releases its shared task and succeeds after storage retry', async t => {
  const { library, storage, setFailure } = await fixture(t, [beat('edited')], {
    stat: async () => ({ isFile: () => true, size: 24 })
  })
  setFailure(true)
  const failed = library.rescan()
  await assert.rejects(failed, /injected replacement failure/)
  assert.equal(library.get('edited').sizeBytes, 12)
  setFailure(false)
  storage.retryStorage()
  const retried = library.rescan()
  assert.notEqual(retried, failed)
  await retried
  assert.equal(library.get('edited').sizeBytes, 24)
})

test('an offline root is reported as unavailable, never purged as missing', async t => {
  const root = path.parse(process.cwd()).root
  const records = [beat('offline', { filePath: path.join(root, 'missing-drive-fixture', 'offline.wav') })]
  const { library } = await fixture(t, records, { stat: async () => {
    throw Object.assign(new Error('injected offline volume'), { code: 'ENOENT' })
  } })
  await library.rescan()
  assert.equal(library.get('offline').missing, false)
  assert.match(library.get('offline').fileAccessError, /drive or network share is unavailable/)
  await library.purgeMissing()
  assert.ok(library.get('offline'))
})

test('SoundCloud provenance and artwork survive library persistence and normalization', async t => {
  const source = { sourceKind: 'soundcloud', sourceUrl: 'https://soundcloud.com/producer/beat', sourceChannel: 'Producer', thumbnail: 'https://i1.sndcdn.com/art.jpg' }
  const { library, readCommitted } = await fixture(t, [beat('soundcloud', source)])
  for (const [key, value] of Object.entries(source)) assert.equal(library.get('soundcloud')[key], value)
  library.update('soundcloud', { title: 'Updated title' })
  const saved = readCommitted().find(item => item.id === 'soundcloud')
  for (const [key, value] of Object.entries(source)) assert.equal(saved[key], value)
})
