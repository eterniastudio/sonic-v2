import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

test('command palette searches all 1,000 beats with bounded accessible results and no queue-progress rebuilds', async ({}, info) => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['tests/harness/electron.cjs', `--user-data-dir=${path.resolve(info.outputPath('profile'))}`], env })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const url = pathToFileURL(path.resolve('test-results/component-build/index.html'))
    url.hash = 'palette'
    await page.goto(url.href)
    await page.waitForFunction(() => !!window.palette)
    expect(await page.evaluate(() => window.palette.titleReads)).toBe(0)
    await page.evaluate(() => { for (let index = 0; index < 10; index++) window.palette.progress() })
    expect(await page.evaluate(() => window.palette.titleReads)).toBe(0)

    const trigger = page.getByRole('button', { name: 'Open commands', exact: true })
    await trigger.click()
    const search = page.getByRole('combobox', { name: 'Search beats, commands and settings', exact: true })
    await expect(search).toBeFocused()
    await expect(page.getByRole('option')).toHaveCount(60)
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Showing 60 of')
    const reads = await page.evaluate(() => window.palette.titleReads)
    await page.evaluate(() => { for (let index = 0; index < 10; index++) window.palette.progress() })
    expect(await page.evaluate(() => window.palette.titleReads)).toBe(reads)

    await search.press('Control+End')
    const last = page.getByRole('option').last()
    await expect(last).toHaveAttribute('aria-selected', 'true')
    await expect(search).toHaveAttribute('aria-activedescendant', await last.getAttribute('id'))
    await search.press('Tab')
    await expect(search).toBeFocused()
    await search.fill('Catalog beat 0999')
    const match = page.getByRole('option', { name: 'Catalog beat 0999', exact: true })
    await expect(match).toHaveAccessibleDescription('140 BPM · 8A')
    await expect(match).toHaveAttribute('aria-selected', 'true')
    await expect(search).toHaveAttribute('aria-activedescendant', await match.getAttribute('id'))
    await search.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByLabel('Focused beat')).toHaveText('palette-999')
    await expect(trigger).toBeFocused()

    await trigger.click()
    await search.fill('Catalog beat 0999')
    await page.evaluate(() => window.palette.clearLibrary())
    await expect(page.getByRole('option')).toHaveCount(0)
    await expect(search).not.toHaveAttribute('aria-activedescendant')
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText('0 results')
    await search.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await search.press('Escape')
    await expect(trigger).toBeFocused()
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('closing palette becomes inert immediately while its exit animation remains mounted', async ({}, info) => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['tests/harness/electron.cjs', `--user-data-dir=${path.resolve(info.outputPath('profile'))}`], env })
  const page = await app.firstWindow()
  try {
    const url = pathToFileURL(path.resolve('test-results/component-build/index.html'))
    url.hash = 'palette'
    await page.goto(url.href)
    await page.waitForFunction(() => !!window.palette)
    const trigger = page.getByRole('button', { name: 'Open commands', exact: true })
    await trigger.click()
    await expect(page.getByRole('combobox')).toBeFocused()
    const closing = await page.evaluate(() => {
      // Flush the close commit and inspect the still-mounted exit frame, before
      // waiting or allowing the animation to remove its children.
      window.palette.close()
      const overlay = document.querySelector('[data-command-palette-overlay]')
      const input = overlay?.querySelector('input')
      // Move focus outside first: retained pre-close focus must not be confused
      // with a successful new focus attempt on an inert descendant.
      document.querySelector('main button')?.focus()
      input?.focus()
      return { present: Boolean(overlay), inert: overlay?.inert,
        hidden: overlay?.getAttribute('aria-hidden'), pointerEvents: overlay?.style.pointerEvents,
        canFocus: document.activeElement === input }
    })
    expect(closing).toEqual({ present: true, inert: true, hidden: 'true', pointerEvents: 'none', canFocus: false })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('combobox')).toBeFocused()
    await expect(page.locator('[data-command-palette-overlay]')).toHaveAttribute('aria-hidden', 'false')
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  } finally { await app.close() }
})
