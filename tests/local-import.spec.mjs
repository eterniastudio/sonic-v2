import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

let app, page, root, externalDir, originals, rendererErrors
const invoke = (channel, ...args) => page.evaluate(([name, values]) => window.sonic.invoke(name, ...values), [channel, args])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const execute = promisify(execFile)

async function externalSnapshot() {
  const names = (await readdir(externalDir)).sort()
  return Promise.all(names.map(async name => ({ name, sha256: hash(await readFile(path.join(externalDir, name))) })))
}

async function selectWithOwnedDialog(channel, paths, ...args) {
  // The selection originates in Electron's main process. There is deliberately
  // no renderer IPC that accepts a filesystem path from this test.
  await app.evaluate(({ dialog }, selected) => {
    const state = globalThis
    if (state.__sonicImportTestDialog) throw new Error('Another test owns the file dialog.')
    state.__sonicImportTestDialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected })
  }, paths)
  try {
    return await invoke(channel, ...args)
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis
      if (state.__sonicImportTestDialog) {
        dialog.showOpenDialog = state.__sonicImportTestDialog
        delete state.__sonicImportTestDialog
      }
    })
  }
}

async function review(sessionId) {
  await expect.poll(async () => (await invoke('import:status', sessionId))?.phase, { timeout: 30000 }).toBe('ready')
  return invoke('import:status', sessionId)
}

async function imported(id) {
  return (await invoke('library:list')).find(beat => beat.id === id)
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
  const beats = await fixtures(root, 18)
  externalDir = info.outputPath('external-audio')
  await mkdir(externalDir, { recursive: true })
  // Change one PCM sample, yielding valid audio that does not match the four
  // preloaded library fixtures by path or fingerprint.
  const wav = await readFile(beats[0].filePath)
  for (const [name, sample] of [['Local pulse.wav', 5000], ['Second pulse.wav', 6000]]) {
    const bytes = Buffer.from(wav)
    bytes.writeInt16LE(sample, 44)
    await writeFile(path.join(externalDir, name), bytes)
  }
  originals = await externalSnapshot()
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => rendererErrors.push(error.message))
})

test.afterEach(async ({}, info) => {
  await closeOwnedApp(app, page, info)
  expect(rendererErrors).toEqual([])
})

test('file import supports review, audition, correction, analysis, export, restart and record-only removal', async ({}, info) => {
  const source = path.join(externalDir, 'Local pulse.wav')
  const choice = await selectWithOwnedDialog('import:chooseFiles', [source])
  expect(choice.sessionId).toBeTruthy()
  const pending = await review(choice.sessionId)
  const item = pending.items.find(candidate => path.resolve(candidate.filePath) === path.resolve(source))
  expect(item?.status).toBe('ready')
  const confirmed = await invoke('import:confirm', choice.sessionId, [item.id])
  expect(confirmed.phase).toBe('done')
  expect(confirmed.items.find(candidate => candidate.id === item.id).status).toBe('imported')

  const record = (await invoke('library:list')).find(beat => path.resolve(beat.filePath) === path.resolve(source))
  expect(record).toBeTruthy()
  expect(record.fileOwnership).toBe('external')
  expect(record.sourceKind).toBe('local')
  expect(record.sidecarPath).toBeNull()
  expect(record.fingerprint).toBe(hash(await readFile(source)))
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.getByPlaceholder('Search title, producer, BPM, key…').fill('Local pulse')
  const card = page.locator(`[data-beat-id="${record.id}"]`)
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.locator('[data-preview-state]')).toHaveAttribute('data-preview-state', 'inspecting')
  await page.getByRole('button', { name: 'Play this beat', exact: true }).click()
  await expect(page.locator('[data-playback-dock]')).toHaveAttribute('data-playback-state', 'playing')

  const corrected = await invoke('library:updateMetadata', record.id, { bpm: 136, key: 'F# minor' })
  expect(corrected.bpm).toBe(136)
  expect(corrected.key).toBe('F# minor')
  expect(corrected.camelot).toBe('11A')
  expect(corrected.filePath).toBe(source)
  const analysis = await invoke('analysis:beat', record.id, false)
  expect(analysis.ok, analysis.error ?? 'Acoustic analysis did not complete.').toBe(true)
  expect((await imported(record.id)).analysis).not.toBeNull()
  const exported = await invoke('library:reexport', record.id, 'flac')
  expect(exported.ok, exported.error ?? 'Re-export did not complete.').toBe(true)
  expect(path.resolve(exported.outputPath)).not.toBe(path.resolve(source))
  expect((await readFile(exported.outputPath)).length).toBeGreaterThan(0)
  const exportRecord = (await invoke('library:list')).find(beat => beat.filePath === exported.outputPath)
  expect(exportRecord).toMatchObject({ fileOwnership: 'sonic-export', bpm: 136, key: 'F# minor', camelot: '11A' })
  const sidecar = JSON.parse(await readFile(exportRecord.sidecarPath, 'utf8'))
  expect(sidecar.metadata).toMatchObject({ bpm: 136, key: 'F# minor', camelot: '11A' })
  expect(sidecar.output.fingerprint).toBe(hash(await readFile(exported.outputPath)))
  const { stdout } = await execute(path.join(root, 'engine', 'ffprobe.exe'),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', exported.outputPath],
    { windowsHide: true, timeout: 60_000 })
  const media = JSON.parse(stdout)
  expect(media.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'flac')).toBe(true)
  const tags = Object.fromEntries(Object.entries(media.format.tags ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
  expect(tags.tbpm ?? tags.bpm).toBe('136')
  expect(tags.tkey ?? tags.key ?? tags.initialkey).toBe('F# minor')
  expect(await externalSnapshot()).toEqual(originals)

  await closeOwnedApp(app, page, info)
  await reopen(info)
  const restored = await imported(record.id)
  expect(restored).toMatchObject({ bpm: 136, key: 'F# minor', camelot: '11A', fileOwnership: 'external', filePath: source })
  expect(restored.analysis).not.toBeNull()
  expect(await externalSnapshot()).toEqual(originals)
  await expect(invoke('library:remove', record.id, true, { filePath: source, fingerprint: restored.fingerprint })).rejects.toThrow(/externally owned|keeping the file/i)
  expect(await imported(record.id)).toBeTruthy()
  await invoke('library:remove', record.id, false, { filePath: source, fingerprint: restored.fingerprint })
  expect(await imported(record.id)).toBeUndefined()
  expect(await externalSnapshot()).toEqual(originals)
  await closeOwnedApp(app, page, info)
  await reopen(info)
  expect(await imported(record.id)).toBeUndefined()
  expect(await externalSnapshot()).toEqual(originals)
  await writeFile(info.outputPath('import-restored.json'), JSON.stringify({ imported: record, corrected, restored, reexport: exported, sidecar, tags, externalFilesUnchanged: true }, null, 2))
})

