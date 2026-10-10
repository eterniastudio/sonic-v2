import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

let app, page, root, beats, rendererErrors
const player = () => page.locator('[data-playback-dock]')
const invoke = (channel, ...args) => page.evaluate(([name, values]) => window.sonic.invoke(name, ...values), [channel, args])
const position = async () => Number(await player().getByLabel('Seek preview').inputValue())
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function visitLibrary() {
  await page.getByRole('button', { name: /Library/ }).first().click()
  await expect(page.locator(`[data-beat-id="${beats[0].id}"]`)).toBeVisible()
}

async function playBeat(beat) {
  await visitLibrary()
  await page.locator(`[data-beat-id="${beat.id}"]`).getByRole('button', { name: `Play ${beat.title}`, exact: true }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', beat.id)
  await expect(player()).toHaveAttribute('data-playback-state', 'playing', { timeout: 20_000 })
  await expect.poll(position, { timeout: 20_000 }).toBeGreaterThan(0.2)
}

async function seekToMiddle() {
  const seek = player().getByLabel('Seek preview')
  await expect.poll(async () => Number(await seek.getAttribute('max'))).toBeGreaterThan(15)
  const bounds = await seek.boundingBox()
  await seek.click({ position: { x: Math.round(bounds.width * 0.5), y: Math.round(bounds.height / 2) } })
  await expect.poll(position).toBeGreaterThan(5)
}

async function reopen(info) {
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => rendererErrors.push(error.message))
}

test.beforeEach(async ({}, info) => {
  app = null
  page = null
  rendererErrors = []
  root = await createOwnedProfile(info)
  beats = await fixtures(root, 18)
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => rendererErrors.push(error.message))
})

test.afterEach(async ({}, info) => {
  await closeOwnedApp(app, page, info)
  expect(rendererErrors).toEqual([])
})

test('Download previews and Library audition share one audio owner without launching an external player', async () => {
  await app.evaluate(({ shell }) => {
    globalThis.__previewExternalOpens = 0
    globalThis.__previewOriginalOpenPath = shell.openPath
    shell.openPath = async () => { globalThis.__previewExternalOpens++; return '' }
  })
  await page.evaluate(() => {
    const active = new Set()
    const start = AudioBufferSourceNode.prototype.start
    const stop = AudioBufferSourceNode.prototype.stop
    const evidence = window.__previewAudio = { maximum: 0, starts: 0, stops: 0, active: () => active.size }
    AudioBufferSourceNode.prototype.start = function (...args) {
      const result = start.apply(this, args)
      active.add(this); evidence.starts++; evidence.maximum = Math.max(evidence.maximum, active.size)
      this.addEventListener('ended', () => active.delete(this), { once: true })
      return result
    }
    AudioBufferSourceNode.prototype.stop = function (...args) {
      const result = stop.apply(this, args)
      active.delete(this); evidence.stops++
      return result
    }
  })
  try {
    const downloadPreview = () => page.locator('[data-job-id="job-0"]').getByRole('button', { name: 'Preview in Sonic', exact: true })
    await downloadPreview().click()
    await expect(player()).toHaveAttribute('data-playback-beat-id', beats[0].id)
    await expect(player()).toHaveAttribute('data-playback-state', 'playing')
    await expect.poll(position).toBeGreaterThan(0.2)
    await downloadPreview().click()
    await playBeat(beats[1])
    await expect.poll(() => page.evaluate(() => window.__previewAudio.active())).toBe(1)
    expect(await page.evaluate(() => window.__previewAudio.stops)).toBeGreaterThan(0)
    await page.locator('nav').getByRole('button', { name: /^Download/ }).first().click()
    await downloadPreview().click()
    await expect(player()).toHaveAttribute('data-playback-beat-id', beats[0].id)
    await expect(player()).toHaveAttribute('data-playback-state', 'playing')
    expect(await page.evaluate(() => window.__previewAudio.maximum)).toBe(1)
    expect(await app.evaluate(() => globalThis.__previewExternalOpens)).toBe(0)
    await expect(player().locator('[data-waveform]')).toHaveCount(1)
    await player().getByRole('button', { name: 'Pause audition', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__previewAudio.active())).toBe(0)
    await invoke('library:remove', beats[0].id, false)
    await downloadPreview().click()
    await expect(page.getByText('This download is no longer in your library. Import its audio to preview it.', { exact: true })).toBeVisible()
    expect(await app.evaluate(() => globalThis.__previewExternalOpens)).toBe(0)
  } finally {
    await app.evaluate(({ shell }) => { shell.openPath = globalThis.__previewOriginalOpenPath })
  }
})

