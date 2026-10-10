import { test, expect } from '@playwright/test'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

test('playlist IPC validates requests and missing-engine feedback leaves the queue unchanged', async ({}, info) => {
  const root = await createOwnedProfile(info)
  await fixtures(root)
  let app, page
  try {
    app = await launchOwnedApp(root, info)
    page = await readyPage(app, root)
    const before = await page.evaluate(() => window.sonic.invoke('queue:snapshot'))
    await page.getByRole('button', { name: /Download/ }).first().click()
    const input = page.getByLabel('YouTube or SoundCloud beat links')
    await input.fill('https://www.youtube.com/playlist?list=PLtest123')
    await page.getByRole('button', { name: 'Review playlists', exact: true }).click()
    await expect(page.getByText(/Set up the media engine in Settings before reading playlists/)).toBeVisible()
    await expect(input).toHaveValue('https://www.youtube.com/playlist?list=PLtest123')
    const result = await page.evaluate(async () => {
      const errors = []
      for (const args of [['https://example.com/playlist?list=PLtest', 'request'], ['https://youtube.com/playlist?list=PLtest', {}]]) {
        try { await window.sonic.invoke('playlist:inspect', ...args) } catch (error) { errors.push(String(error)) }
      }
      await window.sonic.invoke('playlist:cancel', 'unknown-request')
      return { errors, queue: await window.sonic.invoke('queue:snapshot') }
    })
    expect(result.errors[0]).toContain('valid YouTube playlist')
    expect(result.errors[1]).toContain('Invalid playlist:inspect request')
    expect(result.queue.jobs).toEqual(before.jobs)
    await page.screenshot({ path: info.outputPath('playlist-intake.png') })
  } finally { await closeOwnedApp(app, page, info) }
})
