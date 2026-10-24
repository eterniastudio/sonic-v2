import { test, expect } from '@playwright/test'
import { readFile, writeFile, mkdir, rename, rmdir, copyFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp, captureOwnedProcesses, crashOwnedApp } from './app-lifecycle.mjs'

let app, page, root, beats, rendererErrors
const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.sonic.invoke(c, ...a), [channel, args])
const disk = name => readFile(path.join(root, name), 'utf8').then(JSON.parse)
const currentBeat = async id => (await invoke('library:list')).find(beat => beat.id === id)

test.beforeEach(async ({}, info) => {
  app = null; page = null; rendererErrors = []
  root = await createOwnedProfile(info)
  beats = await fixtures(root, info.title.includes('active analysis') ? 600 : 180, { sidecars: true })
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => rendererErrors.push(error.message))
})

test.afterEach(async ({}, info) => {
  await closeOwnedApp(app, page, info)
  expect(rendererErrors).toEqual([])
})

async function reopen(info) {
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => rendererErrors.push(error.message))
}

async function correctQueueMetadata() {
  for (const [field, value] of [['bpm', 139], ['key', 'F# minor'], ['producer', 'Fixture producer'], ['producer', null]]) {
    await invoke('queue:updateJob', 'job-1', { metadataEdit: { field, value } })
  }
}

async function verifySaved(beatId, bpm, ids) {
  expect((await invoke('settings:get')).defaultPresetId).toBe('flac')
  expect((await currentBeat(beatId)).bpm).toBe(bpm)
  expect((await currentBeat(beatId)).key).toBe('F# minor')
  expect((await currentBeat(beatId)).camelot).toBe('11A')
  expect((await invoke('queue:snapshot')).jobs.map(job => job.id)).toEqual(ids)
  const queueJob = (await invoke('queue:snapshot')).jobs.find(job => job.id === 'job-1')
  expect(queueJob.metadata.final.bpm).toBe(139)
  expect(queueJob.metadata.final.key).toBe('F# minor')
  expect(queueJob.metadata.final.camelot).toBe('11A')
  expect(queueJob.metadata.final.producer).toBeNull()
  expect(queueJob.metadata.overrides).toEqual(expect.arrayContaining(['bpm', 'key', 'producer']))
  expect((await disk('settings.json')).defaultPresetId).toBe('flac')
  const stored = (await disk('library.json')).find(beat => beat.id === beatId)
  expect(stored.bpm).toBe(bpm)
  expect(stored.overrides).toEqual(expect.arrayContaining(['bpm', 'key']))
  expect((await disk('queue.json')).jobs.map(job => job.id)).toEqual(ids)
  expect((await disk('queue.json')).jobs.find(job => job.id === 'job-1').metadata.final).toEqual(queueJob.metadata.final)
  const sidecar = JSON.parse(await readFile(stored.sidecarPath, 'utf8'))
  expect(sidecar.metadata.bpm).toBe(bpm)
  expect(sidecar.metadata.key).toBe('F# minor')
  expect(sidecar.metadata.camelot).toBe('11A')
}

