import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

let app, page, root, beats, rendererErrors
const invoke = (channel, ...args) => page.evaluate(([name, values]) => window.sonic.invoke(name, ...values), [channel, args])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const beatById = async id => (await invoke('library:list')).find(beat => beat.id === id)
const onDisk = name => readFile(path.join(root, name), 'utf8').then(JSON.parse)

async function chooseImportFile(filePath) {
  await app.evaluate(({ dialog }, selected) => {
    const state = globalThis
    if (state.__collectionsTestDialog) throw new Error('File dialog already owned by a test.')
    state.__collectionsTestDialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, filePath)
  try {
    return await invoke('import:chooseFiles')
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis
      dialog.showOpenDialog = state.__collectionsTestDialog
      delete state.__collectionsTestDialog
    })
  }
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
  // These fixture records intentionally omit newly added fields. Opening them
  // exercises the app's real legacy-record normalization without touching user data.
  beats = await fixtures(root, 18)
  if (info.title.includes('all matching beyond viewport')) {
    const many = Array.from({ length: 80 }, (_, index) => ({
      ...beats[index % beats.length],
      id: `selection-${index}`,
      title: `Selection candidate ${String(index).padStart(3, '0')}`,
      addedAt: Date.now() - index
    }))
    await writeFile(path.join(root, 'library.json'), JSON.stringify([...beats, ...many]))
  }
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => rendererErrors.push(error.message))
})

test.afterEach(async ({}, info) => {
  await closeOwnedApp(app, page, info)
  expect(rendererErrors).toEqual([])
})

test('legacy IDs, annotations, manual membership and ordering survive close/reopen without touching audio', async ({}, info) => {
  const originals = await Promise.all(beats.map(async beat => ({ id: beat.id, filePath: beat.filePath, hash: sha256(await readFile(beat.filePath)) })))
  const initial = await invoke('library:list')
  expect(initial.map(beat => beat.id).sort()).toEqual(beats.map(beat => beat.id).sort())
  const created = await invoke('organization:command', { type: 'create-manual', name: 'Next Single' })
  const first = created.collections.find(collection => collection.name === 'Next Single')
  expect(first).toMatchObject({ type: 'manual', beatIds: [] })
  const other = (await invoke('organization:command', { type: 'create-manual', name: 'Vocal Ideas' })).collections.find(collection => collection.name === 'Vocal Ideas')
  await invoke('organization:command', { type: 'add-members', id: first.id, beatIds: [beats[0].id, beats[1].id] })
  await invoke('organization:command', { type: 'add-members', id: other.id, beatIds: [beats[0].id] })
  await invoke('organization:command', { type: 'reorder-members', id: first.id, beatIds: [beats[1].id, beats[0].id] })
  await invoke('organization:command', { type: 'set-annotation', beatId: beats[0].id, favorite: true, tags: ['Dark', ' dark ', 'Good for vocals'], notes: 'Good hook at 0:48' })
  const saved = await invoke('organization:snapshot')
  expect(saved.collections.find(collection => collection.id === first.id).beatIds).toEqual([beats[1].id, beats[0].id])
  expect(saved.collections.find(collection => collection.id === other.id).beatIds).toEqual([beats[0].id])
  expect(saved.annotations[beats[0].id]).toMatchObject({ favorite: true, tags: ['Dark', 'Good for vocals'], notes: 'Good hook at 0:48' })
  // Renaming an owned export retains its stable ID, so collection membership is unchanged.
  await invoke('library:updateMetadata', beats[0].id, { title: 'Renamed shortlist track' })
  expect((await beatById(beats[0].id)).id).toBe(beats[0].id)
  expect((await invoke('organization:snapshot')).collections.find(collection => collection.id === first.id).beatIds).toContain(beats[0].id)

  await closeOwnedApp(app, page, info)
  await reopen(info)
  const restored = await invoke('organization:snapshot')
  expect(restored).toEqual(saved)
  expect((await onDisk('organization.json')).collections).toEqual(saved.collections)
  expect((await beatById(beats[0].id)).title).toBe('Renamed shortlist track')
  for (const original of originals) {
    const record = await beatById(original.id)
    expect(record).toBeTruthy()
    // An owned rename may change the path, but not the audio contents.
    expect(sha256(await readFile(record.filePath))).toBe(original.hash)
  }
  await invoke('organization:command', { type: 'remove-members', id: first.id, beatIds: [beats[0].id] })
  expect((await invoke('organization:snapshot')).collections.find(collection => collection.id === first.id).beatIds).toEqual([beats[1].id])
  expect(await beatById(beats[0].id)).toBeTruthy()
  await invoke('organization:command', { type: 'delete', id: other.id })
  expect((await invoke('organization:snapshot')).collections.some(collection => collection.id === other.id)).toBe(false)
  expect(await beatById(beats[0].id)).toBeTruthy()
  expect(sha256(await readFile((await beatById(beats[0].id)).filePath))).toBe(originals[0].hash)
})

