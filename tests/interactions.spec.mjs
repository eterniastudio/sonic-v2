import { test, expect } from '@playwright/test'
import { mkdir, readFile, writeFile, appendFile, rename, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

let app, page, root, beats, errors
const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.sonic.invoke(c, ...a), [channel, args])
test.beforeEach(async ({}, info) => {
  app = null; page = null; errors = []
  root = await createOwnedProfile(info); beats = await fixtures(root, info.title.includes('loaded') ? 180 : 24)
  const settingsPath = path.join(root, 'settings.json')
  const savedSettings = JSON.parse(await readFile(settingsPath, 'utf8'))
  savedSettings.reduceMotion = info.repeatEachIndex % 2 || info.title.includes('loaded') ? 'off' : 'on'
  await writeFile(settingsPath, JSON.stringify(savedSettings))
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => errors.push(error.message))
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  await expect(page.getByTitle('Default export format', { exact: true })).toBeVisible()
  expect(path.resolve(await invoke('app:info').then(i => i.userDataDir))).toBe(root)
})
test.afterEach(async ({}, info) => {
  try {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: info.outputPath('screen.png'), timeout: 5000 })
      await writeFile(info.outputPath('diagnostics.json'), JSON.stringify({ errors, ui: await page.evaluate(() => ({ focus: document.activeElement?.outerHTML, menus: [...document.querySelectorAll('[role=menu], [role=dialog]')].map(n => ({ html: n.outerHTML.slice(0, 600), rect: n.getBoundingClientRect().toJSON(), pointer: getComputedStyle(n).pointerEvents })) })) }, null, 2))
      await app.context().tracing.stop({ path: info.outputPath('trace.zip') })
    }
  } finally {
    await closeOwnedApp(app, page, info)
  }
})

async function menuCheck(trigger, name = /Original stream/) {
  await trigger.click()
  const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitemradio', { name }) })
  await expect(menu).toBeVisible()
  const last = menu.getByRole('menuitemradio', { name })
  await last.scrollIntoViewIfNeeded()
  const rect = await last.boundingBox()
  expect(rect.y).toBeGreaterThanOrEqual(0)
  expect(rect.y + rect.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
  expect(await last.evaluate(n => { const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
  await trigger.click(); await expect(menu).toBeHidden()
  await trigger.click(); await last.click(); await expect(menu).toBeHidden()
}

test('appearance theme choices use the Settings magnet effect', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Always animate', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'false')

  const themes = page.getByRole('radiogroup', { name: 'Theme' })
  const dark = themes.getByRole('radio', { name: 'Dark' })
  const light = themes.getByRole('radio', { name: 'Light' })
  const system = themes.getByRole('radio', { name: 'System' })
  const indicator = themes.locator('.t-tabs-pill')
  await expect(dark).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => (await indicator.boundingBox()).width).toBeGreaterThan(40)
  const selectedWidth = (await indicator.boundingBox()).width

  await light.hover()
  await expect.poll(async () => (await indicator.boundingBox()).width).toBeGreaterThan(selectedWidth + 10)
  await light.click()
  await expect(light).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(async () => (await invoke('settings:get')).theme).toBe('light')

  await light.focus(); await page.keyboard.press('ArrowRight')
  await expect(system).toBeFocused()
  await expect(system).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => (await invoke('settings:get')).theme).toBe('system')
  expect(errors).toEqual([])
})

test('library context menu keeps channel backlink and renamed DAW file across restart', async ({}, info) => {
  await app.context().tracing.stop({ path: info.outputPath('before-source-seed.zip') })
  await closeOwnedApp(app, page, info)
  const libraryPath = path.join(root, 'library.json')
  const records = JSON.parse(await readFile(libraryPath, 'utf8'))
  const record = records.find(beat => beat.id === beats[3].id)
  record.sourceUrl = 'https://www.youtube.com/watch?v=ABCDEFGHIJK'
  record.sourceKind = 'youtube'
  record.sourceChannel = 'Fixture Channel'
  await writeFile(libraryPath, JSON.stringify(records))
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => errors.push(error.message))
  await app.context().tracing.start({ screenshots: true, snapshots: true })

  await page.getByRole('button', { name: /Library/, exact: false }).first().click()
  const card = page.locator(`[data-beat-id="${record.id}"]`)
  await expect(card).toContainText('Fixture Channel')
  await card.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Beat actions' })
  await expect(menu.getByRole('menuitem', { name: 'Open on YouTube' })).toBeEnabled()
  await menu.getByRole('menuitem', { name: 'Rename beat and file…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename beat and file' })
  await dialog.getByPlaceholder('Beat title').fill('DAW fixture')
  await dialog.getByRole('button', { name: 'Save name' }).click()
  await expect(dialog).toHaveCount(0)
  const renamed = (await invoke('library:list')).find(beat => beat.id === record.id)
  expect(renamed.fileName).toContain('DAW fixture')
  expect(renamed.sourceUrl).toBe(record.sourceUrl)
  expect(renamed.sourceChannel).toBe('Fixture Channel')
  expect((await readFile(renamed.filePath)).length).toBe(record.sizeBytes)
  await expect.poll(async () => readFile(record.filePath).then(() => true, () => false)).toBe(false)

  await app.context().tracing.stop({ path: info.outputPath('before-reopen.zip') })
  await closeOwnedApp(app, page, info)
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => errors.push(error.message))
  await app.context().tracing.start({ screenshots: true, snapshots: true })
  const restored = (await invoke('library:list')).find(beat => beat.id === record.id)
  expect(restored.filePath).toBe(renamed.filePath)
  expect(restored.sourceChannel).toBe('Fixture Channel')
  expect(errors).toEqual([])
})