for (const [cycle, lastChange] of ['settings', 'correction', 'active analysis'].entries()) {
  test(`normal close/reopen cycle ${cycle + 1}: ${lastChange}`, async ({}, info) => {
    const beatId = beats[0].id, bpm = 131 + cycle
    const originalIds = (await invoke('queue:snapshot')).jobs.map(job => job.id)
    const intendedOrder = [...originalIds].reverse()
    await invoke('settings:patch', { defaultPresetId: 'flac' })
    await invoke('library:updateMetadata', beatId, { bpm, key: 'F# minor' })
    await correctQueueMetadata()
    for (let index = 0; index < 12; index++) await invoke('queue:reorder', index % 2 ? intendedOrder : originalIds)
    if (lastChange === 'active analysis') {
      await page.getByRole('button', { name: /Library/ }).first().click()
      await page.locator(`[data-beat-id="${beatId}"]`).click()
      await expect(page.locator('[data-preview-state]')).toHaveAttribute('data-preview-state', 'inspecting')
      await page.getByRole('button', { name: 'Play this beat', exact: true }).click()
      await expect(page.locator('[data-playback-dock]')).toHaveAttribute('data-playback-state', 'playing')
      await page.getByRole('button', { name: 'Analyze audio', exact: true }).click()
      await expect.poll(async () => (await invoke('analysis:status')).running).toBeGreaterThan(0)
      // One analysis can finish during the OS process snapshot. Queue the
      // remaining real fixtures so close still exercises active and waiting work.
      expect((await invoke('analysis:queueMissing')).queued).toBe(beats.length - 1)
      await captureOwnedProcesses(app)
      await invoke('queue:reorder', intendedOrder)
      expect((await invoke('analysis:status')).running).toBeGreaterThan(0)
      await writeFile(info.outputPath('workload-at-close.json'), JSON.stringify({ generatedAudioSeconds: 600, analysisBeatIds: beats.map(beat => beat.id), preview: 'playing', analysisRunning: true, queueOrder: intendedOrder, repeatedCloseRequests: 3 }, null, 2))
    } else if (lastChange === 'settings') {
      await invoke('settings:patch', { defaultPresetId: 'flac', accent: 'cyan' })
    } else {
      await invoke('library:updateMetadata', beatId, { bpm, key: 'F# minor' })
    }
    // No sleep or renderer-only assertion between the acknowledged last save
    // and normal close. The same profile is reopened in a new app process.
    await closeOwnedApp(app, page, info, { repeated: true, capture: false })
    await reopen(info)
    await verifySaved(beatId, bpm, intendedOrder)
    if (lastChange === 'settings') expect((await invoke('settings:get')).accent).toBe('cyan')
    if (lastChange === 'active analysis') {
      expect((await invoke('analysis:status')).running).toBe(0)
      expect((await invoke('analysis:status')).queued).toBe(0)
      for (const beat of await invoke('library:list')) {
        expect(['analyzing', 'queued']).not.toContain(beat.analysisStatus)
      }
    }
    await writeFile(info.outputPath('restored.json'), JSON.stringify({ settings: await invoke('settings:get'), beat: await currentBeat(beatId), queue: await invoke('queue:snapshot') }, null, 2))
  })
}

