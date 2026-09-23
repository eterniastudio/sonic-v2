import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = path.resolve('test-results/ownership-import')

test('external imports stay library-only while legacy exports keep owned-file deletion', { timeout: 30_000 }, async () => {
  await mkdir(root, { recursive: true })
  const profile = await mkdtemp(path.join(root, 'profile-'))
  const externalPath = path.join(profile, 'user-audio', 'original.wav')
  const malformedPath = path.join(profile, 'user-audio', 'malformed.wav')
  const legacyPath = path.join(profile, 'exports', 'legacy.wav')
  const sentinelPath = path.join(profile, 'user-audio', 'original.wav.sonic.json')
  await mkdir(path.dirname(externalPath), { recursive: true })
  await mkdir(path.dirname(legacyPath), { recursive: true })
  const externalBytes = Buffer.from('An external test file; these bytes must survive.')
  const malformedBytes = Buffer.from('An external file with an unknown ownership marker.')
  const legacyBytes = Buffer.from('A Sonic-owned test export.')
  await writeFile(externalPath, externalBytes)
  await writeFile(malformedPath, malformedBytes)
  await writeFile(legacyPath, legacyBytes)
  await writeFile(sentinelPath, 'user-owned sentinel')
  const beat = (id, filePath, bytes) => ({
    id, title: id, producer: null, bpm: null, altBpm: null, key: null, camelot: null,
    detune: null, presetId: 'original', format: 'wav', filePath,
    fileName: path.basename(filePath), sidecarPath: null,
    sizeBytes: bytes.length, durationSec: 1, bitrateKbps: null, sampleRate: null,
    channels: null, sourceUrl: null, sourceKind: 'unknown', addedAt: Date.now(),
    fingerprint: createHash('sha256').update(bytes).digest('hex'), missing: false,
    analysisStatus: 'not-analyzed', analysis: null, overrides: [],
    sources: { title: {}, description: {}, filename: {} }, embedded: {}, verification: null
  })
  await writeFile(path.join(profile, 'library.json'), JSON.stringify([
    { ...beat('external', externalPath, externalBytes), fileOwnership: 'external', sidecarPath: sentinelPath },
    { ...beat('malformed', malformedPath, malformedBytes), fileOwnership: 'obsolete-external-value', sidecarPath: sentinelPath },
    beat('legacy', legacyPath, legacyBytes)
  ]))

  const entry = path.join(profile, 'ownership-test.cjs')
  await build({
    stdin: { contents: `
      import { app } from 'electron'
      import assert from 'node:assert/strict'
      import { readFile, readdir, stat } from 'node:fs/promises'
      import path from 'node:path'
      import { libraryService } from './src/main/services/library'
      import { sha256File } from './src/main/lib/fsx'

      app.whenReady().then(async () => {
        const profile = app.getPath('userData')
        const original = path.join(profile, 'user-audio', 'original.wav')
        const malformedFile = path.join(profile, 'user-audio', 'malformed.wav')
        const sentinel = path.join(profile, 'user-audio', 'original.wav.sonic.json')
        const legacyFile = path.join(profile, 'exports', 'legacy.wav')
        const external = libraryService.get('external')
        assert.equal(external.fileOwnership, 'external')
        assert.equal(external.sidecarPath, null)
        assert.equal(libraryService.get('malformed').fileOwnership, 'external')
        assert.equal(libraryService.get('malformed').sidecarPath, null)
        assert.equal(libraryService.get('legacy').fileOwnership, 'sonic-export')
        const initialHash = await sha256File(original)
        const initialFiles = await readdir(path.dirname(original))
        await libraryService.updateMetadata('external', { title: 'Corrected', bpm: 145, key: 'A minor' })
        const corrected = libraryService.get('external')
        assert.equal(corrected.filePath, original)
        assert.equal(corrected.fileName, 'original.wav')
        assert.equal(corrected.bpm, 145)
        const analysis = {
          engine: 'ownership-test', inputId: initialHash, inputName: 'original.wav',
          analyzedAt: Date.now(), analyzedSeconds: 1, sampleRate: 44100,
          channels: 2, durationSec: 1,
          tempo: { status: 'estimated', bpm: 140, bpmExact: 140, alternatives: [], confidence: .9, warning: null },
          key: { status: 'inconclusive', key: null, camelot: null, alternatives: [], confidence: null, tuningCents: null, warning: null },
          warnings: []
        }
        await libraryService.applyAnalysis('external', analysis)
        const analyzed = libraryService.get('external')
        assert.equal(analyzed.analysis.inputId, initialHash)
        assert.equal(analyzed.bpm, 145)
        assert.equal(analyzed.filePath, original)
        assert.equal(analyzed.sidecarSync, undefined)
        assert.deepEqual(await readdir(path.dirname(original)), initialFiles)
        assert.equal(await sha256File(original), initialHash)
        assert.equal(await readFile(sentinel, 'utf8'), 'user-owned sentinel')
        const refused = await libraryService.remove('external', true)
        assert.equal(refused.ok, false)
        assert.match(refused.reason, /externally owned/i)
        assert.ok(await stat(original))
        assert.ok(libraryService.get('external'))
        assert.equal((await libraryService.remove('external', false)).ok, true)
        assert.ok(await stat(original))
        assert.equal(libraryService.get('external'), null)
        const malformedRefusal = await libraryService.remove('malformed', true)
        assert.equal(malformedRefusal.ok, false)
        assert.match(malformedRefusal.reason, /externally owned/i)
        assert.ok(await stat(malformedFile))
        assert.equal((await libraryService.remove('malformed', false)).ok, true)
        assert.ok(await stat(malformedFile))
        assert.equal((await libraryService.remove('legacy', true)).ok, true)
        await assert.rejects(stat(legacyFile), { code: 'ENOENT' })
        assert.equal(libraryService.get('legacy'), null)
        assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8')), [])
        console.log('OWNERSHIP_PASS')
      }).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => app.quit())
    `, resolveDir: process.cwd(), sourcefile: 'ownership-service.ts', loader: 'ts' },
    outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    alias: { '@shared': path.resolve('src/shared') }
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [entry, `--user-data-dir=${profile}`],
      { env, windowsHide: true })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Ownership service did not close in 15 seconds. ${stdout}\n${stderr}`))
    }, 15_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }) })
  })
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /OWNERSHIP_PASS/)
  assert.equal(createHash('sha256').update(await readFile(externalPath)).digest('hex'),
    createHash('sha256').update(externalBytes).digest('hex'))
  assert.deepEqual(await readdir(path.dirname(externalPath)), ['malformed.wav', 'original.wav', 'original.wav.sonic.json'])
  assert.equal(createHash('sha256').update(await readFile(malformedPath)).digest('hex'),
    createHash('sha256').update(malformedBytes).digest('hex'))
})
