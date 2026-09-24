import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

function beat(id, filePath) {
  return {
    id, title: id, producer: null, bpm: null, altBpm: null, key: null, camelot: null,
    detune: null, presetId: 'original', format: 'wav', filePath, fileName: path.basename(filePath),
    fileOwnership: 'external', sidecarPath: null, sizeBytes: 8, durationSec: 1,
    bitrateKbps: null, sampleRate: null, channels: null, sourceUrl: null, sourceKind: 'local',
    addedAt: Date.now(), fingerprint: 'test', missing: false, analysisStatus: 'not-analyzed',
    analysis: null, overrides: [], sources: { title: {}, description: {}, filename: {} },
    embedded: {}, verification: null
  }
}

async function run(entry, profile, phase) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [entry, `--user-data-dir=${profile}`, `--phase=${phase}`], { env, windowsHide: true })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Organization process stuck: ${stdout}\n${stderr}`)) }, 20_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

test('annotations and collections commit once, retry failed revision, and survive restart without audio writes', { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'sonic-organization-test-'))
  const audioA = path.join(profile, 'external-a.wav')
  const audioB = path.join(profile, 'external-b.wav')
  await writeFile(audioA, 'ORIGINAL-A')
  await writeFile(audioB, 'ORIGINAL-B')
  const fixtures = [beat('beat-a', audioA), beat('beat-b', audioB)]
  for (let i = 2; i < 5000; i++) fixtures.push({ ...beat(`beat-${i}`, path.join(profile, `virtual-${i}.wav`)), missing: true })
  await writeFile(path.join(profile, 'library.json'), JSON.stringify(fixtures))
  const entry = path.join(profile, 'organization-test.cjs')
  await build({
    stdin: { contents: `
      import { app } from 'electron'
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { organizationService } from './src/main/services/organization'
      import { retryStorage, storageStatus } from './src/main/lib/jsonStore'
      import { validateOrganizationCommand } from './src/shared/organization'
      app.whenReady().then(() => {
        const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8)
        console.log('PHASE', phase)
        if (phase === 'write') {
          assert.equal(organizationService.snapshot().collections.length, 0)
          assert.equal(validateOrganizationCommand({ type: 'set-annotation', beatId: 'beat-a', favorite: 'yes' }), false)
          assert.equal(validateOrganizationCommand({ type: 'create-smart', name: 'bad', rules: { version: 1, arbitrary: 'js' } }), false)
          assert.equal(validateOrganizationCommand({ type: 'create-smart', name: 'bad ownership', rules: { version: 1, fileOwnership: 'user-file' } }), false)
          assert.equal(validateOrganizationCommand({ type: 'create-smart', name: 'imports', rules: { version: 1, sourceKind: 'local', fileOwnership: 'external' } }), true)
          const first = organizationService.execute({ type: 'set-annotation', beatId: 'beat-a', tags: [' Dark ', 'dark', 'For Vocals'], notes: 'Hook at 0:48\\nTry half time' })
          assert.deepEqual(first.annotations['beat-a'].tags, ['Dark', 'For Vocals'])
          const manual = organizationService.execute({ type: 'create-manual', name: 'Next Single', beatIds: ['beat-a', 'beat-b'] }).collections[0]
          assert.deepEqual(manual.beatIds, ['beat-a', 'beat-b'])
          const secondManual = organizationService.execute({ type: 'create-manual', name: 'Other project', beatIds: ['beat-a'] }).collections[1]
          assert.deepEqual(secondManual.beatIds, ['beat-a'])
          assert.throws(() => organizationService.execute({ type: 'reorder-members', id: manual.id, beatIds: ['beat-a'] }), /every current member/)
          organizationService.execute({ type: 'reorder-members', id: manual.id, beatIds: ['beat-b', 'beat-a'] })
          const smart = organizationService.execute({ type: 'create-smart', name: 'Fast favorites', rules: { version: 1, favorite: true, bpmMin: 130, bpmMax: 150 } }).collections[2]
          organizationService.execute({ type: 'update-smart', id: smart.id, rules: { version: 1, favorite: true, sourceKind: 'local', fileOwnership: 'external' } })
          organizationService.execute({ type: 'set-view', activeCollectionId: manual.id, layout: 'list', sort: 'manual' })
          const originalRename = fs.renameSync
          fs.renameSync = (from, to) => { if (to.endsWith('organization.json')) throw Object.assign(new Error('injected replacement failure'), { code: 'EACCES' }); return originalRename(from, to) }
          assert.throws(() => organizationService.execute({ type: 'batch-annotation', beatIds: ['beat-a', 'beat-b'], favorite: true, tagsAdd: ['Reviewed'] }), /injected replacement failure/)
          assert.equal(organizationService.snapshot().annotations['beat-a'].favorite, false)
          assert.equal(storageStatus().find(item => item.file.endsWith('organization.json')).error !== null, true)
          assert.throws(() => organizationService.execute({ type: 'set-annotation', beatId: 'beat-a', notes: 'different revision' }), /Unsaved revision/)
          fs.renameSync = originalRename
          retryStorage()
          assert.equal(organizationService.snapshot().annotations['beat-a'].favorite, true)
          assert.equal(organizationService.snapshot().annotations['beat-b'].favorite, true)
          const allIds = ['beat-a', 'beat-b', ...Array.from({ length: 4998 }, (_, i) => 'beat-' + (i + 2))]
          organizationService.execute({ type: 'batch-annotation', beatIds: allIds, tagsAdd: ['Large Batch'] })
          assert.equal(Object.keys(organizationService.snapshot().annotations).length, 5000)
          console.log('ORGANIZATION_WRITE_PASS')
        } else if (phase === 'recover') {
          const restored = organizationService.snapshot()
          assert.equal(restored.schemaVersion, 1)
          assert.equal(restored.annotations['beat-a'].favorite, true)
          assert.ok(fs.readdirSync(app.getPath('userData')).some(name => name.startsWith('organization.json.damaged-')))
          console.log('ORGANIZATION_RECOVER_PASS')
        } else {
          const restored = organizationService.snapshot()
          assert.equal(restored.annotations['beat-a'].favorite, true)
          assert.deepEqual(restored.annotations['beat-b'].tags, ['Reviewed', 'Large Batch'])
          assert.equal(restored.annotations['beat-a'].notes, 'Hook at 0:48\\nTry half time')
          assert.equal(restored.collections.length, 3)
          assert.deepEqual(restored.collections[0].beatIds, ['beat-b', 'beat-a'])
          assert.deepEqual(restored.collections[1].beatIds, ['beat-a'])
          assert.equal(restored.collections[2].rules.sourceKind, 'local')
          assert.equal(restored.collections[2].rules.fileOwnership, 'external')
          assert.equal(restored.annotations['beat-4999'].tags[0], 'Large Batch')
          assert.equal(restored.view.activeCollectionId, restored.collections[0].id)
          organizationService.execute({ type: 'delete', id: restored.collections[0].id })
          assert.equal(organizationService.snapshot().view.activeCollectionId, null)
          assert.equal(organizationService.snapshot().annotations['beat-a'].favorite, true)
          console.log('ORGANIZATION_REOPEN_PASS')
        }
      }).then(() => app.quit(), error => { console.error(error); app.exit(1) })
    `, resolveDir: process.cwd(), sourcefile: 'organization-service.ts', loader: 'ts' },
    outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    alias: { '@shared': path.resolve('src/shared') }
  })
  const written = await run(entry, profile, 'write')
  assert.equal(written.code, 0, `${written.stdout}\n${written.stderr}`)
  assert.match(written.stdout, /ORGANIZATION_WRITE_PASS/)
  const reopened = await run(entry, profile, 'reopen')
  assert.equal(reopened.code, 0, `${reopened.stdout}\n${reopened.stderr}`)
  assert.match(`${reopened.stdout}\n${reopened.stderr}`, /ORGANIZATION_REOPEN_PASS/)
  await writeFile(path.join(profile, 'organization.json'), '{ truncated')
  const recovered = await run(entry, profile, 'recover')
  assert.equal(recovered.code, 0, `${recovered.stdout}\n${recovered.stderr}`)
  assert.match(recovered.stdout, /ORGANIZATION_RECOVER_PASS/)
  assert.equal(await readFile(audioA, 'utf8'), 'ORIGINAL-A')
  assert.equal(await readFile(audioB, 'utf8'), 'ORIGINAL-B')
})
