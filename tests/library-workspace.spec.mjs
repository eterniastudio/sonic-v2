import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

let app, page, root, beats, errors
const invoke = (channel, ...args) => page.evaluate(([channel, args]) => window.sonic.invoke(channel, ...args), [channel, args])
const navigate = name => page.locator('nav').getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
const card = id => page.locator(`[data-beat-id="${id}"]`)
const search = () => page.getByPlaceholder('Search title, producer, BPM, key…')
const scroll = () => page.locator('[data-library-scroll]')
const checkedIds = () => page.locator('[data-beat-id]').evaluateAll(nodes => nodes
  .filter(node => node.querySelector('input[type="checkbox"]:checked'))
  .map(node => node.dataset.beatId))

test.beforeEach(async ({}, info) => {
  app = null; errors = []
  root = await createOwnedProfile(info)
  const originals = await fixtures(root, 90)
  beats = Array.from({ length: 40 }, (_, index) => ({ ...originals[index % 4],
    id: `workspace-${index}`, title: `Offline beat ${String(index).padStart(2, '0')}`,
    bpm: 140, key: 'A minor', camelot: '8A', addedAt: Date.now() - index }))
  await writeFile(path.join(root, 'library.json'), JSON.stringify(beats))
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1100 })
  await navigate('Library')
  await expect(card(beats[0].id)).toBeVisible()
})

test.afterEach(async ({}, info) => {
  await closeOwnedApp(app, page, info)
  expect(errors).toEqual([])
})

