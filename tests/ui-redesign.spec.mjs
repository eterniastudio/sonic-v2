import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

test('minimal workspace stays usable in both themes and compact desktop sizes', async ({}, info) => {
  const root = await createOwnedProfile(info)
  const source = await fixtures(root, 45)
  const titles = ['Midnight Transit', 'Velvet Hours', 'After the Rain', 'Chrome Hearts', 'Low Tide', 'Nocturne', 'Soft Focus', 'Blue Hour', 'Daylight', 'Northbound', 'Still Life', 'Late Checkout']
  const beats = titles.map((title, index) => ({ ...source[index % source.length], id: `design-${index}`, title,
    producer: ['Aster', 'Northside', 'Milo', 'Lowkey'][index % 4], bpm: [140, 92, 128, 160][index % 4],
    key: ['A minor', 'D minor', 'F major', 'C minor'][index % 4], camelot: ['8A', '7A', '7B', '5A'][index % 4],
    overrides: ['bpm', 'key'], analysisStatus: 'estimated', addedAt: Date.now() - index * 3600000 }))
  await writeFile(path.join(root, 'library.json'), JSON.stringify(beats))
  const app = await launchOwnedApp(root, info)
  let page
  const errors = []
  const invoke = (channel, ...args) => page.evaluate(([channel, args]) => window.sonic.invoke(channel, ...args), [channel, args])
  const navigate = name => page.locator('nav').getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
  try {
    page = await readyPage(app, root)
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => [...document.fonts].some(font => font.family.includes('Inter Variable') && font.status === 'loaded'))).toBe(true)
    await invoke('organization:command', { type: 'create-manual', name: 'Next release', beatIds: beats.slice(0, 6).map(beat => beat.id) })
    for (const theme of ['dark', 'light']) {
      await invoke('settings:patch', { theme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      for (const size of [{ width: 1440, height: 960 }, { width: 1024, height: 680 }]) {
        await page.setViewportSize(size)
        for (const view of ['Download', 'Library', 'Settings']) {
          await navigate(view)
          await expect(page.locator('main h1')).toHaveText(view === 'Download' ? 'Downloads' : view === 'Library' ? /^Library/ : 'Settings')
          if (view === 'Download') {
            const links = page.getByRole('textbox', { name: 'YouTube or SoundCloud beat links', exact: true })
            await links.fill('https://www.youtube.com/watch?v=abcdefghijk')
            const queueButton = page.getByRole('button', { name: 'Add to queue', exact: true })
            await expect(queueButton).toBeEnabled()
            expect(await queueButton.evaluate(node => {
              const bounds = node.getBoundingClientRect()
              const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
              return target === node || node.contains(target)
            })).toBe(true)
            await links.clear()
          }
          if (view === 'Library') {
            await expect(page.getByRole('tablist', { name: 'Layout' }).getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')
            const first = page.locator('[data-beat-id="design-0"]')
            await expect(first).toBeVisible()
            if (!await page.locator('[data-preview-state]').count()) await first.getByText(titles[0], { exact: true }).click()
            if (theme === 'dark' && size.width === 1440) {
              await first.getByRole('button', { name: `Play ${titles[0]}`, exact: true }).click()
              await expect(page.locator('[data-playback-dock]')).toHaveAttribute('data-playback-state', 'playing')
            }
          }
          if (view === 'Settings') {
            for (const label of ['Dark', 'Light', 'System']) {
              const choice = page.getByRole('radio', { name: label, exact: true })
              await expect(choice).toBeVisible()
              expect(await choice.evaluate(node => {
                const bounds = node.getBoundingClientRect()
                return [...node.querySelectorAll('[aria-hidden="true"]')].every(child => {
                  const content = child.getBoundingClientRect()
                  return content.top >= bounds.top && content.bottom <= bounds.bottom
                })
              })).toBe(true)
            }
          }
          await expect.poll(() => page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
          for (const label of ['Preview volume', 'Seek preview']) {
            const slider = page.locator('[data-playback-dock]').getByLabel(label)
            await expect(slider).toBeVisible()
            expect((await slider.boundingBox()).height).toBeGreaterThanOrEqual(24)
          }
          await page.screenshot({ path: info.outputPath(`${view.toLowerCase()}-${theme}-${size.width}.png`), animations: 'disabled' })
        }
      }
    }
    await navigate('Library')
    const results = page.locator('[data-library-scroll]')
    await expect(results).toBeVisible()
    const bounds = await results.boundingBox()
    expect(bounds.height).toBeGreaterThan(100)
    await expect(page.getByPlaceholder('Search title, producer, BPM, key…')).toBeVisible()
    await page.getByRole('tablist', { name: 'Layout' }).getByRole('tab').nth(0).click()
    await expect(page.locator('[data-beat-id="design-0"]')).toBeVisible()
    await page.screenshot({ path: info.outputPath('library-grid-light-1024.png'), animations: 'disabled' })
    await navigate('Download')
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Close inspector', exact: true })).toHaveCount(0)
    await page.getByRole('heading', { name: 'Offline job 4', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Close inspector', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await closeOwnedApp(app, page ?? await app.firstWindow().catch(() => null), info)
  }
})

test('primary controls retain readable contrast across every theme and accent', async ({}, info) => {
  const root = await createOwnedProfile(info)
  await fixtures(root)
  const app = await launchOwnedApp(root, info)
  let page
  try {
    page = await readyPage(app, root)
    await page.locator('nav').getByRole('button', { name: /^Library/ }).first().click()
    const primary = page.getByRole('button', { name: 'Import audio', exact: true })
    for (const theme of ['light', 'dark']) {
      for (const accent of ['violet', 'cyan', 'emerald', 'amber', 'rose']) {
        await page.evaluate(settings => window.sonic.invoke('settings:patch', settings), { theme, accent })
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(page.locator('html')).toHaveAttribute('data-accent', accent)
        for (const hovered of [false, true]) {
          if (hovered) await primary.hover()
          else await page.mouse.move(0, 0)
          const contrast = await primary.evaluate(async node => {
            await new Promise(resolve => requestAnimationFrame(resolve))
            await Promise.all(node.getAnimations().map(animation => animation.finished))
            const style = getComputedStyle(node)
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 1
            const context = canvas.getContext('2d', { willReadFrequently: true })
            const luminance = color => {
              context.fillStyle = color
              context.fillRect(0, 0, 1, 1)
              const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
                const srgb = value / 255
                return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
              })
              return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
            }
            const foreground = luminance(style.color)
            const background = luminance(style.backgroundColor)
            return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
          })
          expect(contrast, `${theme}/${accent}/${hovered ? 'hover' : 'rest'}`).toBeGreaterThanOrEqual(4.5)
        }
        const search = page.getByPlaceholder('Search title, producer, BPM, key…')
        await search.focus()
        await expect(search).toBeFocused()
        const focusStyle = await search.evaluate(node => {
          const style = getComputedStyle(node)
          return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
        })
        expect(focusStyle.style).toBe('solid')
        expect(focusStyle.width).toBeGreaterThanOrEqual(2)
      }
    }
  } finally {
    await closeOwnedApp(app, page ?? await app.firstWindow().catch(() => null), info)
  }
})
