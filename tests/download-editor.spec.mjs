import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function downloadTest(name, run, hash = 'download') {
  test(`download interaction: ${name}`, async ({}, info) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const app = await electron.launch({ args: ['tests/harness/electron.cjs', `--user-data-dir=${path.resolve(info.outputPath('profile'))}`], env })
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.getByRole('button', { name: 'Open dialog', exact: true }).waitFor()
      const url = pathToFileURL(path.resolve('test-results/component-build/index.html'))
      url.search = '?download-interaction'
      url.hash = hash
      await page.goto(url.href)
      await page.waitForFunction(hash => !!window[hash === 'queue' ? 'queueTest' : 'download'], hash)
      await run(page)
      expect(errors).toEqual([])
    } finally { await app.close() }
  })
}

downloadTest('keyboard queueing is single flight and retains the next batch', async page => {
  const input = page.getByLabel('YouTube or SoundCloud beat links')
  const first = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  const next = 'https://www.youtube.com/watch?v=9bZkp7q19f0'
  await input.fill(first)
  await input.press('Control+Enter')
  await input.press('Control+Enter')
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.download.queued)).toEqual([[first]])
  await input.fill(next)
  await page.evaluate(() => window.download.releaseQueue())
  await expect(page.getByText('Queued 1 link', { exact: true })).toBeVisible()
  await expect(input).toHaveValue(next)
  await page.evaluate(() => { window.download.queueMode = 'success' })
  await input.press('Control+Enter')
  await expect(input).toHaveValue('')
  expect(await page.evaluate(() => window.download.queued)).toEqual([[first], [next]])
})

