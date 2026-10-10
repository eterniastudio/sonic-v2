import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const output = path.resolve('test-results/library-render-harness')
await mkdir(output, { recursive: true })
await build({ entryPoints: ['tests/harness/library-performance.tsx'], outfile: path.join(output, 'main.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } })
await writeFile(path.join(output, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="main.js"></script></body></html>')

for (const layout of ['list', 'grid']) {
  test(`library ${layout}: selection, playback and metadata render only changed rows`, async ({}, info) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const app = await electron.launch({ args: ['tests/harness/library-performance.cjs',
      `--user-data-dir=${path.resolve(info.outputPath(`profile-${Date.now()}`))}`], env })
    try {
      const page = await app.firstWindow()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await expect(page.locator('[data-beat-id]')).toHaveCount(100)
      if (layout === 'grid') await page.evaluate(() => window.libraryPerformance.layout('grid'))
      await expect(page.getByRole('button', { name: 'Preview Track 0', exact: true })).toBeVisible()
      const reset = () => page.evaluate(() => window.libraryPerformance.reset())
      const rendered = () => page.evaluate(() => window.libraryPerformance.renderedIds())

      await reset()
      await page.getByRole('checkbox', { name: 'Select Track 0', exact: true }).check()
      await expect.poll(rendered).toEqual(['0'])
      await expect(page.locator('[data-beat-id="0"]')).toHaveAttribute('data-batch-selected', 'true')

      await reset()
      await page.getByRole('button', { name: 'Play Track 1', exact: true }).click()
      await expect.poll(rendered).toEqual(['1'])
      await expect(page.locator('[data-beat-id="1"]')).toHaveAttribute('data-playback-state', 'playing')

      await reset()
      await page.getByRole('button', { name: 'Play Track 2', exact: true }).click()
      await expect.poll(rendered).toEqual(['1', '2'])

      await reset()
      await page.getByRole('button', { name: 'Preview Track 3', exact: true }).click()
      await expect.poll(rendered).toEqual(['3'])
      await reset()
      await page.getByRole('button', { name: 'Preview Track 4', exact: true }).click()
      await expect.poll(rendered).toEqual(['3', '4'])

      await reset()
      await page.evaluate(() => window.libraryPerformance.revise('5'))
      await expect.poll(rendered).toEqual(['5'])
      await page.getByRole('button', { name: 'Preview Revised track 5', exact: true }).click()
      await expect(page.getByLabel('Inspected title')).toHaveText('Revised track 5')
      expect(await page.evaluate(() => window.libraryPerformance.registered().length)).toBe(100)
      expect(errors).toEqual([])
    } finally { await app.close() }
  })
}
