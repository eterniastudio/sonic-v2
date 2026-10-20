import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

function editorTest(name, run) {
  test(`metadata correction: ${name}`, async ({}, info) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const app = await electron.launch({ args: ['tests/harness/electron.cjs', '--editor-harness', `--user-data-dir=${path.resolve(info.outputPath(`profile-${Date.now()}`))}`], env })
    const page = await app.firstWindow(); page.setDefaultTimeout(10000)
    try {
      await page.getByText('Correct BPM / key', { exact: true }).click()
      await page.waitForFunction(() => !!window.editor)
      await run(page)
    } finally { await app.close() }
  })
}

editorTest('Reset BPM preserves an unsaved key', async page => {
  await page.getByLabel('Manual key', { exact: true }).fill('F# minor')
  await page.getByRole('button', { name: 'Reset BPM to evidence priority', exact: true }).click()
  await expect(page.getByLabel('Manual BPM', { exact: true })).toHaveValue('100')
  await expect(page.getByLabel('Manual key', { exact: true })).toHaveValue('F# minor')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  expect(await page.evaluate(() => window.editor.calls)).toEqual([{ patch: {}, reset: ['bpm', 'altBpm'] }, { patch: { key: 'F# minor' }, reset: undefined }])
})

editorTest('Reset key preserves an unsaved BPM', async page => {
  await page.getByLabel('Manual BPM', { exact: true }).fill('133')
  await page.getByRole('button', { name: 'Reset key to evidence priority', exact: true }).click()
  await expect(page.getByLabel('Manual key', { exact: true })).toHaveValue('C major')
  await expect(page.getByLabel('Manual BPM', { exact: true })).toHaveValue('133')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  expect(await page.evaluate(() => window.editor.calls[1].patch)).toEqual({ bpm: 133 })
})

for (const edited of ['BPM', 'key']) {
  editorTest(`an incoming revision updates untouched ${edited === 'BPM' ? 'key' : 'BPM'} only`, async page => {
    await page.getByLabel(`Manual ${edited}`, { exact: true }).fill(edited === 'BPM' ? '133' : 'F# minor')
    await page.evaluate(() => window.editor.revise({ bpm: 144, key: 'D minor', camelot: '7A' }))
    await expect(page.getByLabel('Manual BPM', { exact: true })).toHaveValue(edited === 'BPM' ? '133' : '144')
    await expect(page.getByLabel('Manual key', { exact: true })).toHaveValue(edited === 'key' ? 'F# minor' : 'D minor')
    await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
    expect(await page.evaluate(() => window.editor.calls[0].patch)).toEqual(edited === 'BPM' ? { bpm: 133 } : { key: 'F# minor' })
  })
}

editorTest('save during a new revision submits only its edited field', async page => {
  await page.evaluate(() => { window.editor.mode = 'barrier' })
  await page.getByLabel('Manual BPM', { exact: true }).fill('133')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  await expect(page.getByLabel('Manual BPM', { exact: true })).toBeDisabled()
  await page.evaluate(() => window.editor.revise({ bpm: 144, key: 'D minor', camelot: '7A' }))
  await expect(page.getByLabel('Manual key', { exact: true })).toHaveValue('D minor')
  await page.evaluate(() => window.editor.release())
  await expect(page.getByRole('button', { name: 'Save corrections', exact: true })).toBeDisabled()
  const record = JSON.parse(await page.getByLabel('Current record').textContent())
  expect(record.bpm).toBe(133); expect(record.key).toBe('D minor')
  expect(await page.evaluate(() => window.editor.calls[0].patch)).toEqual({ bpm: 133 })
})

editorTest('failed and partial persistence retain the draft for a bounded retry', async page => {
  await page.evaluate(() => { window.editor.mode = 'failure' })
  await page.getByLabel('Manual BPM', { exact: true }).fill('133')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('changes remain unsaved')
  await expect(page.getByLabel('Manual BPM', { exact: true })).toHaveValue('133')
  await page.evaluate(() => { window.editor.mode = 'partial' })
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('sidecar synchronization failed')
  await expect(page.getByRole('button', { name: 'Save corrections', exact: true })).toBeEnabled()
  await page.evaluate(() => { window.editor.mode = 'success' })
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save corrections', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.editor.calls.map(call => call.patch))).toEqual([{ bpm: 133 }, { bpm: 133 }, { bpm: 133 }])
})