for (const layout of ['grid', 'list']) {
  test(`${layout}: filtered collection, shortlist, inspector and scroll survive navigation without replacing playback`, async () => {
    await invoke('organization:command', { type: 'create-manual', name: 'Working set', beatIds: beats.slice(0, 32).map(beat => beat.id) })
    await page.getByRole('button', { name: 'Collection: Working set', exact: true }).click()
    if (layout === 'list') await page.getByRole('tablist', { name: 'Layout' }).getByRole('tab').nth(1).click()
    await search().fill('Offline')
    await page.getByRole('button', { name: 'Filters', exact: true }).click()
    await page.getByLabel('Target BPM').fill('140')
    await page.getByLabel('BPM tolerance').fill('4')
    await page.getByRole('switch', { name: 'Include half and double time' }).click()
    await page.getByLabel('Key or Camelot').fill('8A')
    await page.getByRole('button', { name: '120–150', exact: true }).click()
    await page.getByRole('button', { name: 'wav', exact: true }).click()
    await page.getByRole('button', { name: 'present', exact: true }).click()
    await page.getByRole('button', { name: 'incomplete', exact: true }).click()
    for (const beat of beats.slice(0, 3)) await card(beat.id).getByRole('checkbox').click()
    await expect.poll(checkedIds).toEqual(beats.slice(0, 3).map(beat => beat.id))
    await card(beats[3].id).getByText(beats[3].title, { exact: true }).click()
    await expect(page.locator('[data-preview-state]')).toContainText(beats[3].title)
    await page.getByRole('button', { name: 'Play displayed results', exact: true }).click()
    const dock = page.locator('[data-playback-dock]')
    await expect(dock).toHaveAttribute('data-playback-state', 'playing', { timeout: 20000 })
    await expect(dock).toContainText('Working set \u00b7 1 of 32')
    const before = Number(await dock.getByLabel('Seek preview').inputValue())
    const target = await scroll().evaluate(node => { node.scrollTop = Math.min(500, node.scrollHeight - node.clientHeight); return node.scrollTop })
    expect(target).toBeGreaterThan(50)
    for (const destination of ['Download', 'Settings']) {
      await navigate(destination)
      await expect(scroll()).toHaveCount(0)
      await navigate('Library')
      await expect(card(beats[0].id)).toHaveCount(1)
      await expect(search()).toHaveValue('Offline')
      await expect(page.getByLabel('Target BPM')).toHaveValue('140')
      await expect(page.getByLabel('BPM tolerance')).toHaveValue('4')
      await expect(page.getByLabel('Key or Camelot')).toHaveValue('8A')
      await expect(page.getByRole('switch', { name: 'Include half and double time' })).toBeChecked()
      await expect(page.getByRole('button', { name: 'present', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('button', { name: 'incomplete', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('button', { name: 'Filters (6)', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Relevance', exact: true })).toBeVisible()
      await expect(page.getByRole('tablist', { name: 'Layout' }).getByRole('tab').nth(layout === 'list' ? 1 : 0)).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('[data-preview-state]')).toContainText(beats[3].title)
      await expect.poll(checkedIds).toEqual(beats.slice(0, 3).map(beat => beat.id))
      await expect.poll(() => scroll().evaluate(node => node.scrollTop)).toBeCloseTo(target, 0)
      await expect(dock).toHaveAttribute('data-playback-state', 'playing')
      await expect(dock).toHaveAttribute('data-playback-beat-id', beats[0].id)
      await expect(dock).toContainText('Working set \u00b7 1 of 32')
    }
    expect(Number(await dock.getByLabel('Seek preview').inputValue())).toBeGreaterThan(before)
    // The inspector set the range anchor to the fourth beat; it must survive too.
    await card(beats[5].id).getByText(beats[5].title, { exact: true }).click({ modifiers: ['Shift'] })
    await expect.poll(checkedIds).toEqual(beats.slice(0, 6).map(beat => beat.id))
    await search().fill('no matching results')
    await expect.poll(checkedIds).toEqual([])
    for (let index = 1; index <= 3; index++) {
      await dock.getByRole('button', { name: 'Next track', exact: true }).click()
      await expect(dock).toHaveAttribute('data-playback-beat-id', beats[index].id)
      await expect(dock).toHaveAttribute('data-playback-state', 'playing')
      await expect(dock).toContainText(`Working set \u00b7 ${index + 1} of 32`)
    }
  })
}

test('membership changes and deletion while away prune stale selection and inspector; explicit scope changes clear selection', async () => {
  const snapshot = await invoke('organization:command', { type: 'create-manual', name: 'Shortlist', beatIds: beats.slice(0, 4).map(beat => beat.id) })
  const collection = snapshot.collections.find(item => item.name === 'Shortlist')
  await page.getByRole('button', { name: 'Collection: Shortlist', exact: true }).click()
  for (const beat of beats.slice(0, 3)) await card(beat.id).getByRole('checkbox').click()
  await card(beats[3].id).click()
  await navigate('Settings')
  await expect(scroll()).toHaveCount(0)
  await invoke('organization:command', { type: 'remove-members', id: collection.id, beatIds: [beats[0].id] })
  await invoke('library:remove', beats[3].id, false)
  await navigate('Library')
  await expect.poll(checkedIds).toEqual([beats[1].id, beats[2].id])
  await expect(page.locator('[data-preview-state]')).toHaveCount(0)
  await page.getByRole('button', { name: 'All audio', exact: true }).click()
  await expect.poll(checkedIds).toEqual([])
})

test('returning restores the inspector but discards unsaved metadata and annotation drafts', async () => {
  await card(beats[0].id).click()
  await page.getByText('Correct BPM / key', { exact: true }).click()
  await page.getByLabel('Manual BPM', { exact: true }).fill('133')
  await page.getByLabel('Notes', { exact: true }).fill('Do not save this draft')
  await navigate('Download')
  await expect(scroll()).toHaveCount(0)
  await navigate('Library')
  await expect(page.locator('[data-preview-state]')).toContainText(beats[0].title)
  await expect(page.getByLabel('Notes', { exact: true })).toHaveValue('')
  await page.getByText('Correct BPM / key', { exact: true }).click()
  await expect(page.getByLabel('Manual BPM', { exact: true })).toHaveValue('140')
  expect((await invoke('library:list')).find(beat => beat.id === beats[0].id).bpm).toBe(140)
  expect((await invoke('organization:snapshot')).annotations[beats[0].id]?.notes ?? '').toBe('')
})
test('pending delete, rename and export dialogs do not return or execute after a page change', async () => {
  const before = await invoke('library:list')
  for (const operation of ['delete', 'rename', 'export']) {
    await card(beats[0].id).click({ button: 'right' })
    if (operation === 'export') {
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Export selected', exact: true }).click()
    } else {
      await page.getByRole('menuitem', { name: operation === 'delete' ? 'Delete beat…' : 'Rename beat and file…', exact: true }).click()
      if (operation === 'rename') await page.getByPlaceholder('Beat title').fill('Unsaved rename')
    }
    await expect(page.getByRole('dialog')).toBeVisible()
    // Modal overlays block pointer navigation. Dispatch the existing navigation
    // button to exercise unmount with a pending action, without confirming it.
    await page.locator('nav').getByRole('button', { name: /^Download/ }).first().evaluate(node => node.click())
    await expect(scroll()).toHaveCount(0)
    await navigate('Library')
    await expect(card(beats[0].id)).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(await invoke('library:list')).toEqual(before)
    expect(await page.evaluate(() => sessionStorage.getItem('sonic:library-batch-session'))).toBeNull()
  }
})
