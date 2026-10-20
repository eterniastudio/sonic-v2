import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

const COUNT = 600
const JOBS = 400
let app, page, root, beats, errors
const invoke = (channel, ...args) => page.evaluate(([channel, args]) => window.sonic.invoke(channel, ...args), [channel, args])
const navigate = name => page.locator('nav').getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
const card = id => page.locator(`[data-beat-id="${id}"]`)
const scroll = () => page.locator('[data-library-scroll]')
const search = () => page.getByPlaceholder('Search title, producer, BPM, key…')
const toBottom = locator => locator.evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop })

test.beforeEach(async ({}, info) => {
  app = null; errors = []
  root = await createOwnedProfile(info)
  const originals = await fixtures(root, 4)
  beats = Array.from({ length: COUNT }, (_, index) => ({ ...originals[index % 4], id: `virtual-${index}`,
    title: `Windowed beat ${String(index).padStart(3, '0')}`, bpm: 100 + (index % 60), addedAt: Date.now() - index }))
  await writeFile(path.join(root, 'library.json'), JSON.stringify(beats))
  const longQueue = info.title.includes('long queue')
  if (longQueue) {
    const queue = JSON.parse(await readFile(path.join(root, 'queue.json'), 'utf8'))
    const template = queue.jobs.find(job => job.stage === 'ready')
    queue.jobs = Array.from({ length: JOBS }, (_, index) => ({ ...template, id: `bulk-${index}`, sourceTitle: `Bulk job ${index}`,
      metadata: { declared: { title: `Bulk job ${index}` } } }))
    await writeFile(path.join(root, 'queue.json'), JSON.stringify(queue))
  }
  // With a long persisted queue the inspector transport's first main-process
  // evaluate is collected before it settles (unchanged code reproduces it), so
  // that launch goes through the CDP transport the lifecycle helper provides.
  const transport = process.env.SONIC_TEST_TRANSPORT
  if (longQueue) process.env.SONIC_TEST_TRANSPORT = 'cdp'
  try { app = await launchOwnedApp(root, info) } finally {
    if (transport === undefined) delete process.env.SONIC_TEST_TRANSPORT
    else process.env.SONIC_TEST_TRANSPORT = transport
  }
  page = await readyPage(app, root)
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1000 })
})

test.afterEach(async ({}, info) => {
  await closeOwnedApp(app, page, info)
  expect(errors).toEqual([])
})

test('large library list and grid mount a bounded window and keep focus and reveal working', async () => {
  await navigate('Library')
  await expect(card(beats[0].id)).toBeVisible()
  await expect(page.locator(`[data-virtual-rows="${COUNT}"]`)).toHaveCount(1)
  const mounted = () => page.locator('[data-beat-id]').count()
  expect(await mounted()).toBeLessThan(80)

  // Keyboard focus survives scrolling its row out of view.
  const preview = card(beats[1].id).getByRole('button', { name: `Preview ${beats[1].title}`, exact: true })
  await preview.focus()
  await toBottom(scroll())
  await expect(card(beats[COUNT - 1].id)).toBeVisible()
  await expect(preview).toBeFocused()
  expect(await mounted()).toBeLessThan(90)

  // The command palette reveals a displayed beat that is far outside the window.
  await scroll().evaluate(node => { node.scrollTop = 0 })
  await expect(card(beats[COUNT - 1].id)).toHaveCount(0)
  await page.getByRole('button', { name: 'Commands', exact: false }).click()
  const palette = page.getByRole('combobox', { name: 'Search beats, commands and settings', exact: true })
  await palette.fill(beats[450].title)
  await palette.press('Enter')
  await expect(card(beats[450].id)).toHaveAttribute('data-inspected', 'true')
  await expect(card(beats[450].id).getByRole('button', { name: `Preview ${beats[450].title}`, exact: true })).toBeFocused()
  await expect(card(beats[450].id)).toBeInViewport()

  // Grid layout windows too, by row.
  await page.getByRole('tablist', { name: 'Layout' }).getByRole('tab').nth(0).click()
  await expect.poll(async () => (await invoke('organization:snapshot')).view.layout).toBe('grid')
  await expect.poll(mounted).toBeLessThan(120)
  await toBottom(scroll())
  await expect(card(beats[COUNT - 1].id)).toBeVisible()
  // Select all still covers every displayed result, mounted or not.
  await page.getByRole('button', { name: `Select all ${COUNT} matching` }).click()
  await expect(page.getByText(`${COUNT} selected`, { exact: true })).toBeVisible()
})

test('search uses relevance without saving it, and quick view changes keep each other', async () => {
  const order = beats.slice(0, 200).map(beat => beat.id).reverse()
  await invoke('organization:command', { type: 'create-manual', name: 'Reversed', beatIds: order })
  await navigate('Library')
  await page.getByRole('button', { name: 'Collection: Reversed', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Collection order', exact: true })).toBeVisible()
  await expect.poll(async () => (await invoke('organization:snapshot')).view.sort).toBe('manual')
  await search().fill('Windowed')
  await expect(page.getByRole('button', { name: 'Relevance', exact: true })).toBeVisible()
  expect((await invoke('organization:snapshot')).view.sort).toBe('manual')
  await search().fill('')
  await expect(page.getByRole('button', { name: 'Collection order', exact: true })).toBeVisible()
  const first = await page.locator('[data-beat-id]').first().getAttribute('data-beat-id')
  expect(first).toBe(order[0])

  // Sort then layout in quick succession: neither change overwrites the other.
  await page.getByRole('button', { name: 'Collection order', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Title A → Z' }).click()
  await page.getByRole('tablist', { name: 'Layout' }).getByRole('tab').nth(1).click()
  await expect.poll(async () => (await invoke('organization:snapshot')).view).toMatchObject({ layout: 'list', sort: 'title' })
  await page.getByRole('tablist', { name: 'Layout' }).getByRole('tab').nth(0).click()
  await expect.poll(async () => (await invoke('organization:snapshot')).view).toMatchObject({ layout: 'grid', sort: 'title' })
})

test('a long queue mounts a bounded window and no closed menus', async () => {
  await navigate('Download')
  const rows = page.locator('[data-job-id]')
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeLessThan(60)
  expect(await page.locator('[role="menu"]').count()).toBe(0)
  const list = page.locator('section[aria-labelledby="queue-heading"] .overflow-y-auto')
  await toBottom(list)
  const last = page.locator(`[data-job-id="bulk-${JOBS - 1}"]`)
  await expect(last).toBeVisible()
  await last.getByRole('button', { name: '320', exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('the renderer cannot point main at an executable through settings:patch', async () => {
  for (const key of ['ytdlpPath', 'ffmpegPath', 'ffprobePath']) {
    await expect(invoke('settings:patch', { [key]: '/bin/sh' })).rejects.toThrow()
    expect((await invoke('settings:get'))[key]).toBeNull()
    await invoke('settings:patch', { [key]: null })
  }
})
