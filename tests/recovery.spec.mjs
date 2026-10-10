import { test, expect } from '@playwright/test'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'
import { recoveryFixtures, moveRecoveryTrack, copyRecoveryCandidate,
  recoveryMediaSnapshot, savedTrackEvidence } from './recovery-fixtures.mjs'

let app, page, root, fixture, beats, rendererErrors
const invoke = (channel, ...args) => page.evaluate(([name, values]) => window.sonic.invoke(name, ...values), [channel, args])
const card = beat => page.locator(`[data-beat-id="${beat.id}"]`)
const row = (dialog, beat) => dialog.locator(`[data-recovery-beat-id="${beat.id}"]`)
const player = () => page.locator('[data-playback-dock]')
const position = async () => Number(await player().getByLabel('Seek preview').inputValue())
const record = async beat => (await invoke('library:list')).find(item => item.id === beat.id)
const applyButton = dialog => dialog.getByRole('button', { name: /^Reconnect [0-9]+ tracks?$/ })
const search = () => page.getByPlaceholder('Search title, producer, BPM, key…')

async function visitLibrary() {
  await page.locator('nav').getByRole('button', { name: /^Library/ }).first().click()
  await expect(card(beats[0])).toBeVisible()
}

async function reopen(info) {
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => rendererErrors.push(error.message))
  await visitLibrary()
}

async function rescanMissing(items) {
  await invoke('library:rescan')
  await expect.poll(async () => {
    const library = await invoke('library:list')
    return items.every(beat => library.find(item => item.id === beat.id)?.missing)
  }).toBe(true)
}

/** Native-picker test ownership only; the real UI and IPC never receive a path. */
async function withOwnedPicker(paths, action, { canceled = false } = {}) {
  await app.evaluate(({ dialog }, selection) => {
    if (globalThis.__sonicRecoveryDialog) throw new Error('Another test owns the native picker.')
    globalThis.__sonicRecoveryDialog = { original: dialog.showOpenDialog, calls: 0 }
    dialog.showOpenDialog = async () => {
      globalThis.__sonicRecoveryDialog.calls++
      return { canceled: selection.canceled, filePaths: selection.paths }
    }
  }, { paths, canceled })
  try {
    await action()
    await expect.poll(() => app.evaluate(() => globalThis.__sonicRecoveryDialog.calls)).toBe(1)
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis.__sonicRecoveryDialog
      if (state) dialog.showOpenDialog = state.original
      delete globalThis.__sonicRecoveryDialog
    })
  }
}

async function locateSingle(beat, candidatePath, { entry = 'context', canceled = false } = {}) {
  await search().fill(beat.title)
  await expect(card(beat)).toBeVisible()
  let trigger
  if (entry === 'inspector') {
    await card(beat).getByText(beat.title, { exact: true }).click()
    trigger = page.locator('[data-preview-state]').getByRole('button', { name: 'Locate file…', exact: true })
  } else {
    await card(beat).click({ button: 'right' })
    trigger = page.getByRole('menu', { name: 'Beat actions' }).getByRole('menuitem', { name: 'Locate file…', exact: true })
  }
  await withOwnedPicker(candidatePath ? [candidatePath] : [], () => trigger.click(), { canceled })
  const dialog = page.getByRole('dialog', { name: 'Locate missing file', exact: true })
  if (!canceled) await expect(dialog).toBeVisible()
  return dialog
}

async function findFolder(items, folder, { canceled = false } = {}) {
  await search().fill('')
  const clear = page.getByRole('button', { name: 'Clear selection', exact: true })
  if (await clear.count()) await clear.click()
  for (const beat of items) await card(beat).getByRole('checkbox').check()
  const trigger = page.getByRole('button', { name: 'Find missing files…', exact: true })
  await withOwnedPicker(folder ? [folder] : [], () => trigger.click(), { canceled })
  const dialog = page.getByRole('dialog', { name: 'Find missing files', exact: true })
  if (!canceled) await expect(dialog).toBeVisible()
  return dialog
}

async function chooseCandidate(dialog, beat, candidatePath) {
  const item = row(dialog, beat)
  await expect(item).toBeVisible()
  await item.getByRole('radio', { name: candidatePath, exact: true }).check()
  await item.getByRole('checkbox', { name: `Reconnect ${beat.title}`, exact: true }).check()
}