test('offline pointer, keyboard, deletion, persistence, and preview', async ({}, info) => {
  const picker = page.getByTitle('Default export format', { exact: true })
  await menuCheck(picker)
  await expect(picker).toHaveText('Original stream')
  expect((await invoke('settings:get')).defaultPresetId).toBe('original')
  await picker.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('Enter')
  await expect(picker).toHaveText('MP3 320')
  await picker.click(); await page.keyboard.press('Escape'); await expect(picker).toBeFocused()
  await rename(path.join(root, 'settings.json'), path.join(root, 'settings.saved.json'))
  await mkdir(path.join(root, 'settings.json'))
  await picker.click(); await page.getByRole('menuitemradio', { name: /FLAC/ }).click()
  await expect(page.getByRole('menu').getByRole('alert')).toBeVisible()
  expect((await invoke('settings:get')).defaultPresetId).toBe('mp3-320')
  await page.keyboard.press('Escape')
  await rmdir(path.join(root, 'settings.json')); await rename(path.join(root, 'settings.saved.json'), path.join(root, 'settings.json'))
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click()
  await expect.poll(async () => (await invoke('settings:get')).defaultPresetId).toBe('flac')
  // Retry commits the previously rejected selection; restore the original
  // default before continuing the separate per-job scope assertions.
  await picker.click(); await page.getByRole('menuitemradio', { name: /MP3 320/ }).click()
  await expect(picker).toHaveText('MP3 320')

  await picker.click(); await page.getByRole('heading', { name: 'Queue', exact: true }).click(); await expect(page.getByRole('menu')).toHaveCount(0)

  const row = page.locator('div.flex.gap-3\\.5').filter({ has: page.getByRole('heading', { name: 'Offline job 4', exact: true }) })
  await row.scrollIntoViewIfNeeded(); await menuCheck(row.getByRole('button', { name: '320', exact: true }))
  expect((await invoke('queue:snapshot')).jobs.find(j => j.id === 'job-4').presetId).toBe('original')
  expect((await invoke('settings:get')).defaultPresetId).toBe('mp3-320')

  const completed = page.locator('div.flex.gap-3\\.5').filter({ has: page.getByRole('heading', { name: 'Offline job 0', exact: true }) })
  await completed.scrollIntoViewIfNeeded(); await expect(completed.getByRole('button', { name: '320', exact: true })).toBeDisabled()
  await completed.hover(); await completed.getByRole('button', { name: 'Remove from queue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Offline job 0')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
  await completed.hover(); await completed.getByRole('button', { name: 'Remove from queue', exact: true }).click()
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Offline job 0', exact: true })).toHaveCount(0)
  expect((await invoke('library:list')).some(b => b.id === beats[0].id)).toBe(true)
  expect((await readFile(beats[0].filePath)).length).toBe(beats[0].sizeBytes)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const tabs = page.getByRole('tablist', { name: 'Settings sections' })
  await tabs.getByRole('tab', { name: 'Appearance' }).focus(); await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'Export', exact: true })).toBeFocused()
  await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'settings-panel-export')
  await menuCheck(page.getByRole('button', { name: 'MP3 320', exact: true }))
  await page.getByRole('button', { name: 'Commands', exact: false }).click()
  await page.getByPlaceholder('Search beats, commands and settings…').fill('FLAC')
  await page.getByRole('dialog').getByRole('button', { name: /FLAC/ }).click()
  await expect(page.getByRole('button', { name: 'FLAC', exact: true })).toBeVisible()

  await page.getByRole('button', { name: /Library/, exact: false }).first().click()
  await page.locator(`[data-beat-id="${beats[0].id}"]`).click()
  await expect(page.getByRole('button', { name: 'Play this beat', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Play this beat', exact: true }).click()
  const audition = page.locator('[data-playback-dock]')
  await expect(audition).toHaveAttribute('data-playback-state', 'playing')
  await audition.getByLabel('Seek preview').focus(); await page.keyboard.press('ArrowRight')
  await audition.getByLabel('Preview volume').focus(); await page.keyboard.press('ArrowLeft')
  await expect(audition.getByLabel('Preview volume')).toHaveValue('0.95')
  await page.getByText('Correct BPM / key', { exact: true }).click()
  await page.getByLabel('Manual BPM', { exact: true }).fill('133')
  await page.getByLabel('Manual key', { exact: true }).fill('F# minor')
  await page.getByRole('button', { name: 'Save corrections' }).click()
  await expect.poll(async () => (await invoke('library:list')).find(b => b.id === beats[0].id).bpm).toBe(133)
  const correctedPath = (await invoke('library:list')).find(b => b.id === beats[0].id).filePath
  await page.getByRole('button', { name: 'Halve the tempo' }).click()
  await expect.poll(async () => (await invoke('library:list')).find(b => b.id === beats[0].id).bpm).toBe(66.5)
  await page.getByRole('button', { name: 'Double the tempo' }).click()
  await expect.poll(async () => (await invoke('library:list')).find(b => b.id === beats[0].id).bpm).toBe(133)
  await page.getByText('Correct BPM / key', { exact: true }).click()

  await page.getByRole('button', { name: 'Beat actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Show sidecar JSON' })).toBeDisabled()
  await page.getByRole('menuitem', { name: 'Delete this beat' }).click()
  await expect(dialog).toContainText(beats[0].title)
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
  expect(await dialog.evaluate(n => n.contains(document.activeElement))).toBe(true)
  await page.screenshot({ path: info.outputPath('delete-confirmation.png') })
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
  // Replace bytes externally: deletion must reject and keep the dialog/record.
  await appendFile(correctedPath, 'changed')
  await page.getByRole('button', { name: 'Beat actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete this beat' }).click()
  await dialog.getByRole('button', { name: 'Delete files', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('changed on disk')
  expect((await invoke('library:list')).some(b => b.id === beats[0].id)).toBe(true)
  await dialog.getByRole('switch').click()
  await dialog.getByRole('button', { name: 'Remove record', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await readFile(correctedPath)).length).toBeGreaterThan(beats[0].sizeBytes)
  await page.locator(`[data-beat-id="${beats[1].id}"]`).click()
  await page.getByRole('button', { name: 'Beat actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete this beat' }).click()
  await dialog.getByRole('button', { name: 'Delete files', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => readFile(beats[1].filePath).then(() => true, () => false)).toBe(false)
  expect(errors).toEqual([])
  // The on-disk assertion is independent of the renderer's optimistic state.
  expect(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).defaultPresetId).toBe('flac')
  await app.context().tracing.stop({ path: info.outputPath('before-restart.zip') })
  await closeOwnedApp(app, page, info)
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => errors.push(error.message))
  await app.context().tracing.start({ screenshots: true, snapshots: true })
  await expect(page.getByTitle('Default export format', { exact: true })).toHaveText('FLAC')
  expect((await invoke('library:list')).some(b => b.id === beats[0].id)).toBe(false)

})

test('native window controls at center and edges', async ({}, info) => {
  test.skip(process.env.SONIC_TEST_HIDDEN === '1', 'Native window controls require a visible desktop window.')
  const measurements = []
  for (const position of [{ x: 22, y: 20 }, { x: 3, y: 3 }, { x: 40, y: 35 }]) {
    const max = page.getByRole('button', { name: 'Maximize', exact: true })
    measurements.push(await max.boundingBox())
    await max.click({ position })
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true)
    await page.getByRole('button', { name: 'Restore', exact: true }).click({ position })
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(false)
  }
  await page.getByRole('button', { name: 'Minimize', exact: true }).click({ position: { x: 3, y: 3 } })
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true)
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.setSize(1024, 680) })
  await menuCheck(page.getByTitle('Default export format', { exact: true }))
  await writeFile(info.outputPath('window-bounds.json'), JSON.stringify(measurements, null, 2))
  await page.screenshot({ path: info.outputPath('native-window.png') })
  await app.context().tracing.stop({ path: info.outputPath('trace.zip') })
  await page.getByRole('button', { name: 'Close', exact: true }).click({ position: { x: 40, y: 35 } })
  await closeOwnedApp(app, page, info, { request: false })
})

