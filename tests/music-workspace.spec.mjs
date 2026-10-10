import { test, expect } from '@playwright/test'
import { copyFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'
import { createOwnedProfile, launchOwnedApp, readyPage, closeOwnedApp } from './app-lifecycle.mjs'

// Original geometric SVG artwork, used only as deterministic test fixtures.
// Source URLs are intercepted below; no artwork or source media is fetched.
const colors = ['#263d50', '#60536c', '#786048', '#4b6260', '#74564e', '#454c63']
const cover = index => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="${colors[index % colors.length]}"/><circle cx="${210 + index * 13}" cy="154" r="112" fill="#e2d7ba" opacity=".75"/><path d="M0 280 L170 170 L335 300 L490 205 L640 280 V360 H0Z" fill="#172326" opacity=".85"/><path d="M0 310 L260 245 L440 330 L640 280 V360 H0Z" fill="#e2d7ba" opacity=".25"/><text x="32" y="40" font-family="sans-serif" font-size="14" letter-spacing="4" fill="#fff">SONIC / TEST FIXTURE</text><text x="32" y="335" font-family="sans-serif" font-size="22" letter-spacing="5" fill="#fff">STUDY ${String(index + 1).padStart(2, '0')}</text></svg>`

const titles = [
  'Midnight Transit',
  'The Last Train Home — an unfinished idea from the blue room, extended instrumental version',
  'Paper Lanterns',
  'Archive Tape 03',
  'Untitled Field Recording',
  'Broken Signal',
  'Low Tide', 'Velvet Hours', 'Side Street', 'Soft Focus', 'Northbound', 'Still Life', 'After the Rain', 'Daylight'
]

test('music workspace comparison with varied artwork and independent playback, inspection and selection', async ({}, info) => {
  const root = await createOwnedProfile(info)
  const originals = await fixtures(root, 180)
  const beats = []
  for (let index = 0; index < titles.length; index++) {
    const original = originals[index % originals.length]
    const filePath = path.join(root, 'exports', `music-${String(index).padStart(2, '0')}.wav`)
    if (index !== 3) await copyFile(original.filePath, filePath)
    const unknown = index === 4
    // Known musical values are explicitly manual fixture annotations, never analysis results.
    beats.push({ ...original, id: `music-${index}`, title: titles[index],
      producer: index === 4 ? null : ['Aster', 'Northside', 'Milo', 'Lowkey'][index % 4],
      bpm: unknown ? null : [140, 92, 128, 160][index % 4],
      key: unknown ? null : ['A minor', 'D minor', 'F major', 'C minor'][index % 4],
      camelot: unknown ? null : ['8A', '7A', '7B', '5A'][index % 4],
      overrides: unknown ? ['title'] : ['title', 'producer', 'bpm', 'key'],
      analysisStatus: 'not-analyzed', analysis: null, embedded: {}, publishedTags: null,
      verification: null, sourceUrl: index === 2 ? null : `https://www.youtube.com/watch?v=musicTest${String(index).padStart(2, '0')}`,
      sourceKind: index === 2 ? 'local' : 'youtube', sourceChannel: null,
      filePath, fileName: path.basename(filePath), fileOwnership: 'sonic-export', missing: index === 3,
      addedAt: 1800000000000 - index * 3600000 })
  }
  await writeFile(path.join(root, 'library.json'), JSON.stringify(beats))
  const app = await launchOwnedApp(root, info)
  let page
  const errors = []
  const phase = process.env.SONIC_VISUAL_PHASE || 'after'
  const captures = []
  const requestedArtwork = []
  try {
    await app.context().route('https://i.ytimg.com/**', async route => {
      const match = /musicTest(\d{2})\//.exec(route.request().url())
      const index = match ? Number(match[1]) : -1
      requestedArtwork.push(index)
      if (index < 0 || index === 5) return route.fulfill({ status: 404, body: 'Intentional broken-cover test fixture' })
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: cover(index) })
    })
    page = await readyPage(app, root)
    page.on('pageerror', error => errors.push(error.message))
    const invoke = (channel, ...args) => page.evaluate(([channel, args]) => window.sonic.invoke(channel, ...args), [channel, args])
    const row = index => page.locator(`[data-beat-id="music-${index}"]`)
    const inspector = page.locator('[data-preview-state]')
    const player = page.locator('[data-playback-dock]')
    const inspect = async index => {
      if (!await inspector.filter({ hasText: titles[index] }).count()) {
        // Close before changing records so the comparison also runs on the
        // baseline build, whose keyed inspector siblings can retain old DOM.
        if (await inspector.count()) {
          await inspector.getByRole('button', { name: /^Close (preview|inspector)$/ }).first().click()
          await expect(inspector).toHaveCount(0)
        }
        await row(index).getByText(titles[index], { exact: true }).click()
      }
      await expect(inspector).toHaveCount(1)
      await expect(inspector).toContainText(titles[index])
    }
    const capture = async name => {
      const destination = info.outputPath(`${phase}-${name}.png`)
      await page.evaluate(async () => {
        await document.fonts.ready
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
      })
      await page.screenshot({ path: destination, animations: 'disabled' })
      captures.push(destination)
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.locator('nav').getByRole('button', { name: /^Library/ }).first().click()
    await page.getByRole('tablist', { name: 'Layout' }).getByRole('tab').nth(1).click()
    await expect(row(0)).toBeVisible()
    await row(0).getByRole('button', { name: `Play ${titles[0]}`, exact: true }).click()
    await expect(player).toHaveAttribute('data-playback-beat-id', beats[0].id)
    await expect(player).toHaveAttribute('data-playback-state', 'playing', { timeout: 20000 })
    const seek = player.getByLabel('Seek preview')
    const seekBounds = await seek.boundingBox()
    await seek.click({ position: { x: seekBounds.width / 4, y: seekBounds.height / 2 } })
    await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(20)
    await inspect(1)
    for (const index of [2, 4]) await row(index).getByRole('checkbox').check()
    for (const theme of ['dark', 'light']) {
      await invoke('settings:patch', { theme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      for (const size of [{ width: 1440, height: 960 }, { width: 1024, height: 680 }]) {
        await page.setViewportSize(size)
        await inspect(1)
        await page.locator('[data-library-scroll]').evaluate(node => { node.scrollTop = 0 })
        await expect(player).toHaveAttribute('data-playback-state', 'playing')
        await expect(player).toHaveAttribute('data-playback-beat-id', beats[0].id)
        for (const index of [2, 4]) await expect(row(index).getByRole('checkbox')).toBeChecked()
        for (const index of [0, 1, 2, 3, 4, 5]) await expect(row(index)).toBeVisible()
        await expect.poll(() => row(0).locator('img').evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0))).toBe(true)
        await expect.poll(() => row(1).locator('img').evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0))).toBe(true)
        await expect.poll(() => page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        if (phase === 'after') {
          await expect(inspector.getByText('Tempo', { exact: true })).toBeInViewport({ ratio: 1 })
          await expect(inspector.getByRole('button', { name: 'Play this beat', exact: true })).toBeInViewport({ ratio: 1 })
        }
        await capture(`library-${theme}-${size.width}`)
      }
      for (const [index, state] of [[4, 'unknown'], [3, 'missing'], [5, 'broken-cover']]) {
        await inspect(index)
        await expect(player).toHaveAttribute('data-playback-beat-id', beats[0].id)
        await capture(`inspector-${state}-${theme}-1024`)
      }
      await inspect(1)
      // Enter keyboard modality before programmatic focus so this captures
      // the actual focus-visible treatment rather than pointer focus.
      await page.keyboard.press('Tab')
      await row(2).getByRole('checkbox').focus()
      await expect(row(2).getByRole('checkbox')).toBeFocused()
      const focusOutline = await row(2).getByRole('checkbox').evaluate(node => {
        const style = getComputedStyle(node.nextElementSibling)
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
      })
      expect(focusOutline.style).toBe('solid')
      expect(focusOutline.width).toBeGreaterThanOrEqual(2)
      await row(5).hover()
      await capture(`focus-hover-${theme}-1024`)
    }
    await expect.poll(() => requestedArtwork.includes(5)).toBe(true)
    if (phase === 'after') {
      await expect(player.getByRole('img', { name: `Artwork for ${titles[0]}`, exact: true })).toBeVisible()
      const playingPreview = row(0).getByRole('button', { name: `Preview ${titles[0]}`, exact: true })
      await expect(playingPreview.getByText('Playing', { exact: true })).toBeVisible()
      await player.getByRole('button', { name: 'Pause audition', exact: true }).click()
      await expect(playingPreview.getByText('Paused', { exact: true })).toBeVisible()
      await player.getByRole('button', { name: 'Play audition', exact: true }).click()
      await expect(playingPreview.getByText('Playing', { exact: true })).toBeVisible()
      // The redesigned build must also replace the inspector directly without
      // the baseline close/reopen workaround used for comparable screenshots.
      for (const index of [4, 1]) {
        await row(index).getByText(titles[index], { exact: true }).click()
        await expect(inspector).toHaveCount(1)
        await expect(inspector).toContainText(titles[index])
        await expect(player).toHaveAttribute('data-playback-beat-id', beats[0].id)
        await expect(player).toHaveAttribute('data-playback-state', 'playing')
      }
      for (const index of [2, 5]) {
        await inspect(index)
        await expect(inspector.getByRole('img', { name: `No artwork available for ${titles[index]}`, exact: true })).toBeVisible()
      }
      await inspect(3)
      await expect(inspector.getByText(/Audio file is missing/)).toBeVisible()
      await expect(inspector.getByRole('button', { name: 'Play this beat', exact: true })).toBeDisabled()
      await inspect(4)
      await row(4).getByRole('button', { name: `Play ${titles[4]}`, exact: true }).click()
      await expect(player).toHaveAttribute('data-playback-beat-id', beats[4].id)
      await expect(player).toHaveAttribute('data-playback-state', 'playing')
      await expect(player.getByRole('group', { name: 'Track metadata' })).toContainText('BPM unknown')
      await expect(player.getByRole('group', { name: 'Track metadata' })).toContainText('Key unknown')
      await capture('player-unknown-light-1024')
    }
    expect(errors).toEqual([])
    await writeFile(info.outputPath(`${phase}-captures.json`), JSON.stringify({ phase, profile: root,
      artwork: 'Original SVG test fixtures fulfilled offline; index 2 has no cover, index 5 deliberately returns 404.',
      metadata: 'Manual fixture annotations only; no acoustic analysis, confidence, or embedded-tag claims.',
      baselineLimitation: 'Comparison captures close/reopen between inspected tracks because the baseline build retains duplicate keyed inspector DOM on direct switching. The after phase additionally asserts direct switching.',
      activeTrack: beats[0].id, inspectedTrack: beats[1].id, selectedTracks: [beats[2].id, beats[4].id], missingTrack: beats[3].id,
      captures }, null, 2))
    console.log(JSON.stringify({ phase, captures }))
  } finally {
    await closeOwnedApp(app, page ?? await app.firstWindow().catch(() => null), info)
  }
})