async function reconnect(dialog, count) {
  await expect(applyButton(dialog)).toHaveAccessibleName(`Reconnect ${count} track${count === 1 ? '' : 's'}`)
  await expect(applyButton(dialog)).toBeEnabled()
  await applyButton(dialog).click()
  await expect(dialog).toContainText(`${count} track${count === 1 ? '' : 's'} reconnected`, { timeout: 30_000 })
}

async function closeReview(dialog) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(dialog).toHaveCount(0)
}

async function playBeat(beat) {
  await search().fill(beat.title)
  await card(beat).getByRole('button', { name: `Play ${beat.title}`, exact: true }).click()
  await expect(player()).toHaveAttribute('data-playback-beat-id', beat.id)
  await expect(player()).toHaveAttribute('data-playback-state', 'playing', { timeout: 20_000 })
  await expect.poll(position).toBeGreaterThan(0.2)
}

test.beforeEach(async ({}, info) => {
  app = null; page = null; rendererErrors = []
  root = await createOwnedProfile(info)
  fixture = await recoveryFixtures(root, { manyCount: info.title.includes('minimum window') ? 24 : 0 })
  beats = fixture.beats
  await reopen(info)
  await page.setViewportSize({ width: 1440, height: 1000 })
})

test.afterEach(async ({}, info) => {
  await closeOwnedApp(app, page, info)
  expect(rendererErrors).toEqual([])
})

test('inspector reconnects a moved owned file and sidecar with the same ID and saved evidence after restart', async ({}, info) => {
  const beat = beats[0]
  const before = await record(beat)
  const initialIds = (await invoke('library:list')).map(item => item.id)
  const moved = await moveRecoveryTrack(beat, path.join(root, 'single-moved'))
  const media = await recoveryMediaSnapshot([moved.audioPath, moved.sidecarPath])
  await rescanMissing([beat])
  const dialog = await locateSingle(beat, moved.audioPath, { entry: 'inspector' })
  await chooseCandidate(dialog, beat, moved.audioPath)
  // Search intentionally saves relevance sorting. Capture the browsing view
  // after that user action, immediately before the recovery mutation.
  const organization = await invoke('organization:snapshot')
  await reconnect(dialog, 1)
  await closeReview(dialog)
  const recovered = await record(beat)
  expect(recovered).toMatchObject({ id: beat.id, filePath: moved.audioPath, sidecarPath: moved.sidecarPath,
    missing: false, fileOwnership: 'sonic-export', ownershipEvidence: before.ownershipEvidence,
    recoveryInfo: { ownership: 'retained', sidecar: 'verified', previousPath: before.filePath } })
  expect(savedTrackEvidence(recovered)).toEqual(savedTrackEvidence(before))
  expect((await invoke('library:list')).map(item => item.id)).toEqual(initialIds)
  expect(await invoke('organization:snapshot')).toEqual(organization)
  expect(await recoveryMediaSnapshot([moved.audioPath, moved.sidecarPath])).toEqual(media)
  await closeOwnedApp(app, page, info)
  await reopen(info)
  const restored = await record(beat)
  expect(restored).toEqual(recovered)
  expect(await invoke('organization:snapshot')).toEqual(organization)
  await expect(card(beat).getByRole('img', { name: `Artwork for ${beat.title}`, exact: true })).toBeVisible()
  await writeFile(info.outputPath('recovery-single-restored.json'), JSON.stringify({ before, recovered, restored, media }, null, 2))
})

