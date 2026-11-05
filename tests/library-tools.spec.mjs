import { test, expect } from '@playwright/test'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

let app, page, root, beats, errors
const invoke = (channel, ...args) => page.evaluate(([channel, args]) => window.sonic.invoke(channel, ...args), [channel, args])
const navigate = name => page.locator('nav').getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
const card = id => page.locator(`[data-beat-id="${id}"]`)
const preview = beat => card(beat.id).getByRole('button', { name: `Preview ${beat.title}`, exact: true })
const tab = name => page.getByRole('navigation', { name: 'Library collections' }).getByRole('button', { name, exact: true })

test.beforeEach(async ({}, info) => {
  app = null; errors = []
  root = await createOwnedProfile(info)
  const originals = await fixtures(root, 12)
  const old = Date.now() - 30 * 86_400_000
  beats = [
    { ...originals[0], title: 'Seed 140 8A', bpm: 140, key: 'A minor', camelot: '8A', addedAt: Date.now() - 1000 },
    { ...originals[1], title: 'Neighbour 141 9A', bpm: 141, key: 'E minor', camelot: '9A', addedAt: Date.now() - 2000 },
    { ...originals[2], title: 'Relative half 70 8B', bpm: 70, key: 'C major', camelot: '8B', addedAt: old },
    { ...originals[3], title: 'Clash 140 3A', bpm: 140, key: 'A# minor', camelot: '3A', addedAt: Date.now() - 3000 },
    // Same audio as the seed under another record: a duplicate.
    { ...originals[0], id: 'duplicate-of-seed', title: 'Seed copy', bpm: null, key: null, camelot: null, addedAt: Date.now() - 500 }
  ]
  await writeFile(path.join(root, 'library.json'), JSON.stringify(beats))
  const queue = JSON.parse(await readFile(path.join(root, 'queue.json'), 'utf8'))
  queue.jobs[1] = { ...queue.jobs[1], stage: 'failed', error: 'Network unreachable' }
  await writeFile(path.join(root, 'queue.json'), JSON.stringify(queue))
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1000 })
})

test.afterEach(async ({}, info) => {
  await closeOwnedApp(app, page, info)
  expect(errors).toEqual([])
})

test('find compatible tracks by Camelot neighbour and half/double tempo, from the menu and the C key', async () => {
  await navigate('Library')
  await card(beats[0].id).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Find compatible tracks' }).click()
  const banner = page.getByRole('status', { name: 'Compatible tracks' })
  await expect(banner).toContainText('2 compatible with Seed 140 8A')
  await expect(banner).toContainText('8A, 7A, 9A, 8B')
  await expect(card(beats[1].id)).toBeVisible()
  await expect(card(beats[2].id)).toBeVisible()
  await expect(card(beats[3].id)).toHaveCount(0)
  await page.getByRole('switch', { name: 'Compatible half and double time' }).click()
  await expect(card(beats[2].id)).toHaveCount(0)
  await banner.getByRole('button', { name: 'Show all tracks' }).click()
  await expect(card(beats[3].id)).toBeVisible()

  await preview(beats[1]).focus()
  await page.keyboard.press('c')
  await expect(page.getByRole('status', { name: 'Compatible tracks' })).toContainText('compatible with Neighbour 141 9A')
  await expect(card(beats[3].id)).toHaveCount(0)
})

test('F toggles favorite; Recently added and Needs review are built-in views', async () => {
  await navigate('Library')
  await preview(beats[3]).focus()
  await page.keyboard.press('f')
  await expect.poll(async () => (await invoke('organization:snapshot')).annotations[beats[3].id]?.favorite).toBe(true)
  await tab('Favorites').click()
  await expect(card(beats[3].id)).toBeVisible()
  await expect(card(beats[0].id)).toHaveCount(0)
  await preview(beats[3]).focus()
  await page.keyboard.press('f')
  await expect.poll(async () => (await invoke('organization:snapshot')).annotations[beats[3].id]?.favorite ?? false).toBe(false)

  await tab('Recently added').click()
  await expect(card(beats[0].id)).toBeVisible()
  await expect(card(beats[2].id)).toHaveCount(0)
  await tab('Needs review').click()
  await expect(card('duplicate-of-seed')).toBeVisible()
  await expect(card(beats[0].id)).toHaveCount(0)
  // The view survives a restart of the Library page.
  await navigate('Settings')
  await navigate('Library')
  await expect(tab('Needs review')).toHaveAttribute('aria-current', 'page')
})