test('repeated selection reports an indexed duplicate and does not create another record', async () => {
  const source = path.join(externalDir, 'Local pulse.wav')
  const first = await selectWithOwnedDialog('import:chooseFiles', [source])
  const ready = await review(first.sessionId)
  const item = ready.items.find(candidate => candidate.filePath === source)
  expect(item?.status).toBe('ready')
  await invoke('import:confirm', first.sessionId, [item.id])
  const before = (await invoke('library:list')).filter(beat => path.resolve(beat.filePath) === path.resolve(source))
  expect(before).toHaveLength(1)

  const second = await selectWithOwnedDialog('import:chooseFiles', [source])
  const duplicate = await review(second.sessionId)
  expect(duplicate.items.find(candidate => candidate.filePath === source)?.status).toBe('already-indexed')
  await invoke('import:confirm', second.sessionId, duplicate.items.map(candidate => candidate.id))
  const after = (await invoke('library:list')).filter(beat => path.resolve(beat.filePath) === path.resolve(source))
  expect(after).toHaveLength(1)
  expect(after[0].id).toBe(before[0].id)
  expect(await externalSnapshot()).toEqual(originals)
})

test('one missing selected file fails independently while another imports', async ({}, info) => {
  const first = path.join(externalDir, 'Local pulse.wav')
  const disappeared = path.join(externalDir, 'Second pulse.wav')
  const choice = await selectWithOwnedDialog('import:chooseFiles', [first, disappeared])
  const pending = await review(choice.sessionId)
  expect(pending.items.filter(item => item.status === 'ready')).toHaveLength(2)
  await writeFile(info.outputPath('before-partial-confirm.json'), JSON.stringify(pending, null, 2))
  // Fault injection is limited to this disposable external fixture, after
  // review and before confirmation. It is not an original-user-file test.
  const { unlink } = await import('node:fs/promises')
  await unlink(disappeared)
  const result = await invoke('import:confirm', choice.sessionId, pending.items.map(item => item.id))
  expect(result.items.find(item => item.filePath === first)?.status).toBe('imported')
  expect(result.items.find(item => item.filePath === disappeared)?.status).toBe('failed')
  expect((await invoke('library:list')).filter(beat => beat.filePath === first)).toHaveLength(1)
  expect((await invoke('library:list')).filter(beat => beat.filePath === disappeared)).toHaveLength(0)
  expect(hash(await readFile(first))).toBe(originals.find(entry => entry.name === path.basename(first)).sha256)
  await closeOwnedApp(app, page, info)
  await reopen(info)
  expect((await invoke('library:list')).filter(beat => beat.filePath === first)).toHaveLength(1)
  expect((await invoke('library:list')).filter(beat => beat.filePath === disappeared)).toHaveLength(0)
})