test('loaded analysis plus playback and picker input', async ({}, info) => {
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.locator(`[data-beat-id="${beats[2].id}"]`).click()
  await page.getByRole('button', { name: 'Play this beat', exact: true }).click()
  await expect(page.locator('[data-playback-dock]')).toHaveAttribute('data-playback-state', 'playing')
  const analyze = page.getByRole('button', { name: /Analyze audio/ })
  await analyze.click()
  await expect.poll(async () => (await invoke('analysis:status')).running).toBeGreaterThan(0)
  const timings = []
  const queueIds = (await invoke('queue:snapshot')).jobs.map(j => j.id)
  let updates = 0, stopped = false
  const feed = async () => {
    while (!stopped && updates < 100) { await invoke('queue:reorder', updates % 2 ? queueIds : [...queueIds].reverse()); updates++; await new Promise(resolve => setTimeout(resolve, 50)) }
  }
  let feedError
  const feeding = feed().catch(error => { feedError = error })
  try {
    await page.evaluate(() => { window.__frames = []; window.__sampling = true; let last = performance.now(); const frame = now => { window.__frames.push(now - last); last = now; if (window.__sampling) requestAnimationFrame(frame) }; requestAnimationFrame(frame) })
    for (let i = 0; i < 4; i++) {
      const start = performance.now()
      await page.getByRole('button', { name: 'Beat actions' }).click()
      await expect(page.getByRole('menuitem', { name: 'Delete this beat' })).toBeVisible()
      await page.keyboard.press('Escape')
      timings.push({ elapsedMs: performance.now() - start, running: (await invoke('analysis:status')).running })
    }
    await expect.poll(async () => (await invoke('analysis:status')).running, { timeout: 90_000 }).toBe(0)
  } finally {
    stopped = true
    await feeding
  }
  if (feedError) throw feedError
  const frames = await page.evaluate(() => { window.__sampling = false; return window.__frames })
  const analyzed = (await invoke('library:list')).find(b => b.id === beats[2].id)
  expect(analyzed.analysis).not.toBeNull()
  await writeFile(info.outputPath('loaded.json'), JSON.stringify({ workload: '180 seconds mono 22050Hz generated pulse/chord audio, one acoustic analysis worker, local WebAudio preview, queue IPC updates at up to 20Hz, four radial open/Escape cycles', timings, queueUpdates: updates, frameIntervalsMs: frames, analysis: analyzed.analysis }, null, 2))
  expect(errors).toEqual([])
})