test('real playback, position, volume and one waveform survive navigation and theme; restart is paused', async ({}, info) => {
  await playBeat(beats[0])
  const initial = await position()
  const wave = player().locator('[data-waveform]')
  await expect(wave).toHaveCount(1)
  await page.setViewportSize({ width: 1024, height: 680 })
  await expect(player().getByRole('button', { name: 'Previous track' })).toBeVisible()
  await expect(player().getByRole('button', { name: 'Next track' })).toBeVisible()
  await expect(player().getByLabel('Seek preview')).toBeVisible()
  await expect(player().getByLabel('Preview volume')).toBeVisible()
  await page.screenshot({ path: info.outputPath('playback-min-window.png') })

  for (const view of ['Download', 'Settings', 'Library', 'Settings']) {
    await page.locator('nav').getByRole('button', { name: new RegExp(`^${view}`) }).first().click()
    await expect(player()).toHaveAttribute('data-playback-beat-id', beats[0].id)
    await expect(player()).toHaveAttribute('data-playback-state', 'playing')
    await expect(wave).toHaveCount(1)
  }
  await expect.poll(position, { timeout: 20_000 }).toBeGreaterThan(initial + 0.2)

  await page.getByRole('button', { name: /Theme:/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(player()).toHaveAttribute('data-playback-state', 'playing')
  await expect(wave).toHaveCount(1)
  const volume = player().getByLabel('Preview volume')
  await volume.focus()
  await page.keyboard.press('Home')
  for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight')
  await expect(volume).toHaveValue('0.35')

  await seekToMiddle()
  await player().getByRole('button', { name: 'Pause audition', exact: true }).click()
  await expect(player()).toHaveAttribute('data-playback-state', 'paused')
  const checkpoint = await position()
  await expect.poll(async () => {
    const snapshot = await invoke('playback:get')
    return snapshot.lastTrackId === beats[0].id && snapshot.volume === 0.35 &&
      snapshot.positions.some(entry => entry.beatId === beats[0].id && entry.positionSec >= checkpoint - 1)
  }).toBe(true)

  await closeOwnedApp(app, page, info)
  await reopen(info)
  await expect(player()).toHaveAttribute('data-playback-beat-id', beats[0].id)
  await expect(player()).toHaveAttribute('data-playback-state', 'paused', { timeout: 20_000 })
  await expect.poll(position).toBeGreaterThan(checkpoint - 1)
  expect(await position()).toBeLessThan(checkpoint + 1)
  await expect(player().getByLabel('Preview volume')).toHaveValue('0.35')
  await expect(player().locator('[data-waveform]')).toHaveCount(1)
  await writeFile(info.outputPath('playback-restoration.json'), JSON.stringify({ beatId: beats[0].id, checkpoint, restored: await position(), volume: await player().getByLabel('Preview volume').inputValue(), paused: true }, null, 2))
})

test('immediate normal close drains a pending seek and volume revision before exit', async ({}, info) => {
  await playBeat(beats[0])
  const seek = player().getByLabel('Seek preview')
  const bounds = await seek.boundingBox()
  await seek.click({ position: { x: Math.round(bounds.width * 0.5), y: Math.round(bounds.height / 2) } })
  const volume = player().getByLabel('Preview volume')
  await volume.focus()
  await page.keyboard.press('ArrowLeft')
  // Deliberately no playback:get poll: shutdown must flush renderer-owned
  // pending checkpoints before the isolated main process exits normally.
  await closeOwnedApp(app, page, info)
  await reopen(info)
  await expect(player()).toHaveAttribute('data-playback-beat-id', beats[0].id)
  await expect(player()).toHaveAttribute('data-playback-state', 'paused', { timeout: 20_000 })
  await expect(player().getByLabel('Preview volume')).toHaveValue('0.95')
  expect(await position()).toBeGreaterThan(5)
  const saved = await invoke('playback:get')
  expect(saved.positions.find(entry => entry.beatId === beats[0].id)?.positionSec).toBeGreaterThan(5)
  await writeFile(info.outputPath('immediate-close-playback.json'), JSON.stringify({
    beatId: beats[0].id, restoredPosition: await position(), volume: saved.volume,
    close: 'normal process exit with no pre-close playback:get acknowledgement poll'
  }, null, 2))
})

test('waveform seeking while paused saves immediately and seeking a finished track resumes there', async ({}, info) => {
  await playBeat(beats[0])
  await player().getByRole('button', { name: 'Pause audition' }).click()
  await expect(player()).toHaveAttribute('data-playback-state', 'paused')
  const waveform = player().locator('[data-waveform]')
  const bounds = await waveform.boundingBox()
  await waveform.click({ position: { x: Math.round(bounds.width * 0.5), y: Math.round(bounds.height / 2) } })
  await expect.poll(position).toBeGreaterThan(7)
  await expect.poll(async () => (await invoke('playback:get')).positions.find(entry => entry.beatId === beats[0].id)?.positionSec ?? 0).toBeGreaterThan(7)

  const seek = player().getByLabel('Seek preview')
  const seekBounds = await seek.boundingBox()
  await seek.click({ position: { x: Math.round(seekBounds.width * 0.96), y: Math.round(seekBounds.height / 2) } })
  await player().getByRole('button', { name: 'Play audition', exact: true }).click()
  await expect(player()).toHaveAttribute('data-playback-state', 'ended', { timeout: 10_000 })
  await waveform.click({ position: { x: Math.round(bounds.width * 0.25), y: Math.round(bounds.height / 2) } })
  await expect(player()).toHaveAttribute('data-playback-state', 'paused')
  await expect.poll(position).toBeGreaterThan(3)
  expect(await position()).toBeLessThan(6)
  await player().getByRole('button', { name: 'Play audition', exact: true }).click()
  await expect(player()).toHaveAttribute('data-playback-state', 'playing')
  expect(await position()).toBeGreaterThan(3)
  await player().getByRole('button', { name: 'Pause audition', exact: true }).click()
  const saved = await position()
  await closeOwnedApp(app, page, info)
  await reopen(info)
  await expect(player()).toHaveAttribute('data-playback-state', 'paused', { timeout: 20_000 })
  await expect.poll(position).toBeGreaterThan(saved - 1)
  expect(await position()).toBeLessThan(saved + 1)
})

test('captured collection sequence remains separate from selection, annotation edits and smart results', async ({}, info) => {
  const ordered = [beats[2].id, beats[0].id, beats[1].id]
  await invoke('organization:command', { type: 'create-manual', name: 'Audition order', beatIds: ordered })
  await invoke('organization:command', { type: 'create-smart', name: 'Live favorites', rules: { version: 1, favorite: true } })
  await visitLibrary()
  await page.getByRole('button', { name: 'Collection: Audition order' }).click()
  await page.getByRole('button', { name: 'Play displayed results', exact: true }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', ordered[0])
  await expect(player()).toHaveAttribute('data-playback-state', 'playing', { timeout: 20_000 })
  await expect(player()).toContainText('Audition order · 1 of 3')

  await page.locator(`[data-beat-id="${ordered[1]}"]`).getByRole('checkbox').click()
  await page.locator(`[data-beat-id="${ordered[1]}"]`).click()
  await page.getByLabel('Notes').fill('Shortlist this intro')
  await page.getByRole('button', { name: 'Save annotations' }).click()
  await expect.poll(async () => (await invoke('organization:snapshot')).annotations[ordered[1]]?.notes).toBe('Shortlist this intro')
  await expect(player()).toHaveAttribute('data-playback-beat-id', ordered[0])

  await player().getByRole('button', { name: 'Pause audition', exact: true }).click()
  await expect(player()).toHaveAttribute('data-playback-state', 'paused')
  await page.getByRole('button', { name: 'Collection: Live favorites' }).click()
  await invoke('organization:command', { type: 'set-annotation', beatId: beats[3].id, favorite: true })
  await expect(page.locator(`[data-beat-id="${beats[3].id}"]`)).toBeVisible()
  await expect(player()).toContainText('Audition order · 1 of 3')
  await player().getByRole('button', { name: 'Next track' }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', ordered[1])
  await expect(player()).toHaveAttribute('data-playback-state', 'paused', { timeout: 20_000 })
  await expect(player()).toContainText('Audition order · 2 of 3')
  await player().getByRole('button', { name: 'Next track' }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', ordered[2])
  await expect(player()).toContainText('Audition order · 3 of 3')
  await player().getByRole('button', { name: 'Next track' }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', ordered[2])
  await expect(player()).toHaveAttribute('data-playback-state', 'paused')
  await closeOwnedApp(app, page, info)
  await reopen(info)
  await expect(player()).toHaveAttribute('data-playback-beat-id', ordered[2])
  await expect(player()).toHaveAttribute('data-playback-state', 'paused', { timeout: 20_000 })
  expect((await invoke('organization:snapshot')).annotations[ordered[1]]?.notes).toBe('Shortlist this intro')
  expect((await invoke('organization:snapshot')).collections.some(collection => collection.name === 'Audition order')).toBe(true)
})

test('Play selected captures displayed order, not checkbox order, and ignores later sorting', async () => {
  await visitLibrary()
  const displayed = await page.locator('[data-beat-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-beat-id')))
  const first = displayed[0]
  const later = displayed[2]
  await page.locator(`[data-beat-id="${later}"]`).getByRole('checkbox').click()
  await page.locator(`[data-beat-id="${first}"]`).getByRole('checkbox').click()
  await page.getByRole('button', { name: 'Play selected tracks' }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', first)
  await expect(player()).toHaveAttribute('data-playback-state', 'playing', { timeout: 20_000 })
  await expect(player()).toContainText('1 of 2')
  await page.getByRole('button', { name: 'Newest first' }).click()
  await page.getByRole('menuitemradio', { name: 'Oldest first' }).click()
  await player().getByRole('button', { name: 'Next track' }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', later)
  await expect(player()).toContainText('2 of 2')
})

test('missing future entry is skipped and removing the active record releases playback', async () => {
  const ordered = beats.slice(0, 3).map(beat => beat.id)
  await invoke('organization:command', { type: 'create-manual', name: 'Missing entry test', beatIds: ordered })
  await visitLibrary()
  await page.getByRole('button', { name: 'Collection: Missing entry test' }).click()
  await page.getByRole('button', { name: 'Play displayed results' }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', ordered[0])
  await expect(player()).toHaveAttribute('data-playback-state', 'playing', { timeout: 20_000 })
  await player().getByRole('button', { name: 'Pause audition' }).click()
  await rename(beats[1].filePath, `${beats[1].filePath}.test-hidden`)
  await invoke('library:rescan')
  await expect.poll(async () => (await invoke('library:list')).find(beat => beat.id === ordered[1])?.missing).toBe(true)
  await player().getByRole('button', { name: 'Next track' }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', ordered[2])
  await expect(player()).toHaveAttribute('data-playback-state', 'paused', { timeout: 20_000 })
  await expect(player()).toContainText('Missing entry test · 3 of 3')
  const current = (await invoke('library:list')).find(beat => beat.id === ordered[2])
  await invoke('library:remove', current.id, false, { filePath: current.filePath, fingerprint: current.fingerprint })
  await expect(player()).toHaveAttribute('data-playback-beat-id', '')
  await expect(player()).toHaveAttribute('data-playback-state', 'error')
  await expect(player().getByText('Could not play', { exact: true })).toBeVisible()
  expect(hash(await readFile(current.filePath))).toBe(current.fingerprint)
})

test('imported original stays untouched by audition and rejects stale position after external replacement', async ({}, info) => {
  await closeOwnedApp(app, page, info)
  const externalDir = path.join(root, 'imported-originals')
  await mkdir(externalDir)
  const source = path.join(externalDir, 'untouched.wav')
  await copyFile(beats[0].filePath, source)
  const bytes = await readFile(source)
  const record = { ...beats[0], id: 'imported-playback', title: 'Imported original', filePath: source,
    fileName: path.basename(source), fileOwnership: 'external', sourceKind: 'local', fingerprint: hash(bytes) }
  await writeFile(path.join(root, 'library.json'), JSON.stringify([...beats, record]))
  await reopen(info)
  await playBeat(record)
  await seekToMiddle()
  await player().getByRole('button', { name: 'Pause audition' }).click()
  await expect.poll(async () => (await invoke('playback:get')).positions.find(entry => entry.beatId === record.id)?.positionSec ?? 0).toBeGreaterThan(5)
  await closeOwnedApp(app, page, info)
  expect(hash(await readFile(source))).toBe(hash(bytes))
  expect((await readFile(path.join(root, 'library.json'), 'utf8')).includes('imported-playback')).toBe(true)

  // Deliberate fixture-only content replacement: the same stable beat ID now
  // resolves to different audio bytes. Sonic must not apply the old position.
  const replacement = Buffer.from(bytes)
  replacement.writeInt16LE(7777, 44)
  await writeFile(source, replacement)
  await reopen(info)
  await expect(player()).toHaveAttribute('data-playback-beat-id', record.id)
  await expect(player()).toHaveAttribute('data-playback-state', 'paused', { timeout: 20_000 })
  expect(await position()).toBeLessThan(1)
  expect(hash(await readFile(source))).toBe(hash(replacement))
  await writeFile(info.outputPath('imported-content-replacement.json'), JSON.stringify({
    beatId: record.id, before: hash(bytes), replacement: hash(replacement), stalePositionApplied: false
  }, null, 2))
})

test('invalid checkpoint is rejected; failed replacement retains pending volume and retries', async ({}, info) => {
  await playBeat(beats[0])
  await expect.poll(async () => (await invoke('playback:get')).lastTrackId).toBe(beats[0].id)
  const before = await invoke('playback:get')
  await expect(invoke('playback:checkpoint', { type: 'volume', volume: 'loud' })).rejects.toThrow(/Invalid playback/)
  await expect(invoke('playback:checkpoint', { type: 'position', beatId: beats[0].id,
    fingerprint: 'not-a-hash', positionSec: -1, completed: false })).rejects.toThrow(/Invalid playback/)
  expect(await invoke('playback:get')).toEqual(before)

  const storePath = path.join(root, 'playback-session.json')
  const savedPath = `${storePath}.test-valid`
  await rename(storePath, savedPath)
  await mkdir(storePath)
  let restored = false
  try {
    const volume = player().getByLabel('Preview volume')
    await volume.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(volume).toHaveValue('0.95')
    await expect(player().getByRole('button', { name: 'Retry save' })).toBeVisible()
    await expect.poll(async () => (await invoke('storage:status')).find(item => item.file.endsWith('playback-session.json'))?.error).toBeTruthy()
    expect(JSON.parse(await readFile(savedPath, 'utf8')).volume).toBe(1)
    await rmdir(storePath)
    await rename(savedPath, storePath)
    restored = true
    // Use the global retry path too: it must drain the renderer-owned pending
    // queue, not merely repair the main-process JsonStore revision.
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click()
    await expect(player().getByRole('button', { name: 'Retry save' })).toHaveCount(0)
    await expect.poll(async () => JSON.parse(await readFile(storePath, 'utf8')).volume).toBe(0.95)
    await closeOwnedApp(app, page, info)
    await reopen(info)
    await expect(player().getByLabel('Preview volume')).toHaveValue('0.95')
    expect((await invoke('playback:get')).volume).toBe(0.95)
  } finally {
    if (!restored) {
      await rmdir(storePath)
      await rename(savedPath, storePath)
      await invoke('storage:retry').catch(() => undefined)
    }
  }
})