test('smart rules stay versioned and analysis does not overwrite user annotations', async ({}, info) => {
  const beat = beats[0]
  await invoke('organization:command', { type: 'set-annotation', beatId: beat.id, favorite: true, tags: ['Demo'], notes: 'Keep this groove' })
  const rules = { version: 1, favorite: true, bpmMin: 130, bpmMax: 150, fileState: 'present' }
  const created = await invoke('organization:command', { type: 'create-smart', name: 'Favorite 130–150', rules })
  const smart = created.collections.find(collection => collection.name === 'Favorite 130–150')
  expect(smart).toMatchObject({ type: 'smart', rules })
  await expect(invoke('organization:command', { type: 'add-members', id: smart.id, beatIds: [beat.id] })).rejects.toThrow()
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.getByRole('button', { name: 'Collection: Favorite 130–150' }).click()
  // Null tempo is unknown; it cannot satisfy a positive numeric range.
  await expect(page.locator(`[data-beat-id="${beat.id}"]`)).toHaveCount(0)
  await invoke('library:updateMetadata', beat.id, { bpm: 140 })
  await expect(page.locator(`[data-beat-id="${beat.id}"]`)).toBeVisible()
  const revised = await invoke('organization:command', { type: 'update-smart', id: smart.id, rules: { ...rules, key: 'F# minor' } })
  expect(revised.collections.find(collection => collection.id === smart.id).id).toBe(smart.id)
  // Null key is unknown rather than an accidental match for the requested key.
  await expect(page.locator(`[data-beat-id="${beat.id}"]`)).toHaveCount(0)
  await invoke('library:updateMetadata', beat.id, { key: 'F# minor' })
  await expect(page.locator(`[data-beat-id="${beat.id}"]`)).toBeVisible()
  await invoke('analysis:beat', beat.id, false)
  expect((await invoke('organization:snapshot')).annotations[beat.id]).toMatchObject({ favorite: true, tags: ['Demo'], notes: 'Keep this groove' })
  await closeOwnedApp(app, page, info)
  await reopen(info)
  expect((await invoke('organization:snapshot')).collections.find(collection => collection.id === smart.id).rules).toEqual({ ...rules, key: 'F# minor' })
  expect((await invoke('organization:snapshot')).annotations[beat.id].notes).toBe('Keep this groove')
})

test('malformed organization and batch IPC requests are rejected without changing committed state', async () => {
  const before = await invoke('organization:snapshot')
  const invalid = [
    { type: 'create-manual', name: ' ' },
    { type: 'create-smart', name: 'Bad', rules: { version: 1, arbitraryCode: 'process.exit()' } },
    { type: 'set-annotation', beatId: beats[0].id, notes: 'x'.repeat(4001) },
    { type: 'batch-annotation', beatIds: [beats[0].id], tagsAdd: [''] },
    { type: 'add-members', id: 'missing-collection', beatIds: [beats[0].id] },
    { type: 'delete', id: 'missing-collection' }
  ]
  for (const command of invalid) await expect(invoke('organization:command', command)).rejects.toThrow()
  await expect(invoke('batch:start', { action: 'export', beatIds: [beats[0].id], presetId: 'not-a-preset' })).rejects.toThrow()
  expect(await invoke('organization:snapshot')).toEqual(before)
  expect((await invoke('library:list')).map(beat => beat.id).sort()).toEqual(beats.map(beat => beat.id).sort())
})

