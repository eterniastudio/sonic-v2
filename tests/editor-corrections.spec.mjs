import { test, expect } from '@playwright/test'
import { mkdir, readFile, rename, rmdir } from 'node:fs/promises'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

let app, page, root, beats
const invoke = (channel, ...args) => page.evaluate(([name, values]) => window.sonic.invoke(name, ...values), [channel, args])
const beat = async () => (await invoke('library:list')).find(record => record.id === beats[0].id)

test.beforeEach(async ({}, info) => {
  app = null
  root = await createOwnedProfile(info)
  beats = await fixtures(root, 12, { sidecars: true })
  app = await launchOwnedApp(root, info)
  page = await readyPage(app, root)
  await page.getByRole('button', { name: /Library/ }).first().click()
  await page.locator(`[data-beat-id="${beats[0].id}"]`).click()
  await page.getByText('Correct BPM / key', { exact: true }).click()
  await expect(page.getByLabel('Manual BPM')).toBeVisible()
})

test.afterEach(async ({}, info) => { await closeOwnedApp(app, page, info) })

test('resetting BPM preserves an unsaved key edit', async () => {
  await invoke('library:updateMetadata', beats[0].id, { bpm: 128 })
  await expect(page.getByLabel('Manual BPM')).toHaveValue('128')
  await page.getByLabel('Manual key').fill('F# minor')
  await page.getByRole('button', { name: 'Reset BPM to evidence priority' }).click()
  await expect(page.getByLabel('Manual key')).toHaveValue('F# minor')
  await expect(page.getByRole('button', { name: 'Save corrections' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save corrections' }).click()
  await expect.poll(async () => (await beat()).key).toBe('F# minor')
  expect((await beat()).bpm).toBeNull()
  expect((await beat()).overrides).toContain('key')
  expect((await beat()).overrides).not.toContain('bpm')
})

test('resetting key preserves an unsaved BPM edit', async () => {
  await invoke('library:updateMetadata', beats[0].id, { key: 'C major' })
  await expect(page.getByLabel('Manual key')).toHaveValue('C major')
  await page.getByLabel('Manual BPM').fill('137')
  await page.getByRole('button', { name: 'Reset key to evidence priority' }).click()
  await expect(page.getByLabel('Manual BPM')).toHaveValue('137')
  await expect(page.getByRole('button', { name: 'Save corrections' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save corrections' }).click()
  await expect.poll(async () => (await beat()).bpm).toBe(137)
  expect((await beat()).key).toBeNull()
  expect((await beat()).overrides).toContain('bpm')
  expect((await beat()).overrides).not.toContain('key')
})

for (const { edited, value, incoming, next, expected } of [
  { edited: 'bpm', value: '139', incoming: 'key', next: 'A minor', expected: 139 },
  { edited: 'key', value: 'F# minor', incoming: 'bpm', next: 142, expected: 'F# minor' }
]) {
  test(`incoming ${incoming} revision stays live while only ${edited} is edited`, async () => {
    const editedInput = page.getByLabel(edited === 'bpm' ? 'Manual BPM' : 'Manual key')
    const incomingInput = page.getByLabel(incoming === 'bpm' ? 'Manual BPM' : 'Manual key')
    await editedInput.fill(value)
    await invoke('library:updateMetadata', beats[0].id, { [incoming]: next })
    await expect(incomingInput).toHaveValue(String(next))
    await expect(editedInput).toHaveValue(value)
    await page.getByRole('button', { name: 'Save corrections' }).click()
    await expect.poll(async () => (await beat())[edited]).toBe(expected)
    expect((await beat())[incoming]).toBe(next)
    expect((await beat()).overrides).toEqual(expect.arrayContaining([edited, incoming]))
    // The earlier revision was made manually through IPC. The editor should
    // preserve it without submitting a stale copy of the untouched field.
    const saved = JSON.parse(await readFile(`${root}/library.json`, 'utf8')).find(record => record.id === beats[0].id)
    expect(saved[edited]).toBe(expected)
    expect(saved[incoming]).toBe(next)
  })
}

test('failed sidecar synchronization shows saved correction and a retryable warning', async () => {
  const sidecarPath = beats[0].sidecarPath
  const originalPath = `${sidecarPath}.test-saved`
  await rename(sidecarPath, originalPath)
  await mkdir(sidecarPath)
  let restored = false
  try {
    await page.getByLabel('Manual BPM').fill('143')
    await page.getByRole('button', { name: 'Save corrections' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'sidecar(s) need synchronization' })).toBeVisible()
    await expect(page.getByLabel('Manual BPM')).toHaveValue('143')
    await expect(page.getByRole('button', { name: 'Save corrections' })).toBeDisabled()
    await expect.poll(async () => (await beat()).sidecarSync?.status).toBe('error')
    expect((await beat()).bpm).toBe(143)
    await rmdir(sidecarPath)
    await rename(originalPath, sidecarPath)
    restored = true
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click()
    await expect.poll(async () => (await beat()).sidecarSync?.status).toBe('synced')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
    expect(sidecar.metadata.bpm).toBe(143)
  } finally {
    if (!restored) { await rmdir(sidecarPath); await rename(originalPath, sidecarPath) }
  }
})
