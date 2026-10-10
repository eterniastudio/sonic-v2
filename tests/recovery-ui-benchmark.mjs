import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'
import { recoveryFixtures, moveRecoveryTrack } from './recovery-fixtures.mjs'

// Focused real-app evidence; deliberately separate from the service benchmark.
test('10k library: keyboard, frames and playback remain responsive around recovery and cancellation', async ({}, info) => {
  test.setTimeout(180_000)
  const root = await createOwnedProfile(info)
  const fixture = await recoveryFixtures(root, { manyCount: 24 })
  const missing = fixture.beats.slice(4)
  const present = fixture.beats[2]
  const picked = path.join(root, 'performance-picked')
  const moved = path.join(picked, 'moved')
  const irrelevant = path.join(picked, 'unrelated')
  await mkdir(irrelevant, { recursive: true })
  for (const beat of missing) { await moveRecoveryTrack(beat, moved); beat.missing = true }
  for (let start = 0; start < 2048; start += 128) {
    await Promise.all(Array.from({ length: 128 }, (_, offset) => writeFile(path.join(irrelevant, `other-${start + offset}.wav`), Buffer.alloc(128))))
  }
  const beats = [...fixture.beats]
  while (beats.length < 10_000) beats.push({ ...structuredClone(present), id: `large-library-${beats.length}`,
    title: `Present library record ${beats.length}`, thumbnail: null, analysis: null })
  fixture.organization.collections.push({ id: 'performance-shortlist', type: 'manual', name: 'Performance shortlist',
    beatIds: [present.id, ...missing.map(beat => beat.id)] })
  fixture.organization.view.activeCollectionId = 'performance-shortlist'
  await writeFile(path.join(root, 'library.json'), JSON.stringify(beats))
  await writeFile(path.join(root, 'organization.json'), JSON.stringify(fixture.organization))
  let app, page
  const errors = []
  const evidence = { libraryRecords: beats.length, visibleRecords: 25, missingCandidates: 24, irrelevantFiles: 2048,
    profile: root, limitations: ['9,972 extra records share one real present fixture path; only 24 missing paths are unique and eligible for recovery.',
      'The saved 25-record collection bounds rendered rows while the real application holds and indexes all 10,000 records. This does not measure rendering all 10,000 rows.',
      'A test-owned opendir barrier establishes scanning and cancellation ordering. Its held interval is reported separately from released natural disk scanning.',
      'Native picker output is stubbed to the isolated fixture folder; candidate reads, hashing, IPC, UI, keyboard handling and audio playback are real.'] }
  try {
    app = await launchOwnedApp(root, info)
    page = await readyPage(app, root)
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('nav').getByRole('button', { name: /^Library/ }).first().click()
    await expect(page.locator('[data-beat-id]')).toHaveCount(25, { timeout: 30_000 })
    expect(await page.evaluate(async () => (await window.sonic.invoke('library:list')).length)).toBe(10_000)
    const player = page.locator('[data-playback-dock]')
    await page.locator(`[data-beat-id="${present.id}"]`).getByRole('button', { name: `Play ${present.title}`, exact: true }).click()
    await expect(player).toHaveAttribute('data-playback-state', 'playing', { timeout: 20_000 })
    const position = async () => Number(await player.getByLabel('Seek preview').inputValue())
    await expect.poll(position).toBeGreaterThan(0.1)
    for (const beat of missing) await page.locator(`[data-beat-id="${beat.id}"]`).getByRole('checkbox').check()
    const trigger = page.getByRole('button', { name: 'Find missing files…', exact: true })

    await page.evaluate(() => {
      const state = globalThis.__recoveryPerf = { section: 'before', frames: [], keys: [], statuses: [] }
      let previous = performance.now()
      const frame = now => { state.frames.push({ section: state.section, at: now, gap: now - previous }); previous = now; state.frameId = requestAnimationFrame(frame) }
      state.frameId = requestAnimationFrame(frame)
      state.keyHandler = event => { if (event.key === 'Tab') { const start = performance.now(), section = state.section;
        requestAnimationFrame(() => state.keys.push({ section, at: start, latency: performance.now() - start,
          focused: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.slice(0, 80) || document.activeElement?.tagName })) } }
      document.addEventListener('keydown', state.keyHandler, true)
      state.observer = new MutationObserver(() => { const status = document.querySelector('[role="dialog"] [role="status"]')?.textContent;
        if (status && state.statuses.at(-1)?.text !== status) {
          const at = performance.now()
          state.statuses.push({ section: state.section, at, text: status })
          if (state.section === 'natural-scan' && status.includes('24 of 24')) state.naturalReadyAt ??= at
        } })
      state.observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    const section = name => page.evaluate(name => { globalThis.__recoveryPerf.section = name;
      if (name === 'natural-scan') globalThis.__recoveryPerf.naturalStartedAt = performance.now() }, name)
    const tabs = async count => {
      for (let i = 0; i < count; i++) {
        const previous = await page.evaluate(() => globalThis.__recoveryPerf.keys.length)
        await page.keyboard.press('Tab')
        await expect.poll(() => page.evaluate(() => globalThis.__recoveryPerf.keys.length)).toBeGreaterThan(previous)
      }
    }
    await tabs(8)
    const installGate = () => app.evaluate(async ({ dialog }, folder) => {
      const { createRequire, syncBuiltinESMExports } = await import('node:module')
      const fs = createRequire(process.cwd() + '/package.json')('node:fs/promises')
      let release
      const state = globalThis.__recoveryPerfGate = { folder, fs, original: fs.opendir, picker: dialog.showOpenDialog,
        entered: false, released: false, cancelled: false, gate: new Promise(resolve => { release = resolve }), release: null }
      state.release = () => { state.released = true; release() }
      fs.opendir = async (...args) => { if (String(args[0]) === folder && !state.entered) { state.entered = true; await state.gate }; return state.original(...args) }
      syncBuiltinESMExports()
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    }, picked)
    const releaseGate = () => app.evaluate(() => globalThis.__recoveryPerfGate.release())
    const restoreGate = () => app.evaluate(async ({ dialog }) => {
      const state = globalThis.__recoveryPerfGate
      if (!state) return
      state.release(); state.fs.opendir = state.original; dialog.showOpenDialog = state.picker
      const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports()
      delete globalThis.__recoveryPerfGate
    })
    await installGate()
    await section('barrier-held')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Find missing files', exact: true })
    await expect.poll(() => app.evaluate(() => globalThis.__recoveryPerfGate.entered)).toBe(true)
    await expect(dialog.getByRole('status')).toContainText('Scanning selected location')
    await tabs(8)
    evidence.audioBeforeNaturalScan = await position()
    await section('natural-scan')
    const started = performance.now()
    await releaseGate()
    await Promise.all([tabs(8), expect(dialog.getByRole('button', { name: 'Reconnect 24 tracks', exact: true })).toBeEnabled({ timeout: 30_000 })])
    evidence.naturalScanAndEightInputsMs = performance.now() - started
    evidence.audioAfterNaturalScan = await position()
    expect(evidence.audioAfterNaturalScan).toBeGreaterThan(evidence.audioBeforeNaturalScan)
    await expect(dialog.locator('[data-recovery-beat-id]')).toHaveCount(24)
    await restoreGate()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await section('after')
    await tabs(8)

    // A separate deterministic cancellation case; this held time is not latency.
    await installGate()
    await section('cancel-barrier-held')
    await trigger.click()
    await expect.poll(() => app.evaluate(() => globalThis.__recoveryPerfGate.entered)).toBe(true)
    await expect(dialog.getByRole('status')).toContainText('Scanning selected location')
    const cancelStarted = performance.now()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await releaseGate()
    await expect(dialog).toHaveCount(0)
    evidence.cancelClickReleaseAndCloseMs = performance.now() - cancelStarted
    await restoreGate()
    await expect(player).toHaveAttribute('data-playback-state', 'playing')
    evidence.audioAtEnd = await position()
    expect(evidence.audioAtEnd).toBeGreaterThan(evidence.audioAfterNaturalScan)
    const library = await page.evaluate(() => window.sonic.invoke('library:list'))
    expect(library).toHaveLength(10_000)
    for (const beat of missing) expect(library.find(item => item.id === beat.id)).toMatchObject({ filePath: beat.filePath, missing: true })
    evidence.samples = await page.evaluate(() => {
      const state = globalThis.__recoveryPerf
      cancelAnimationFrame(state.frameId); document.removeEventListener('keydown', state.keyHandler, true); state.observer.disconnect()
      return { frames: state.frames, keys: state.keys, statuses: state.statuses,
        naturalStartedAt: state.naturalStartedAt, naturalReadyAt: state.naturalReadyAt }
    })
    const summarize = values => { const sorted = [...values].sort((a, b) => a - b); return { count: values.length,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: Math.max(...values) } }
    evidence.summary = Object.fromEntries(['before', 'barrier-held', 'natural-scan', 'after'].map(name => [name, {
      keyToNextFrameMs: summarize(evidence.samples.keys.filter(item => item.section === name &&
        (name !== 'natural-scan' || item.at < evidence.samples.naturalReadyAt)).map(item => item.latency)),
      frameIntervalMs: summarize(evidence.samples.frames.filter(item => item.section === name &&
        (name !== 'natural-scan' || item.at < evidence.samples.naturalReadyAt)).map(item => item.gap)) }]))
    evidence.naturalScanToUiReadyMs = evidence.samples.naturalReadyAt - evidence.samples.naturalStartedAt
    expect(evidence.summary['natural-scan'].keyToNextFrameMs.count).toBeGreaterThan(0)
    expect(evidence.samples.statuses.some(item => item.text.includes('Scanning selected location'))).toBe(true)
    expect(evidence.samples.statuses.some(item => item.text.includes('24 of 24'))).toBe(true)
    await page.screenshot({ path: info.outputPath('recovery-performance-10k.png') })
    expect(errors).toEqual([])
  } finally {
    evidence.rendererErrors = errors
    await writeFile(info.outputPath('recovery-performance-ui.json'), JSON.stringify(evidence, null, 2))
    if (app) await app.evaluate(async ({ dialog }) => {
      const state = globalThis.__recoveryPerfGate
      if (state) { state.release(); state.fs.opendir = state.original; dialog.showOpenDialog = state.picker;
        const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports() }
    }).catch(() => {})
    await closeOwnedApp(app, page, info)
  }
})