downloadTest('SoundCloud and YouTube links can be queued together', async page => {
  await page.evaluate(() => { window.download.queueMode = 'success' })
  const input = page.getByLabel('YouTube or SoundCloud beat links')
  const links = 'https://soundcloud.com/producer/beat\nhttps://youtu.be/dQw4w9WgXcQ'
  await input.fill(links)
  await expect(page.getByText('2 ready', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect(input).toHaveValue('')
  expect(await page.evaluate(() => window.download.queued)).toEqual([[links]])
  await input.fill('https://soundcloud.com/producer/sets/beats')
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled()
})

downloadTest('playlist review selects tracks, merges direct links and preserves the next pasted batch', async page => {
  await page.evaluate(() => {
    window.sonic = { invoke: async () => ({ title: 'Producer beats', tracks: [
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'First beat' },
      { url: 'https://www.youtube.com/watch?v=9bZkp7q19f0', title: 'Second beat' }
    ], skipped: 2, limited: false }) }
  })
  const input = page.getByLabel('YouTube or SoundCloud beat links')
  await input.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest123\nhttps://soundcloud.com/producer/beat')
  await page.getByRole('button', { name: 'Review playlists', exact: true }).click()
  const review = page.getByRole('region', { name: 'Review playlist tracks' })
  await expect(review).toBeVisible()
  expect(await page.evaluate(() => window.download.queued)).toEqual([])
  await expect(review.getByText(/2 unavailable or duplicate/)).toBeVisible()
  await review.getByRole('checkbox', { name: 'Second beat' }).uncheck()
  await input.fill('https://youtu.be/9bZkp7q19f0')
  await review.getByRole('button', { name: 'Queue 2 selected', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.download.queued)).toEqual([[
    'https://soundcloud.com/producer/beat', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  ]])
  await expect(review.getByRole('checkbox', { name: 'First beat' })).toBeDisabled()
  await page.evaluate(() => window.download.releaseQueue())
  await expect(review).toBeHidden()
  await expect(input).toHaveValue('https://youtu.be/9bZkp7q19f0')
})

downloadTest('playlist failure and cancellation retain input without queueing', async page => {
  await page.evaluate(() => {
    window.sonic = { invoke: async () => { throw new Error('Playlist unavailable') } }
  })
  const input = page.getByLabel('YouTube or SoundCloud beat links')
  const url = 'https://www.youtube.com/playlist?list=PLtest123'
  await input.fill(url)
  await page.getByRole('button', { name: 'Review playlists', exact: true }).click()
  await expect(page.getByText('Playlist unavailable', { exact: true })).toBeVisible()
  await expect(input).toHaveValue(url)
  await page.evaluate(() => {
    let rejectRead
    window.sonic = { invoke: async channel => {
      if (channel === 'playlist:cancel') { rejectRead(new Error('Cancelled')); return }
      return new Promise((_resolve, reject) => { rejectRead = reject })
    } }
  })
  await input.press('Control+Enter')
  await page.getByRole('button', { name: 'Cancel reading', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review playlists', exact: true })).toBeEnabled()
  await expect(page.getByRole('region', { name: 'Review playlist tracks' })).toBeHidden()
  expect(await page.evaluate(() => window.download.queued)).toEqual([])
  await expect(input).toHaveValue(url)
})

downloadTest('playlist pagination keeps selections and a failed queue submission can be retried', async page => {
  await page.evaluate(() => {
    window.download.queueMode = 'failure'
    window.sonic = { invoke: async () => ({ title: 'Long playlist', skipped: 0, limited: true,
      tracks: Array.from({ length: 51 }, (_, i) => ({ url: `https://www.youtube.com/watch?v=${String(i).padStart(11, '0')}`, title: `Track ${i + 1}` })) }) }
  })
  await page.getByLabel('YouTube or SoundCloud beat links').fill('https://youtube.com/playlist?list=PLtest123')
  await page.getByRole('button', { name: 'Review playlists', exact: true }).click()
  const review = page.getByRole('region', { name: 'Review playlist tracks' })
  await expect(review.getByText(/first 500 entries only/)).toBeVisible()
  await review.getByRole('button', { name: 'Select none', exact: true }).click()
  await expect(review.getByRole('button', { name: 'Queue 0 selected', exact: true })).toBeDisabled()
  await review.getByRole('checkbox', { name: 'Track 1', exact: true }).check()
  await review.getByRole('button', { name: 'Next tracks', exact: true }).click()
  await review.getByRole('checkbox', { name: 'Track 51', exact: true }).check()
  await review.getByRole('button', { name: 'Queue 2 selected', exact: true }).click()
  await expect(page.getByText('Could not queue playlist tracks', { exact: true })).toBeVisible()
  await expect(review).toBeVisible()
  await page.evaluate(() => { window.download.queueMode = 'success' })
  await review.getByRole('button', { name: 'Queue 2 selected', exact: true }).click()
  await expect(review).toBeHidden()
  expect(await page.evaluate(() => window.download.queued[1])).toEqual([
    'https://www.youtube.com/watch?v=00000000000', 'https://www.youtube.com/watch?v=00000000050'
  ])
})

downloadTest('failed keyboard and button requests retain links for retry', async page => {
  const input = page.getByLabel('YouTube or SoundCloud beat links')
  const link = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  await page.evaluate(() => { window.download.queueMode = 'failure' })
  await input.fill(link)
  await input.press('Control+Enter')
  await expect(page.getByText('Could not queue links', { exact: true })).toBeVisible()
  await expect(input).toHaveValue(link)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.download.queued.length)).toBe(2)
  await expect(input).toHaveValue(link)
  await page.evaluate(() => { window.download.queueMode = 'success' })
  await input.press('Control+Enter')
  await expect(input).toHaveValue('')
})

downloadTest('incoming metadata preserves the draft and updates untouched fields', async page => {
  const bpm = page.getByLabel('BPM', { exact: true })
  const key = page.getByLabel('Key', { exact: true })
  await bpm.fill('133')
  await page.evaluate(() => window.download.revise({ bpm: 144, key: 'D minor' }))
  await expect(bpm).toHaveValue('133')
  await expect(key).toHaveValue('D minor')
  await bpm.press('Enter')
  await expect.poll(() => page.evaluate(() => window.download.edits)).toEqual([{ metadataEdit: { field: 'bpm', value: 133 } }])
  await expect(bpm).toHaveValue('133')
  await key.fill('  F# minor  ')
  await key.press('Enter')
  await expect(key).toHaveValue('F# minor')
})

downloadTest('metadata is read-only once conversion starts and an interrupted edit is reported', async page => {
  const bpm = page.getByLabel('BPM', { exact: true })
  await bpm.fill('133')
  await page.evaluate(() => window.download.setStage('converting'))
  await expect(page.getByRole('note')).toContainText('Library inspector')
  await expect(bpm).toHaveAttribute('readonly', '')
  await expect(bpm).toHaveValue('120')
  await expect(page.getByRole('alert')).toContainText('Not saved')
  await page.getByLabel('Title', { exact: true }).click()
  await page.keyboard.type('changed')
  await page.getByRole('button', { name: 'Outside field', exact: true }).click()
  expect(await page.evaluate(() => window.download.edits)).toEqual([])
  await page.evaluate(() => window.download.setStage('complete'))
  await expect(page.getByRole('note')).toContainText('in your library')
})

downloadTest('metadata failures retain the draft and a pending edit submits once', async page => {
  const bpm = page.getByLabel('BPM', { exact: true })
  await page.evaluate(() => { window.download.editMode = 'failure' })
  await bpm.fill('133')
  await bpm.press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Metadata write failed; retry your edit')
  await expect(bpm).toHaveValue('133')
  await page.evaluate(() => { window.download.editMode = 'barrier' })
  await bpm.press('Enter')
  await expect(bpm).toBeDisabled()
  await page.getByRole('button', { name: 'Outside field' }).click()
  expect(await page.evaluate(() => window.download.edits.length)).toBe(2)
  await page.evaluate(() => window.download.releaseEdit())
  await expect(bpm).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(() => window.download.revise({ bpm: 144 }))
  await expect(bpm).toHaveValue('144')
  await bpm.fill('150')
  await bpm.press('Escape')
  await expect(bpm).toHaveValue('144')
})

downloadTest('one progress update renders one row in a 100-job queue', async page => {
  await expect(page.locator('[data-job-id]')).toHaveCount(100)
  await page.evaluate(() => { window.queueTest.reset(); window.queueTest.progress() })
  await expect(page.locator('[data-job-id="job-0"]')).toContainText('42%')
  expect(await page.evaluate(() => window.queueTest.renders)).toEqual({ 'job-0': 1 })
  await page.locator('[data-job-id="job-50"]').getByRole('button', { name: 'job-50', exact: true }).click()
  expect(await page.evaluate(() => window.queueTest.renders)).toEqual({ 'job-0': 1, 'job-50': 1 })
  await page.locator('[data-job-id="job-50"]').getByRole('button', { name: 'job-50', exact: true }).click()
  await expect(page.locator('[data-job-id="job-50"]').getByRole('button', { name: 'job-50', exact: true })).toHaveAttribute('aria-pressed', 'false')
}, 'queue')