test('Windows OS pointer hit testing and draggable title space', async ({}, info) => {
  test.skip(process.env.SONIC_TEST_HIDDEN === '1', 'Windows pointer automation requires a visible desktop window.')
  const state = () => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { bounds: w.getBounds(), content: w.getContentBounds(), hwnd: Number(w.getNativeWindowHandle().readBigUInt64LE()), maximized: w.isMaximized(), minimized: w.isMinimized() } })
  const nativePointer = async (x, y, drag) => {
    const current = await state()
    const point = await app.evaluate(({ screen }, p) => screen.dipToScreenPoint(p), { x: current.content.x + Math.round(x), y: current.content.y + Math.round(y) })
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/native-pointer.ps1'), '-WindowHandle', String(current.hwnd), '-StartX', String(point.x), '-StartY', String(point.y)]
    if (drag) args.push('-Drag', '-EndX', String(point.x + 45), '-EndY', String(point.y + 40))
    try { await promisify(execFile)('powershell.exe', args, { windowsHide: true }) }
    catch (error) {
      if (String(error).includes('could not receive foreground input')) test.skip(true, 'Windows foreground lock prevents OS pointer automation. Run this test with the Sonic test window foreground. Chromium pointer coverage is separate.')
      throw error
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setPosition(80, 80))
  const before = (await state()).bounds
  await nativePointer(330, 20, true)
  await expect.poll(async () => (await state()).bounds.x).not.toBe(before.x)
  for (const offset of [{ x: 22, y: 20 }, { x: 3, y: 3 }, { x: 40, y: 35 }]) {
    const max = await page.getByRole('button', { name: 'Maximize', exact: true }).boundingBox()
    await nativePointer(max.x + offset.x, max.y + offset.y)
    await expect.poll(async () => (await state()).maximized).toBe(true)
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible()
    const restore = await page.getByRole('button', { name: 'Restore', exact: true }).boundingBox()
    await nativePointer(restore.x + offset.x, restore.y + offset.y)
    await expect.poll(async () => (await state()).maximized).toBe(false)
  }
  const min = await page.getByRole('button', { name: 'Minimize', exact: true }).boundingBox()
  await nativePointer(min.x + 3, min.y + 35)
  await expect.poll(async () => (await state()).minimized).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  await writeFile(info.outputPath('os-pointer.json'), JSON.stringify({ beforeDrag: before, final: await state(), input: 'Win32 mouse_event and SetCursorPos; actual OS hit testing' }, null, 2))
})