test('failed annotation batch keeps committed data and explicit storage retry restores pending changes', async ({}, info) => {
  const id = beats[0].id
  await invoke('organization:command', { type: 'set-annotation', beatId: id, tags: ['Saved'] })
  const stable = await invoke('organization:snapshot')
  const storePath = path.join(root, 'organization.json')
  const displaced = info.outputPath('organization-committed.json')
  await rename(storePath, displaced)
  await mkdir(storePath)
  let repaired = false
  try {
    await expect(invoke('organization:command', { type: 'batch-annotation', beatIds: [id, beats[1].id], favorite: true, tagsAdd: ['Pending'] })).rejects.toThrow()
    expect(await invoke('organization:snapshot')).toEqual(stable)
    expect(JSON.parse(await readFile(displaced, 'utf8')).annotations[id].tags).toEqual(['Saved'])
  } finally {
    await rmdir(storePath)
    await rename(displaced, storePath)
    repaired = true
  }
  expect(repaired).toBe(true)
  expect((await onDisk('organization.json')).annotations[id].tags).toEqual(['Saved'])
  const status = await invoke('storage:status')
  expect(status.find(entry => path.resolve(entry.file).toLowerCase() === path.resolve(storePath).toLowerCase())?.error).toBeTruthy()
  await invoke('storage:retry')
  const recovered = await invoke('organization:snapshot')
  expect(recovered.annotations[id]).toMatchObject({ favorite: true, tags: ['Saved', 'Pending'] })
  expect(recovered.annotations[beats[1].id]).toMatchObject({ favorite: true, tags: ['Pending'] })
  await closeOwnedApp(app, page, info)
  await reopen(info)
  expect((await invoke('organization:snapshot')).annotations).toEqual(recovered.annotations)
})

test('collection and annotation actions leave imported originals byte-identical and at their exact paths', async ({}, info) => {
  const external = info.outputPath('outside-library', 'Original.wav')
  await mkdir(path.dirname(external), { recursive: true })
  await copyFile(beats[0].filePath, external)
  const distinctAudio = await readFile(external)
  distinctAudio.writeInt16LE(12345, 44)
  await writeFile(external, distinctAudio)
  const originalHash = sha256(await readFile(external))
  const selected = await chooseImportFile(external)
  expect(selected.sessionId).toBeTruthy()
  await expect.poll(async () => (await invoke('import:status', selected.sessionId))?.phase, { timeout: 30000 }).toBe('ready')
  const review = await invoke('import:status', selected.sessionId)
  const item = review.items.find(candidate => candidate.filePath === external)
  expect(item?.status).toBe('ready')
  await invoke('import:confirm', selected.sessionId, [item.id])
  const record = (await invoke('library:list')).find(beat => beat.filePath === external)
  expect(record).toMatchObject({ fileOwnership: 'external', sourceKind: 'local' })
  const collection = (await invoke('organization:command', { type: 'create-manual', name: 'External shortlist' })).collections.find(entry => entry.name === 'External shortlist')
  await invoke('organization:command', { type: 'add-members', id: collection.id, beatIds: [record.id] })
  await invoke('organization:command', { type: 'set-annotation', beatId: record.id, favorite: true, tags: ['Original'], notes: 'Do not touch source' })
  await invoke('organization:command', { type: 'remove-members', id: collection.id, beatIds: [record.id] })
  await invoke('organization:command', { type: 'delete', id: collection.id })
  const prepared = await invoke('library:reexport', record.id, 'flac')
  expect(prepared.ok).toBe(true)
  const derived = (await invoke('library:list')).find(beat => beat.filePath === prepared.outputPath)
  expect(derived).toMatchObject({ sourceKind: 'local', fileOwnership: 'sonic-export' })
  const originals = await invoke('organization:command', { type: 'create-smart', name: 'Imported originals',
    rules: { version: 1, sourceKind: 'local', fileOwnership: 'external' } })
  const smart = originals.collections.find(entry => entry.name === 'Imported originals')
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.getByRole('button', { name: 'Collection: Imported originals' }).click()
  await expect(page.locator(`[data-beat-id="${record.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-beat-id="${derived.id}"]`)).toHaveCount(0)
  expect((await beatById(record.id)).filePath).toBe(external)
  expect(sha256(await readFile(external))).toBe(originalHash)
  await closeOwnedApp(app, page, info)
  await reopen(info)
  expect((await beatById(record.id)).filePath).toBe(external)
  expect((await invoke('organization:snapshot')).annotations[record.id].notes).toBe('Do not touch source')
  expect((await invoke('organization:snapshot')).collections.find(entry => entry.id === smart.id).rules.fileOwnership).toBe('external')
  expect(sha256(await readFile(external))).toBe(originalHash)
})