test('folder review respects recursion and cancellation before importing originals', async ({}, info) => {
  const folder = info.outputPath('selected-folder')
  const nested = path.join(folder, 'nested')
  await mkdir(nested, { recursive: true })
  const template = await readFile(path.join(externalDir, 'Local pulse.wav'))
  const top = path.join(folder, 'Top.wav')
  const deep = path.join(nested, 'Deep.wav')
  for (const [target, sample] of [[top, 7000], [deep, 8000]]) {
    const bytes = Buffer.from(template)
    bytes.writeInt16LE(sample, 44)
    await writeFile(target, bytes)
  }
  const expected = new Map([[top, hash(await readFile(top))], [deep, hash(await readFile(deep))]])

  const shallow = await selectWithOwnedDialog('import:chooseFolder', [folder], false)
  const shallowReview = await review(shallow.sessionId)
  expect(shallowReview.items.map(item => item.filePath)).toEqual([top])
  const cancelled = await invoke('import:cancel', shallow.sessionId)
  expect(cancelled.phase).toBe('cancelled')
  expect((await invoke('library:list')).some(beat => beat.filePath === top)).toBe(false)

  const recursive = await selectWithOwnedDialog('import:chooseFolder', [folder], true)
  const recursiveReview = await review(recursive.sessionId)
  expect(recursiveReview.items.map(item => item.filePath).sort()).toEqual([top, deep].sort())
  expect(recursiveReview.items.every(item => item.status === 'ready')).toBe(true)
  const result = await invoke('import:confirm', recursive.sessionId, recursiveReview.items.map(item => item.id))
  expect(result.items.map(item => item.status)).toEqual(['imported', 'imported'])
  expect((await invoke('library:list')).filter(beat => expected.has(beat.filePath))).toHaveLength(2)
  await closeOwnedApp(app, page, info)
  await reopen(info)
  for (const [filePath, digest] of expected) {
    expect(hash(await readFile(filePath))).toBe(digest)
    const restored = (await invoke('library:list')).find(beat => beat.filePath === filePath)
    expect(restored).toMatchObject({ fileOwnership: 'external', sourceKind: 'local', sidecarPath: null })
  }
  expect(await externalSnapshot()).toEqual(originals)
})

test('invalid renderer import arguments never open a picker, and UI labels protect originals', async () => {
  const source = path.join(externalDir, 'Local pulse.wav')
  const countBefore = (await invoke('library:list')).length
  await app.evaluate(({ dialog }) => {
    const state = globalThis
    state.__sonicImportTestGuard = { original: dialog.showOpenDialog, calls: 0 }
    dialog.showOpenDialog = async () => {
      state.__sonicImportTestGuard.calls++
      throw new Error('Invalid IPC reached the native file picker.')
    }
  })
  let pickerCalls
  try {
    await expect(invoke('import:chooseFiles', source)).rejects.toThrow(/Invalid import:chooseFiles request/)
    await expect(invoke('import:chooseFolder', 'true')).rejects.toThrow(/Invalid import:chooseFolder request/)
    await expect(invoke('import:confirm', 'test-session', { filePath: source })).rejects.toThrow(/Invalid import:confirm request/)
    pickerCalls = await app.evaluate(() => globalThis.__sonicImportTestGuard.calls)
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis
      dialog.showOpenDialog = state.__sonicImportTestGuard.original
      delete state.__sonicImportTestGuard
    })
  }
  expect(pickerCalls).toBe(0)
  expect((await invoke('library:list')).length).toBe(countBefore)

  await page.getByRole('button', { name: /Library/ }).first().click()
  await expect(page.getByRole('button', { name: 'Import audio', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Import audio', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Import audio' })
  await expect(modal).toContainText('without moving, renaming, retagging, or deleting the originals')
  await expect(modal.getByRole('button', { name: 'Choose files' })).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Choose folder' })).toBeVisible()
  await expect(modal.getByText('Include subfolders when importing a folder')).toBeVisible()
  await modal.getByRole('button', { name: 'Close' }).last().click()

  const choice = await selectWithOwnedDialog('import:chooseFiles', [source])
  const pending = await review(choice.sessionId)
  await invoke('import:confirm', choice.sessionId, [pending.items[0].id])
  const record = (await invoke('library:list')).find(beat => beat.filePath === source)
  const card = page.locator(`[data-beat-id="${record.id}"]`)
  await expect(card).toBeVisible()
  await card.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Beat actions' })
  await expect(menu.getByRole('menuitem', { name: 'Rename in library…' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Export prepared copy…' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Remove from library…' }).click()
  const removal = page.getByRole('dialog', { name: /Remove from library/ })
  await expect(removal).toContainText('The imported original remains in its folder, unchanged.')
  await expect(removal.getByRole('button', { name: 'Remove from library' })).toBeVisible()
  await expect(removal.getByText('Also delete the audio and sidecar')).toHaveCount(0)
  await removal.getByRole('button', { name: 'Cancel' }).click()
  expect(await externalSnapshot()).toEqual(originals)
  expect((await invoke('library:list')).length).toBe(countBefore + 1)
})