editorTest('leaving the editor saves a valid draft once', async page => {
  await page.getByLabel('Manual BPM', { exact: true }).fill('133')
  await page.getByLabel('Manual key', { exact: true }).fill('F# minor')
  await page.getByLabel('Current record').click()
  await expect(page.getByRole('button', { name: 'Save corrections', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.editor.calls)).toEqual([{ patch: { bpm: 133, key: 'F# minor' }, reset: undefined }])
})

editorTest('closing the editor saves an unsaved draft once', async page => {
  await page.getByLabel('Manual BPM', { exact: true }).fill('137')
  await page.evaluate(() => window.editor.hide())
  await expect(page.getByLabel('Manual BPM', { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.editor.calls)).toEqual([{ patch: { bpm: 137 }, reset: undefined }])
  expect(JSON.parse(await page.getByLabel('Current record').textContent()).bpm).toBe(137)
})

editorTest('validation and intentional clearing use canonical shared rules', async page => {
  await page.getByLabel('Manual key', { exact: true }).fill('not a key')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Enter a key')
  await expect(page.getByLabel('Manual key', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('Manual key', { exact: true })).toBeFocused()
  expect(await page.evaluate(() => window.editor.calls)).toEqual([])
  await page.getByLabel('Manual key', { exact: true }).fill('11A')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  await expect(page.getByLabel('Manual key', { exact: true })).toHaveValue('F# minor')
  await page.getByLabel('Manual BPM', { exact: true }).fill('301')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('40–300')
  await page.getByLabel('Manual BPM', { exact: true }).fill('')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  expect(await page.evaluate(() => window.editor.calls[1])).toEqual({ patch: { bpm: null }, reset: undefined })
  await page.getByLabel('Manual key', { exact: true }).fill('')
  await page.getByRole('button', { name: 'Save corrections', exact: true }).click()
  await expect(page.getByLabel('Manual key', { exact: true })).toHaveValue('')
  const record = JSON.parse(await page.getByLabel('Current record').textContent())
  expect(record.key).toBeNull(); expect(record.camelot).toBeNull(); expect(record.overrides).toContain('key')
})

editorTest('ambiguous key candidates can be tried without losing an unsaved tempo, then saved with the keyboard', async page => {
  await page.evaluate(() => window.editor.revise({ analysis: {
    engine: 'sonic-dsp/test', inputId: 'test', inputName: 'fixture.wav', analyzedAt: 0,
    analyzedSeconds: 20, durationSec: 20, sampleRate: 22050, channels: 1, warnings: [],
    tempo: { status: 'estimated', bpm: 120, bpmExact: 120, alternatives: [], confidence: 0.7, warning: null },
    key: { status: 'inconclusive', key: null, camelot: null, confidence: 0.1, tuningCents: 0,
      warning: 'Relative keys are close', alternatives: [
        { key: 'F# minor', camelot: '11A', correlation: 0.8 },
        { key: 'A major', camelot: '11B', correlation: 0.79 }
      ] }
  } }))
  const candidates = page.getByRole('region', { name: 'Detected key candidates' })
  await expect(candidates).toContainText('Key needs a listening check')
  await expect(page.getByRole('button', { name: 'Use measured key', exact: true })).toBeDisabled()
  await page.getByLabel('Manual BPM', { exact: true }).fill('133')
  await candidates.getByRole('button', { name: 'Try F# minor (11A)', exact: true }).click()
  await expect(page.getByLabel('Manual key', { exact: true })).toHaveValue('F# minor')
  await expect(page.getByLabel('Manual BPM', { exact: true })).toHaveValue('133')
  expect(await page.evaluate(() => window.editor.calls)).toEqual([])
  await expect(page.locator('details').getByRole('status')).toContainText('Save corrections to apply it')
  await page.getByLabel('Manual key', { exact: true }).press('Control+Enter')
  expect(await page.evaluate(() => window.editor.calls)).toEqual([{ patch: { bpm: 133, key: 'F# minor' }, reset: undefined }])
  await expect(page.locator('details').getByRole('status')).toHaveText('Corrections saved.')
})
test('component overlays: nesting, flipping, focus, interrupted transitions and failed confirmation', async ({}, info) => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['tests/harness/electron.cjs', `--user-data-dir=${path.resolve(info.outputPath('profile'))}`], env })
  const page = await app.firstWindow(); page.setDefaultTimeout(10000)
  await app.context().tracing.start({ screenshots: true, snapshots: true })
  try {
    const picker = page.getByRole('button', { name: 'Pick 0', exact: true })
    await picker.focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('menu', { name: 'Pick 0', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'Option 0', exact: true })).toBeFocused()
    await page.keyboard.press('o')
    await expect(page.getByRole('menuitemradio', { name: 'Option 1', exact: true })).toBeFocused()
    await page.keyboard.press('o')
    await expect(page.getByRole('menuitemradio', { name: 'Option 2', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(picker).toBeFocused()
    await picker.click()
    const last = page.getByRole('menuitemradio', { name: 'Option 17', exact: true })
    await last.scrollIntoViewIfNeeded(); await last.click()
    await expect(page.getByLabel('Selections')).toHaveText('1')
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Open dialog', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Nested overlay' })
      await expect(dialog).toHaveAccessibleDescription('Choose an option before closing this dialog.')
      await expect(dialog).toBeFocused()
      const nested = dialog.getByRole('button', { name: 'Pick 17', exact: true })
      await nested.click(); await nested.click(); await nested.click()
      await expect(page.getByRole('menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0); await expect(dialog).toBeVisible()
      await nested.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End')
      await expect(last).toBeFocused(); await page.keyboard.press('Escape')
      await dialog.getByRole('button', { name: 'Last control' }).focus(); await page.keyboard.press('Tab')
      expect(await dialog.evaluate(n => n.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Open dialog', exact: true })).toBeFocused()
    }
    await page.getByRole('button', { name: 'Confirm operation' }).click()
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Working…' })).toBeDisabled()
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveText('Deliberate write failure')
    await expect(page.getByLabel('Selections')).toHaveText('2')
  } finally {
    await page.screenshot({ path: info.outputPath('components.png') })
    await app.context().tracing.stop({ path: info.outputPath('trace.zip') }); await app.close()
  }
})