test('batch tag add/remove preserves unrelated annotations in one logical update', async () => {
  await invoke('organization:command', { type: 'set-annotation', beatId: beats[0].id, tags: ['Dark', 'Vocals'], notes: 'Keep note' })
  await invoke('organization:command', { type: 'set-annotation', beatId: beats[1].id, tags: ['Bright'] })
  const applied = await invoke('organization:command', { type: 'batch-annotation', beatIds: [beats[0].id, beats[1].id], tagsAdd: ['Session', ' session '] })
  expect(applied.annotations[beats[0].id]).toMatchObject({ tags: ['Dark', 'Vocals', 'Session'], notes: 'Keep note' })
  expect(applied.annotations[beats[1].id].tags).toEqual(['Bright', 'Session'])
  const removed = await invoke('organization:command', { type: 'batch-annotation', beatIds: [beats[0].id, beats[1].id], tagsRemove: ['SESSION'] })
  expect(removed.annotations[beats[0].id]).toMatchObject({ tags: ['Dark', 'Vocals'], notes: 'Keep note' })
  expect(removed.annotations[beats[1].id].tags).toEqual(['Bright'])
})

test('missing audio does not silently erase stable collection membership', async ({}, info) => {
  const collection = (await invoke('organization:command', { type: 'create-manual', name: 'Offline candidates', beatIds: [beats[0].id] })).collections.find(item => item.name === 'Offline candidates')
  const source = beats[0].filePath
  const displaced = info.outputPath('temporarily-missing.wav')
  await rename(source, displaced)
  try {
    await invoke('library:rescan')
    expect((await beatById(beats[0].id)).missing).toBe(true)
    expect((await invoke('organization:snapshot')).collections.find(item => item.id === collection.id).beatIds).toContain(beats[0].id)
  } finally {
    await rename(displaced, source)
  }
  await invoke('library:rescan')
  expect((await beatById(beats[0].id)).missing).toBe(false)
  expect((await invoke('organization:snapshot')).collections.find(item => item.id === collection.id).beatIds).toContain(beats[0].id)
})

test('batch cancellation reaches terminal status with honest per-item outcomes', async ({}, info) => {
  const request = { action: 'analyze', beatIds: beats.map(beat => beat.id) }
  const started = await invoke('batch:start', request)
  expect(started.request.beatIds).toEqual(request.beatIds)
  await invoke('batch:cancel', started.id)
  await expect.poll(async () => (await invoke('batch:status', started.id))?.status, { timeout: 90000 }).toBe('cancelled')
  const final = await invoke('batch:status', started.id)
  expect(final.finishedAt).toEqual(expect.any(Number))
  expect(final.items.map(item => item.beatId)).toEqual(request.beatIds)
  expect(final.items.every(item => ['completed', 'failed', 'skipped', 'cancelled'].includes(item.status))).toBe(true)
  expect(final.items.some(item => item.status === 'cancelled')).toBe(true)
  for (const item of final.items.filter(item => item.status === 'completed')) {
    expect(item.error).toBeNull()
    expect((await beatById(item.beatId)).analysis).not.toBeNull()
  }
  await writeFile(info.outputPath('batch-cancelled.json'), JSON.stringify(final, null, 2))
})