test('folder recovery preserves mixed source records, artwork, annotations and manual collection order', async ({}, info) => {
  const items = beats.slice(0, 3)
  const before = await invoke('library:list')
  const organization = await invoke('organization:snapshot')
  const folder = path.join(root, 'mixed-source-folder')
  const moved = []
  for (const beat of items) moved.push(await moveRecoveryTrack(beat, path.join(folder, beat.sourceKind)))
  const paths = moved.flatMap(item => [item.audioPath, item.sidecarPath]).filter(Boolean)
  const media = await recoveryMediaSnapshot(paths)
  await rescanMissing(items)
  const dialog = await findFolder(items, folder)
  await expect(dialog.locator('[data-recovery-beat-id]')).toHaveCount(3)
  for (const [index, beat] of items.entries()) await chooseCandidate(dialog, beat, moved[index].audioPath)
  await reconnect(dialog, 3)
  await closeReview(dialog)
  for (const [index, beat] of items.entries()) {
    const recovered = await record(beat)
    expect(recovered).toMatchObject({ id: beat.id, filePath: moved[index].audioPath, missing: false, sourceKind: beat.sourceKind })
    expect(savedTrackEvidence(recovered)).toEqual(savedTrackEvidence(before.find(item => item.id === beat.id)))
    await expect(card(beat).getByRole('img', { name: `Artwork for ${beat.title}`, exact: true })).toBeVisible()
  }
  expect(await record(beats[2])).toMatchObject({ fileOwnership: 'external', sidecarPath: null,
    recoveryInfo: { ownership: 'read-only', sidecar: 'not-applicable' } })
  expect(await invoke('organization:snapshot')).toEqual(organization)
  expect(await recoveryMediaSnapshot(paths)).toEqual(media)
  await closeOwnedApp(app, page, info)
  await reopen(info)
  expect(await invoke('organization:snapshot')).toEqual(organization)
  expect((await invoke('library:list')).map(item => item.id)).toEqual(before.map(item => item.id))
  for (const [index, beat] of items.entries()) expect((await record(beat)).filePath).toBe(moved[index].audioPath)
  await page.getByRole('button', { name: 'Collection: Recovery shortlist', exact: true }).click()
  const collectionIds = await page.locator('[data-beat-id]').evaluateAll(nodes => nodes.map(node => node.dataset.beatId))
  expect(collectionIds).toEqual(organization.collections.find(item => item.id === 'recovery-shortlist').beatIds)
  await writeFile(info.outputPath('recovery-mixed-restored.json'), JSON.stringify({ organization, library: await invoke('library:list'), media }, null, 2))
})

test('a same-size wrong-byte file cannot be reconnected from the context menu', async () => {
  const beat = beats[0]
  await moveRecoveryTrack(beat, path.join(root, 'actual-match-outside-selection'))
  const wrong = await copyRecoveryCandidate(beats[1].filePath, path.join(root, 'wrong-file'), beat.fileName)
  const media = await recoveryMediaSnapshot([wrong])
  await rescanMissing([beat])
  const before = await invoke('library:list')
  const dialog = await locateSingle(beat, wrong)
  await expect(row(dialog, beat)).toBeVisible()
  await expect(row(dialog, beat)).toContainText(/no match|different|not found|does not match|fingerprint/i)
  await expect(row(dialog, beat).getByRole('radio')).toHaveCount(0)
  await expect(applyButton(dialog)).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await invoke('library:list')).toEqual(before)
  expect(await recoveryMediaSnapshot([wrong])).toEqual(media)
})

test('identical folder candidates require an explicit choice and a copied export remains read-only', async () => {
  const beat = beats[0]
  const folder = path.join(root, 'identical-candidates')
  const moved = await moveRecoveryTrack(beat, path.join(folder, 'original-moved'))
  const copied = await copyRecoveryCandidate(moved.audioPath, path.join(folder, 'independent-copy'))
  const paths = [moved.audioPath, moved.sidecarPath, copied]
  const media = await recoveryMediaSnapshot(paths)
  await rescanMissing([beat])
  const dialog = await findFolder([beat], folder)
  await expect(row(dialog, beat).getByRole('radio')).toHaveCount(2)
  await expect(row(dialog, beat).locator('input[type="radio"]:checked')).toHaveCount(0)
  await expect(applyButton(dialog)).toBeDisabled()
  await chooseCandidate(dialog, beat, copied)
  await reconnect(dialog, 1)
  const recovered = await record(beat)
  expect(recovered).toMatchObject({ id: beat.id, filePath: copied, fileOwnership: 'external', sidecarPath: null,
    recoveryInfo: { ownership: 'read-only', sidecar: 'unresolved' } })
  expect(await recoveryMediaSnapshot(paths)).toEqual(media)
})