test('injected invalid sidecar destination preserves analysis and correction, retries synchronization, and reopens', async ({}, info) => {
  const beat = beats[0]
  const savedPath = `${beat.sidecarPath}.test-saved`
  await rename(beat.sidecarPath, savedPath)
  await mkdir(beat.sidecarPath)
  let restored = false
  try {
    await page.getByRole('button', { name: /Library/ }).first().click()
    await page.locator(`[data-beat-id="${beat.id}"]`).click()
    await page.getByRole('button', { name: 'Analyze audio', exact: true }).click()
    await expect.poll(async () => (await invoke('analysis:status')).running).toBeGreaterThan(0)
    const corrected = await invoke('library:updateMetadata', beat.id, { bpm: 137, key: 'F# minor' })
    expect(corrected.bpm).toBe(137)
    expect(corrected.sidecarSync.status).toBe('error')
    await expect.poll(async () => (await invoke('analysis:status')).running, { timeout: 90000 }).toBe(0)
    const analyzed = await currentBeat(beat.id)
    expect(analyzed.analysis).not.toBeNull()
    expect(analyzed.analysisStatus).not.toBe('failed')
    expect(analyzed.sidecarSync.status).toBe('error')
    await expect(page.getByRole('alert').filter({ hasText: 'sidecar(s) need synchronization' })).toBeVisible()
    expect(analyzed.bpm).toBe(137)
    expect(analyzed.key).toBe('F# minor')
    const originalAnalysis = analyzed.analysis
    await rmdir(beat.sidecarPath)
    await rename(savedPath, beat.sidecarPath)
    restored = true
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click()
    await expect.poll(async () => (await currentBeat(beat.id)).sidecarSync.status).toBe('synced')
    const retried = await currentBeat(beat.id)
    expect(retried.sidecarSync.status).toBe('synced')
    await expect(page.getByRole('alert').filter({ hasText: 'sidecar(s) need synchronization' })).toHaveCount(0)
    expect(retried.analysis).toEqual(originalAnalysis)
    const sidecar = JSON.parse(await readFile(beat.sidecarPath, 'utf8'))
    expect(sidecar.metadata.bpm).toBe(137)
    expect(sidecar.metadata.key).toBe('F# minor')
    expect(sidecar.metadata.camelot).toBe('11A')
    expect(sidecar.analysis).toEqual(originalAnalysis)
    expect(sidecar.overrides).toEqual(expect.arrayContaining(['bpm', 'key']))
    await writeFile(info.outputPath('sidecar-fault-injection.json'), JSON.stringify({ fault: 'Test replaced owned sidecar with a directory before updates; this is resilience coverage, not a reproduction of the original queue ENOENT.', analyzed, retried, sidecar }, null, 2))
    await closeOwnedApp(app, page, info)
    await reopen(info)
    const reopened = await currentBeat(beat.id)
    expect(reopened.bpm).toBe(137)
    expect(reopened.analysis).toEqual(originalAnalysis)
    expect(reopened.sidecarSync.status).toBe('synced')
  } finally {
    if (!restored) { await rmdir(beat.sidecarPath); await rename(savedPath, beat.sidecarPath) }
  }
})

test('intentional forced termination recovers only acknowledged commits on reopen', async ({}, info) => {
  const id = beats[0].id
  await invoke('settings:patch', { defaultPresetId: 'flac' })
  await invoke('library:updateMetadata', id, { bpm: 139, key: 'F# minor' })
  await correctQueueMetadata()
  const order = (await invoke('queue:snapshot')).jobs.map(job => job.id).reverse()
  await invoke('queue:reorder', order)
  await crashOwnedApp(app, info)
  await reopen(info)
  await verifySaved(id, 139, order)
  await writeFile(info.outputPath('crash-recovery.json'), JSON.stringify({ action: 'Intentional termination through creation-time-verified handles of isolated app processes', assertedBoundary: 'settings/library/queue IPC calls had resolved successfully before termination', uncommittedWorkGuaranteed: false }, null, 2))
})

test('injected truncated library recovers validated backup and preserves damaged bytes after restart', async ({}, info) => {
  const id = beats[0].id
  await invoke('library:updateMetadata', id, { bpm: 141, key: 'F# minor' })
  await closeOwnedApp(app, page, info)
  const committed = await readFile(path.join(root, 'library.json'))
  // Corruption is applied only after the verified process tree has terminated.
  // Use a known validated commit as the backup, then truncate the primary.
  await copyFile(path.join(root, 'library.json'), path.join(root, 'library.json.backup'))
  const damaged = '{"truncated":'
  await writeFile(path.join(root, 'library.json'), damaged)
  await reopen(info)
  expect((await invoke('library:list')).length).toBe(beats.length)
  expect((await currentBeat(id)).bpm).toBe(141)
  expect((await currentBeat(id)).key).toBe('F# minor')
  const preserved = (await readdir(root)).filter(name => name.startsWith('library.json.damaged-'))
  expect(preserved.length).toBeGreaterThan(0)
  expect(await readFile(path.join(root, preserved[0]), 'utf8')).toBe(damaged)
  expect(JSON.parse(committed.toString()).find(beat => beat.id === id).bpm).toBe(141)
  await writeFile(info.outputPath('corruption-recovery.json'), JSON.stringify({ fault: 'Truncated primary after verified shutdown, with validated backup', preservedDamagedFiles: preserved, restoredCount: (await invoke('library:list')).length, restoredBeat: await currentBeat(id) }, null, 2))
})