test('export shortlist snapshots target IDs and publishes only completed copies', async ({}, info) => {
  const targets = [beats[0].id, beats[1].id]
  const sourceHashes = await Promise.all(targets.map(async id => sha256(await readFile((await beatById(id)).filePath))))
  const started = await invoke('batch:start', { action: 'export', beatIds: targets, presetId: 'flac' })
  // A later selection or smart-rule change cannot mutate these accepted targets.
  await invoke('organization:command', { type: 'create-smart', name: 'Unrelated view', rules: { version: 1, favorite: true } })
  await expect.poll(async () => (await invoke('batch:status', started.id))?.status, { timeout: 90000 }).toBe('completed')
  const final = await invoke('batch:status', started.id)
  expect(final.request.beatIds).toEqual(targets)
  expect(final.items.map(item => item.status)).toEqual(['completed', 'completed'])
  for (const [index, item] of final.items.entries()) {
    expect(item.error).toBeNull()
    expect(item.outputPath).toBeTruthy()
    expect(path.extname(item.outputPath).toLowerCase()).toBe('.flac')
    expect((await readFile(item.outputPath)).length).toBeGreaterThan(0)
    expect(sha256(await readFile((await beatById(targets[index])).filePath))).toBe(sourceHashes[index])
  }
  await closeOwnedApp(app, page, info)
  await reopen(info)
  for (const item of final.items) {
    const exported = (await invoke('library:list')).find(beat => beat.filePath === item.outputPath)
    expect(exported).toMatchObject({ fileOwnership: 'sonic-export', format: 'flac' })
  }
  await writeFile(info.outputPath('batch-export.json'), JSON.stringify(final, null, 2))
})