test('cancelling the native picker and both file and folder previews commits no recovery', async () => {
  const items = beats.slice(0, 3)
  const folder = path.join(root, 'cancelled-recovery')
  const moved = []
  for (const beat of items) moved.push(await moveRecoveryTrack(beat, folder))
  await rescanMissing(items)
  const before = await invoke('library:list')
  await locateSingle(items[0], null, { canceled: true })
  await expect(page.getByRole('dialog', { name: 'Locate missing file', exact: true })).toHaveCount(0)
  expect(await invoke('library:list')).toEqual(before)
  const single = await locateSingle(items[0], moved[0].audioPath)
  await chooseCandidate(single, items[0], moved[0].audioPath)
  await single.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(single).toHaveCount(0)
  await findFolder(items, null, { canceled: true })
  await expect(page.getByRole('dialog', { name: 'Find missing files', exact: true })).toHaveCount(0)
  const folderReview = await findFolder(items, folder)
  await chooseCandidate(folderReview, items[0], moved[0].audioPath)
  await folderReview.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(folderReview).toHaveCount(0)
  expect(await invoke('library:list')).toEqual(before)
})

for (const change of ['replaced', 'disappeared']) {
  test(`a candidate ${change} after preview cannot change the saved library path`, async () => {
    const beat = beats[0]
    const moved = await moveRecoveryTrack(beat, path.join(root, `candidate-${change}`))
    await rescanMissing([beat])
    const before = await invoke('library:list')
    const dialog = await locateSingle(beat, moved.audioPath)
    await chooseCandidate(dialog, beat, moved.audioPath)
    if (change === 'disappeared') await unlink(moved.audioPath)
    else {
      const replacement = Buffer.from(await readFile(beats[1].filePath))
      await unlink(moved.audioPath)
      await writeFile(moved.audioPath, replacement)
    }
    await applyButton(dialog).click()
    await expect(row(dialog, beat)).toContainText(/changed|no longer|unavailable|invalid|does not match|not.*found|cannot|ENOENT|disappear/i, { timeout: 30_000 })
    expect(await invoke('library:list')).toEqual(before)
    expect((await record(beat)).missing).toBe(true)
  })
}

test('reconnecting another track leaves unrelated playback running and preserves saved byte-based positions', async ({}, info) => {
  const recoveredBeat = beats[0], unrelated = beats[3]
  await playBeat(recoveredBeat)
  const seek = player().getByLabel('Seek preview')
  const bounds = await seek.boundingBox()
  await seek.click({ position: { x: Math.round(bounds.width * 0.25), y: Math.round(bounds.height / 2) } })
  await expect.poll(position).toBeGreaterThan(10)
  await player().getByRole('button', { name: 'Pause audition', exact: true }).click()
  const checkpoint = await position()
  await expect.poll(async () => (await invoke('playback:get')).positions.find(item => item.beatId === recoveredBeat.id)?.positionSec ?? 0).toBeGreaterThan(checkpoint - 1)
  await playBeat(unrelated)
  const beforePosition = await position()
  // Switching tracks acknowledges one final checkpoint for the previous track.
  // Recovery must preserve that committed snapshot, including its timestamp.
  const savedPosition = (await invoke('playback:get')).positions.find(item => item.beatId === recoveredBeat.id)
  const moved = await moveRecoveryTrack(recoveredBeat, path.join(root, 'recovery-during-other-playback'))
  await rescanMissing([recoveredBeat])
  const dialog = await locateSingle(recoveredBeat, moved.audioPath)
  await chooseCandidate(dialog, recoveredBeat, moved.audioPath)
  await reconnect(dialog, 1)
  await expect(player()).toHaveAttribute('data-playback-beat-id', unrelated.id)
  await expect(player()).toHaveAttribute('data-playback-state', 'playing')
  await expect.poll(position).toBeGreaterThan(beforePosition + 0.1)
  expect((await invoke('playback:get')).positions.find(item => item.beatId === recoveredBeat.id)).toEqual(savedPosition)
  await closeReview(dialog)
  await closeOwnedApp(app, page, info)
  await reopen(info)
  await expect(player()).toHaveAttribute('data-playback-beat-id', unrelated.id)
  await expect(player()).toHaveAttribute('data-playback-state', 'paused', { timeout: 20_000 })
  expect((await invoke('playback:get')).positions.find(item => item.beatId === recoveredBeat.id)).toEqual(savedPosition)
  await playBeat(recoveredBeat)
  await expect.poll(position).toBeGreaterThan(checkpoint - 1)
  expect(await position()).toBeLessThan(checkpoint + 3)
  await writeFile(info.outputPath('recovery-playback-restored.json'), JSON.stringify({ savedPosition, checkpoint, restoredPosition: await position(), unrelatedId: unrelated.id }, null, 2))
})