test('bounded offline control sweep and default scope', async () => {
  expect((await invoke('engine:status')).components.find(c => c.name === 'yt-dlp').available).toBe(false)
  const picker = page.getByTitle('Default export format', { exact: true })
  await menuCheck(picker)
  const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('https://www.youtube.com/watch?v=abcdefghijk'))
    await page.getByRole('button', { name: 'Paste', exact: true }).click()
    await expect(page.getByRole('textbox').first()).toHaveValue('https://www.youtube.com/watch?v=abcdefghijk')
    await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
    await expect.poll(async () => (await invoke('queue:snapshot')).jobs.some(j => j.videoId === 'abcdefghijk' && j.stage === 'failed')).toBe(true)
    const job = (await invoke('queue:snapshot')).jobs.find(j => j.videoId === 'abcdefghijk')
    expect(job.presetId).toBe('original')
    expect(job.error).toMatch(/yt-dlp|installed|engine/i)
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByRole('button', { name: 'Clear done', exact: true }).click()
    expect((await invoke('library:list')).some(b => b.id === beats[0].id)).toBe(true)
    await page.getByRole('switch', { name: 'Start downloads automatically' }).click()
    expect((await invoke('settings:get')).autoStart).toBe(true)
  } finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboard) }
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.getByPlaceholder(/Search/).fill('Offline beat 2')
  await expect(page.locator('[data-beat-id]')).toHaveCount(1)
  await page.getByPlaceholder(/Search/).fill('')
  // Entering a search selects relevance; clearing the text retains the chosen sort.
  await page.getByRole('button', { name: 'Relevance' }).click()
  await page.getByRole('menuitemradio', { name: /Title A/ }).click()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: /^wav$/i }).click()
  await expect(page.locator('[data-beat-id]')).toHaveCount(4)
  await page.getByRole('tab', { name: 'list', exact: true }).click()
  await page.getByRole('tab', { name: 'grid', exact: true }).click()
  await page.getByRole('button', { name: /Theme:/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.locator(`[data-beat-id="${beats[3].id}"]`).click()
  await page.getByRole('button', { name: 'Analyze audio', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click()
  await expect.poll(async () => (await invoke('analysis:status')).running).toBe(0)
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Beat actions' })).toHaveCount(0)
  expect(errors).toEqual([])
})