test('selection follows displayed order while preview and text-input shortcuts remain independent', async () => {
  await page.getByRole('button', { name: /Library/ }).first().click()
  await expect(page.locator(`[data-beat-id="${beats[0].id}"]`)).toBeVisible()
  const cards = page.locator('[data-beat-id]')
  const ordered = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-beat-id')))
  expect(ordered).toHaveLength(beats.length)
  await cards.nth(0).getByRole('checkbox').click()
  await cards.nth(2).click({ modifiers: ['Shift'] })
  for (const id of ordered.slice(0, 3)) await expect(page.locator(`[data-beat-id="${id}"]`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator(`[data-beat-id="${ordered[3]}"]`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText('3 selected', { exact: true })).toBeVisible()

  await page.locator(`[data-beat-id="${beats[0].id}"]`).click()
  await expect(page.locator('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready')
  await expect(page.locator('[data-preview-state]')).toContainText(beats[0].title)
  const keyboardCheckbox = page.locator(`[data-beat-id="${ordered[2]}"]`).getByRole('checkbox')
  await keyboardCheckbox.focus()
  await keyboardCheckbox.press('Space')
  await expect(keyboardCheckbox).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible()
  await expect(page.locator('[data-preview-state]')).toContainText(beats[0].title)
  await page.getByRole('button', { name: 'Newest first' }).click()
  await page.getByRole('menuitemradio', { name: 'Oldest first' }).click()
  for (const id of ordered.slice(0, 2)) await expect(page.locator(`[data-beat-id="${id}"]`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')

  // The search field owns Ctrl+A. It must neither select all library rows nor
  // trigger a collection shortcut while the user edits text.
  const search = page.getByPlaceholder('Search title, producer, BPM, key…')
  await search.fill('Offline beat')
  await search.press('ControlOrMeta+A')
  await expect(search).toHaveValue('Offline beat')
  await expect(page.getByText('2 selected', { exact: true })).toHaveCount(0)
  await search.fill('Offline beat 2')
  await expect(page.locator('[data-beat-id]')).toHaveCount(1)
  await search.fill('')
  for (const id of ordered) await expect(page.locator(`[data-beat-id="${id}"]`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')
})

test('right-click preserves a selected group and establishes an unselected row as the new action target', async () => {
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.locator(`[data-beat-id="${beats[0].id}"]`).getByRole('checkbox').click()
  await page.locator(`[data-beat-id="${beats[1].id}"]`).getByRole('checkbox').click()
  await page.locator(`[data-beat-id="${beats[0].id}"]`).click({ button: 'right' })
  await expect(page.getByRole('toolbar', { name: 'Selected beats' })).toContainText('2 selected')
  await page.keyboard.press('Escape')
  await page.locator(`[data-beat-id="${beats[2].id}"]`).click({ button: 'right' })
  await expect(page.getByRole('toolbar', { name: 'Selected beats' })).toContainText('1 selected')
  await expect(page.locator(`[data-beat-id="${beats[2].id}"]`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator(`[data-beat-id="${beats[0].id}"]`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')
})

test('annotation drafts preserve incoming updates to untouched fields', async () => {
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.locator(`[data-beat-id="${beats[0].id}"]`).click()
  const editor = page.getByRole('region', { name: 'Your annotations' })
  const tags = editor.getByRole('textbox', { name: 'User tags' })
  const notes = editor.getByRole('textbox', { name: 'Notes' })
  await expect(editor).toBeVisible()

  // A batch tag change arrives while a note is unsaved. Saving the note must
  // leave the fresh tag intact rather than submit a stale copy of both fields.
  await notes.fill('Unsaved hook at 0:48')
  await invoke('organization:command', { type: 'batch-annotation', beatIds: [beats[0].id], tagsAdd: ['Incoming tag'] })
  await expect(notes).toHaveValue('Unsaved hook at 0:48')
  await expect(tags).toHaveValue('Incoming tag')
  await editor.getByRole('button', { name: 'Save annotations' }).click()
  await expect.poll(async () => (await invoke('organization:snapshot')).annotations[beats[0].id]?.notes).toBe('Unsaved hook at 0:48')
  expect((await invoke('organization:snapshot')).annotations[beats[0].id].tags).toEqual(['Incoming tag'])

  // Reverse the direction: an incoming note must survive a tags-only save.
  await tags.fill('Incoming tag, vocal idea')
  await invoke('organization:command', { type: 'set-annotation', beatId: beats[0].id, notes: 'Latest remote note' })
  await expect(tags).toHaveValue('Incoming tag, vocal idea')
  await expect(notes).toHaveValue('Latest remote note')
  await editor.getByRole('button', { name: 'Save annotations' }).click()
  await expect.poll(async () => (await invoke('organization:snapshot')).annotations[beats[0].id]?.tags).toEqual(['Incoming tag', 'vocal idea'])
  expect((await invoke('organization:snapshot')).annotations[beats[0].id].notes).toBe('Latest remote note')
})

test('select all matching beyond viewport includes every result and clears on scope change', async () => {
  await page.getByRole('button', { name: /Library/ }).first().click()
  const search = page.getByPlaceholder('Search title, producer, BPM, key…')
  await search.fill('Selection candidate')
  await expect(page.locator('[data-beat-id]')).toHaveCount(80)
  await page.getByRole('button', { name: 'Select all 80 matching' }).click()
  await expect(page.getByText('80 selected', { exact: true })).toBeVisible()
  await expect(page.locator('[data-beat-id] input[type="checkbox"]:checked')).toHaveCount(80)
  await page.getByRole('button', { name: 'Favorites', exact: true }).click()
  await expect(page.getByText('80 selected', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'All audio', exact: true }).click()
  await expect(page.locator('[data-beat-id] input[type="checkbox"]:checked')).toHaveCount(0)
})

test('membership changes prune hidden batch targets without selecting new smart results', async () => {
  const manual = (await invoke('organization:command', { type: 'create-manual', name: 'Changing shortlist',
    beatIds: [beats[0].id, beats[1].id] })).collections.find(entry => entry.name === 'Changing shortlist')
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.getByRole('button', { name: 'Collection: Changing shortlist' }).click()
  await page.getByRole('button', { name: 'Select all 2 matching' }).click()
  await expect(page.getByRole('toolbar', { name: 'Selected beats' })).toContainText('2 selected')
  await invoke('organization:command', { type: 'remove-members', id: manual.id, beatIds: [beats[0].id] })
  await expect(page.getByRole('toolbar', { name: 'Selected beats' })).toContainText('1 selected')
  await page.getByRole('button', { name: 'Favorite selected', exact: true }).click()
  await expect.poll(async () => (await invoke('organization:snapshot')).annotations[beats[1].id]?.favorite).toBe(true)
  expect((await invoke('organization:snapshot')).annotations[beats[0].id]?.favorite).not.toBe(true)

  const smart = (await invoke('organization:command', { type: 'create-smart', name: 'Live favorites',
    rules: { version: 1, favorite: true } })).collections.find(entry => entry.name === 'Live favorites')
  await page.getByRole('button', { name: 'Collection: Live favorites' }).click()
  await expect(page.getByRole('toolbar', { name: 'Selected beats' })).toHaveCount(0)
  await invoke('organization:command', { type: 'set-annotation', beatId: beats[0].id, favorite: true })
  await expect(page.locator(`[data-beat-id="${beats[0].id}"]`)).toBeVisible()
  await expect(page.getByRole('toolbar', { name: 'Selected beats' })).toHaveCount(0)
  expect((await invoke('organization:snapshot')).collections.find(entry => entry.id === smart.id).type).toBe('smart')
})

test('producer can tag a shortlist, save a project collection, and restore its active view', async ({}, info) => {
  await page.getByRole('button', { name: /Library/ }).first().click()
  for (const beat of beats.slice(0, 2)) await page.locator(`[data-beat-id="${beat.id}"]`).getByRole('checkbox').click()
  await expect(page.getByRole('toolbar', { name: 'Selected beats' })).toContainText('2 selected')
  await page.getByRole('button', { name: 'Add tag to selected' }).click()
  const tagDialog = page.getByRole('dialog', { name: 'Add tag to selected' })
  await tagDialog.getByRole('textbox', { name: 'User tag' }).fill('Project idea')
  await tagDialog.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await invoke('organization:snapshot')).annotations[beats[0].id]?.tags).toContain('Project idea')
  expect((await invoke('organization:snapshot')).annotations[beats[1].id].tags).toContain('Project idea')

  await page.getByRole('button', { name: 'New collection' }).click()
  const create = page.getByRole('dialog', { name: 'New project collection' })
  await create.getByRole('textbox', { name: 'Collection name' }).fill('Next Single')
  await create.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Add to collection' }).click()
  const add = page.getByRole('dialog', { name: 'Add selected to collection' })
  await add.getByRole('combobox', { name: 'Target collection' }).selectOption({ label: 'Next Single' })
  await add.getByRole('button', { name: 'Save' }).click()
  const collection = (await invoke('organization:snapshot')).collections.find(item => item.name === 'Next Single')
  expect(collection.beatIds).toEqual(beats.slice(0, 2).map(beat => beat.id))

  await page.getByRole('button', { name: 'Collection: Next Single' }).click()
  await expect(page.locator('[data-beat-id]')).toHaveCount(2)
  await expect(page.getByRole('toolbar', { name: 'Selected beats' })).toHaveCount(0)
  await closeOwnedApp(app, page, info)
  await reopen(info)
  await page.getByRole('button', { name: /Library/ }).first().click()
  await expect(page.getByRole('button', { name: 'Collection: Next Single' })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('[data-beat-id]')).toHaveCount(2)
  expect((await invoke('organization:snapshot')).collections.find(item => item.id === collection.id).beatIds).toEqual(collection.beatIds)
})