test('duplicates resolve by keeping one record, merging annotations, and leaving files on disk', async () => {
  await invoke('organization:command', { type: 'set-annotation', beatId: 'duplicate-of-seed', favorite: true, tags: ['vocals'], notes: 'Hook idea' })
  await invoke('organization:command', { type: 'create-manual', name: 'Session', beatIds: ['duplicate-of-seed'] })
  await navigate('Library')
  await tab('Duplicates').click()
  const group = page.locator('[data-duplicate-group]')
  await expect(group).toHaveCount(1)
  await expect(group).toContainText('Identical audio')
  await group.getByRole('radio', { name: `Keep Seed 140 8A (${beats[0].fileName})` }).check()
  await group.getByRole('button', { name: 'Remove 1 other record' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove other records' }).click()
  await expect(page.getByText('No duplicates.', { exact: false })).toBeVisible()
  const library = await invoke('library:list')
  expect(library.map(beat => beat.id)).not.toContain('duplicate-of-seed')
  await access(beats[0].filePath)
  const organization = await invoke('organization:snapshot')
  expect(organization.annotations[beats[0].id]).toEqual({ favorite: true, tags: ['vocals'], notes: 'Hook idea' })
  expect(organization.collections.find(item => item.name === 'Session').beatIds).toEqual([beats[0].id])
})

test('export track list writes CSV through the save dialog, with collections and no paths', async () => {
  await invoke('organization:command', { type: 'create-manual', name: 'Late night', beatIds: [beats[1].id] })
  const target = path.join(root, 'track-list.csv')
  await app.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }) }, target)
  await navigate('Library')
  await page.getByRole('button', { name: 'Export track list' }).click()
  await expect.poll(() => readFile(target, 'utf8').catch(() => '')).toContain('Neighbour 141 9A')
  const csv = await readFile(target, 'utf8')
  expect(csv).toContain('Title,Producer,BPM,Key,Camelot,Duration,Source,Source URL,File name,Collections')
  expect(csv).toContain(`Neighbour 141 9A,,141,E minor,9A,0:12,Unknown,,${beats[1].fileName},Late night`)
  expect(csv).not.toContain(root)
  expect(csv.trim().split('\r\n')).toHaveLength(beats.length + 1)
})

test('drag out names records by id; main starts the OS drag with the real file', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.startDrag = item => { globalThis.__sonicDrag = item }
  })
  await navigate('Library')
  await card(beats[1].id).dispatchEvent('dragstart')
  await expect.poll(() => app.evaluate(() => globalThis.__sonicDrag?.file ?? null)).toBe(beats[1].filePath)
})

test('clipboard link watch is opt-in and offers a copied link once; retry failed re-queues', async () => {
  const link = 'https://youtu.be/dQw4w9WgXcQ'
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), link)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(300)
  await expect(page.getByRole('region', { name: 'Copied link' })).toHaveCount(0)

  await navigate('Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Advanced' }).click()
  await page.getByRole('switch', { name: 'Offer links from the clipboard' }).click()
  await expect.poll(async () => (await invoke('settings:get')).watchClipboard).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const offer = page.getByRole('region', { name: 'Copied link' })
  await expect(offer).toContainText('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  await offer.getByRole('button', { name: 'Add to queue' }).click()
  await expect(offer).toHaveCount(0)
  await expect.poll(async () => (await invoke('queue:snapshot')).jobs.some(job => job.url === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  // Already queued and already answered: no second offer.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(300)
  await expect(offer).toHaveCount(0)

  await navigate('Download')
  // The fixture's failed job, plus the copied link if its offline probe has failed by now.
  await page.getByRole('button', { name: /^Retry failed \(\d\)$/ }).click()
  await expect.poll(async () => (await invoke('queue:snapshot')).jobs.find(job => job.id === 'job-1')?.stage).not.toBe('failed')
  const cancelled = (await invoke('queue:snapshot')).jobs.filter(job => job.stage === 'cancelled').length
  expect(cancelled).toBe(0)
})