for (const theme of ['dark', 'light']) {
  test(`minimum window ${theme}: long paths and many results stay contained and the footer remains usable`, async ({}, info) => {
    const items = beats.slice(4)
    const folder = path.join(root, 'Recovery results for a long named producer project', 'nested session folder with spaces')
    const moved = []
    for (const beat of items) moved.push(await moveRecoveryTrack(beat, folder))
    await rescanMissing(items)
    await page.setViewportSize({ width: 1024, height: 680 })
    if (theme === 'light') await page.getByRole('button', { name: /Theme:/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const dialog = await findFolder(items, folder)
    await expect(dialog.locator('[data-recovery-beat-id]')).toHaveCount(24)
    for (const [index, beat] of items.entries()) await chooseCandidate(dialog, beat, moved[index].audioPath)
    const dialogBounds = await dialog.boundingBox()
    expect(dialogBounds.x).toBeGreaterThanOrEqual(0)
    expect(dialogBounds.y).toBeGreaterThanOrEqual(0)
    expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(1025)
    expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(681)
    const overflow = await dialog.evaluate(node => ({ horizontal: node.scrollWidth - node.clientWidth,
      scrollableResults: [...node.querySelectorAll('*')].some(child => /auto|scroll/.test(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight) }))
    expect(overflow.horizontal).toBeLessThanOrEqual(1)
    expect(overflow.scrollableResults).toBe(true)
    await row(dialog, items.at(-1)).scrollIntoViewIfNeeded()
    await expect(row(dialog, items.at(-1)).getByRole('radio', { name: moved.at(-1).audioPath, exact: true })).toBeVisible()
    await expect(applyButton(dialog)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    const footerBounds = await applyButton(dialog).boundingBox()
    expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual(681)
    await page.screenshot({ path: info.outputPath(`recovery-minimum-${theme}.png`) })
    await reconnect(dialog, 24)
    await closeReview(dialog)
    for (const [index, beat] of items.entries()) expect(await record(beat)).toMatchObject({ id: beat.id, missing: false, filePath: moved[index].audioPath, fileOwnership: 'external' })
  })
}

test('a legacy export without ownership receipts reconnects read-only without changing audio or sidecar bytes', async () => {
  const beat = beats[3]
  const before = await record(beat)
  expect(before.ownershipEvidence).toBeUndefined()
  const moved = await moveRecoveryTrack(beat, path.join(root, 'legacy-moved'))
  const media = await recoveryMediaSnapshot([moved.audioPath, moved.sidecarPath])
  await rescanMissing([beat])
  const dialog = await locateSingle(beat, moved.audioPath)
  await chooseCandidate(dialog, beat, moved.audioPath)
  await reconnect(dialog, 1)
  await closeReview(dialog)
  const recovered = await record(beat)
  expect(recovered).toMatchObject({ filePath: moved.audioPath, fileOwnership: 'external', sidecarPath: null,
    recoveryInfo: { ownership: 'read-only', sidecar: 'unresolved' } })
  expect(savedTrackEvidence(recovered)).toEqual(savedTrackEvidence(before))
  expect(await recoveryMediaSnapshot([moved.audioPath, moved.sidecarPath])).toEqual(media)
  await card(beat).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Rename in library…', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Rename beat and file…', exact: true })).toHaveCount(0)
})

test('normal close with a recovery review open settles owned work and reopens without committing the preview', async ({}, info) => {
  const items = beats.slice(0, 3)
  const folder = path.join(root, 'close-during-recovery')
  for (const beat of items) await moveRecoveryTrack(beat, folder)
  await rescanMissing(items)
  const before = await invoke('library:list')
  const organization = await invoke('organization:snapshot')
  const dialog = await findFolder(items, folder)
  await expect(dialog).toBeVisible()
  // The lifecycle helper requests the normal renderer/native close route and
  // verifies exact test-owned processes exit. It never closes another app.
  await closeOwnedApp(app, page, info)
  await reopen(info)
  await expect(page.getByRole('dialog', { name: 'Find missing files', exact: true })).toHaveCount(0)
  expect(await invoke('library:list')).toEqual(before)
  expect(await invoke('organization:snapshot')).toEqual(organization)
})
