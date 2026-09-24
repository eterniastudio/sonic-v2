import { app } from 'electron'
import assert from 'node:assert/strict'
import fs, { appendFile, readFile, writeFile, mkdir, rename, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { libraryAnalysis } from '../src/main/analysis/libraryAnalysis'
import { analysisService } from '../src/main/analysis/service'
import { libraryService } from '../src/main/services/library'
import { settingsService } from '../src/main/services/settings'
import { decideMetadataField, parseDeclared, publishedTagStatus } from '../src/shared/metadata'
import { reexportBeat } from '../src/main/services/reexport'
import { probeMediaFile, tagsToMetadata } from '../src/main/services/ffprobe'
import { retryStorage } from '../src/main/lib/jsonStore'
import { queueService } from '../src/main/services/queue'
import { engineService } from '../src/main/services/engine'
import { stagingDir } from '../src/main/services/paths'
import { preferredSourceChannel } from '../src/main/services/probe'
import { renderExportStem } from '../src/shared/template'

app.whenReady().then(async () => {
  const checks: { name: string; ok: boolean; error?: string }[] = []
  const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => { try { await fn(); checks.push({ name, ok: true }) } catch (error) { checks.push({ name, ok: false, error: String(error) }) } }
  const waitIdle = async (): Promise<void> => {
    const deadline = Date.now() + 90000
    while (libraryAnalysis.status().running || libraryAnalysis.queuedCount) {
      if (Date.now() > deadline) throw new Error('Analysis did not drain in 90 seconds')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  await check('original source metadata parser', () => {
    const parsed = parseDeclared({ title: '[FREE] "Midnight Drive" Type Beat - prod. by KBeats [144 BPM] [F# minor]' })
    assert.equal(parsed.values.bpm, 144); assert.equal(parsed.values.key, 'F# minor'); assert.equal(parsed.values.producer, 'KBeats')
  })
  await check('YouTube channel takes precedence over uploader and blank values', () => {
    assert.equal(preferredSourceChannel({ channel: '  Real Channel  ', uploader: 'Account alias' }), 'Real Channel')
    assert.equal(preferredSourceChannel({ channel: ' ', uploader: 'Fallback uploader' }), 'Fallback uploader')
    assert.equal(preferredSourceChannel({}), null)
  })
  await check('cancel before worker startup', async () => {
    const beat = libraryService.get('fixture-0')!
    const promise = analysisService.analyze({ requestId: 'early-cancel', inputPath: beat.filePath, durationSec: beat.durationSec, force: true })
    analysisService.cancel('early-cancel')
    assert.equal((await promise).cancelled, true)
  })
  await check('batch schedules every item without dropping pending tail', async () => {
    assert.equal(libraryAnalysis.queue(libraryService.list().map(beat => beat.id)), 4)
    await waitIdle()
    for (const beat of libraryService.list()) assert.ok(beat.analysis, `${beat.id} was dropped`)
  })
  await check('per-field overrides and independent reset', async () => {
    await libraryService.updateMetadata('fixture-0', { bpm: 133, key: 'F# minor' })
    await libraryAnalysis.analyze('fixture-0', { force: true })
    let beat = libraryService.get('fixture-0')!
    assert.equal(beat.bpm, 133); assert.equal(beat.key, 'F# minor')
    await libraryService.updateMetadata(beat.id, {}, ['bpm', 'altBpm'])
    beat = libraryService.get(beat.id)!
    assert.equal(beat.overrides.includes('bpm'), false); assert.equal(beat.key, 'F# minor'); assert.equal(beat.overrides.includes('key'), true)
  })
  await check('correction renames owned audio with BPM and key and persists the new path', async () => {
    const before = libraryService.get('fixture-0')!
    await libraryService.updateMetadata(before.id, { title: 'DAW Ready', bpm: 136, key: 'F# minor' })
    const after = libraryService.get(before.id)!
    assert.match(after.fileName, /DAW Ready.*136 BPM.*F# minor/)
    assert.notEqual(after.filePath, before.filePath)
    assert.equal(await fs.stat(after.filePath).then(() => true), true)
    await assert.rejects(fs.stat(before.filePath), { code: 'ENOENT' })
    const persisted = JSON.parse(await readFile(path.join(app.getPath('userData'), 'library.json'), 'utf8'))
    assert.equal(persisted.find((entry: { id: string }) => entry.id === before.id).filePath, after.filePath)
    assert.equal(renderExportStem('{title}', { metadata: { title: 'DAW Ready', producer: null, bpm: 136,
      altBpm: null, key: 'F# minor', camelot: '11A', detune: null, tuning: null, genre: null },
      presetId: after.presetId, sourceKind: after.sourceKind }), 'DAW Ready [136 BPM] [F# minor]')
  })
  await check('failed rename commit retains both audio paths until storage retry', async () => {
    const before = libraryService.get('fixture-0')!
    const libraryPath = path.join(app.getPath('userData'), 'library.json')
    await rename(libraryPath, `${libraryPath}.rename-saved`)
    await mkdir(libraryPath)
    try {
      await assert.rejects(libraryService.updateMetadata(before.id, { title: 'Pending Rename' }))
    } finally {
      await rmdir(libraryPath)
      await rename(`${libraryPath}.rename-saved`, libraryPath)
    }
    assert.equal(libraryService.get(before.id)?.filePath, before.filePath)
    assert.ok(await fs.stat(before.filePath))
    const candidates = (await fs.readdir(path.dirname(before.filePath))).filter(name => name.startsWith('Pending Rename') && name.endsWith('.wav'))
    assert.equal(candidates.length, 1, `Audio candidates: ${JSON.stringify(await fs.readdir(path.dirname(before.filePath)))}`)
    const pendingPath = path.join(path.dirname(before.filePath), candidates[0])
    assert.ok(await fs.stat(pendingPath))
    retryStorage()
    assert.equal(libraryService.get(before.id)?.filePath, pendingPath)
    assert.equal(JSON.parse(await readFile(libraryPath, 'utf8')).find((entry: { id: string }) => entry.id === before.id).filePath, pendingPath)
  })
  await check('changed input rejects stale analysis', async () => {
    const beat = libraryService.get('fixture-1')!
    await appendFile(beat.filePath, 'external change')
    assert.equal(await libraryService.applyAnalysis(beat.id, beat.analysis!), null)
    assert.equal((await libraryService.remove(beat.id, true)).ok, false)
  })
  await check('delete during analysis never resurrects record', async () => {
    const pending = libraryAnalysis.analyze('fixture-2', { force: true })
    libraryAnalysis.cancel('fixture-2')
    assert.equal((await libraryService.remove('fixture-2', true)).ok, true)
    await pending
    assert.equal(libraryService.get('fixture-2'), null)
  })
  await check('actual export preserves corrected metadata, format and sidecar ownership', async () => {
    await libraryService.updateMetadata('fixture-0', { bpm: 133, key: 'F# minor' })
    settingsService.patch({ defaultPresetId: 'flac' })
    const result = await reexportBeat('fixture-0', settingsService.get().defaultPresetId)
    assert.equal(result.ok, true, result.error ?? '')
    const media = await probeMediaFile(result.outputPath!)
    assert.equal(media.audio?.codec, 'flac')
    const tags = tagsToMetadata(media.tags)
    assert.equal(tags.bpm, 133); assert.equal(tags.key, 'F# minor')
    const beat = libraryService.list().find(entry => entry.filePath === result.outputPath)!
    assert.equal(beat.bpm, 133); assert.equal(beat.key, 'F# minor')
    assert.deepEqual(beat.publishedTags, tags)
    assert.equal(publishedTagStatus(beat, beat.publishedTags), 'current')
    await libraryService.updateMetadata(beat.id, { bpm: 134 })
    assert.equal(publishedTagStatus(libraryService.get(beat.id)!, beat.publishedTags), 'out-of-sync')
    const updatedBeat = libraryService.get(beat.id)!
    const sidecar = JSON.parse(await readFile(updatedBeat.sidecarPath!, 'utf8'))
    assert.equal(sidecar.metadata.bpm, 134)
    assert.deepEqual(beat.embedded, {}) // Never treat Sonic's own written tags as source evidence.
    assert.equal((await libraryService.remove(beat.id, true)).ok, true)
  })
  await check('simultaneous re-exports use independent staging and publish two owned outputs', async () => {
    const [first, second] = await Promise.all([
      reexportBeat('fixture-0', 'flac'), reexportBeat('fixture-0', 'flac')
    ])
    assert.equal(first.ok, true, first.error ?? '')
    assert.equal(second.ok, true, second.error ?? '')
    assert.notEqual(first.outputPath, second.outputPath)
    for (const result of [first, second]) {
      const beat = libraryService.list().find(entry => entry.filePath === result.outputPath)!
      assert.ok(beat)
      assert.equal((await probeMediaFile(beat.filePath)).audio?.codec, 'flac')
      assert.equal(JSON.parse(await readFile(beat.sidecarPath!, 'utf8')).output.fingerprint, beat.fingerprint)
      assert.equal((await libraryService.remove(beat.id, true)).ok, true)
    }
    assert.deepEqual((await fs.readdir(stagingDir())).filter(name => name.startsWith('reexport-')), [])
  })
  await check('exclusive publication preserves a concurrent unrelated output', async () => {
    const originalOpen = fs.open
    let collision: string | null = null
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      if (!collision && args[1] === 'wx' && String(args[0]).endsWith('.flac')) {
        collision = String(args[0])
        const other = await originalOpen(...args)
        try { await other.writeFile('unrelated export') } finally { await other.close() }
      }
      return originalOpen(...args)
    }) as typeof fs.open
    try {
      const result = await reexportBeat('fixture-0', 'flac')
      assert.equal(result.ok, false)
      assert.ok(collision)
      assert.equal(await readFile(collision!, 'utf8'), 'unrelated export')
    } finally { fs.open = originalOpen }
  })
  await check('failed library publication preserves files for pending-store retry', async () => {
    const libraryPath = path.join(app.getPath('userData'), 'library.json')
    const before = new Set(libraryService.list().map(beat => beat.id))
    let resultBeatId: string | undefined
    let resultOutputPath: string | null = null
    await rename(libraryPath, `${libraryPath}.test-saved`)
    await mkdir(libraryPath)
    try {
      const result = await reexportBeat('fixture-0', 'flac')
      assert.equal(result.ok, false)
      assert.match(result.error!, /Export files preserved/)
      assert.equal(result.pendingSave, true)
      assert.ok(result.outputPath)
      assert.ok(result.publishedBeatId)
      resultBeatId = result.publishedBeatId
      resultOutputPath = result.outputPath
    } finally { await rmdir(libraryPath); await rename(`${libraryPath}.test-saved`, libraryPath) }
    assert.throws(() => libraryService.setAnalysisStatus('fixture-0', 'queued'), /must be retried/)
    const failedStart = await libraryAnalysis.analyze('fixture-0')
    assert.equal(failedStart.ok, false)
    assert.equal(libraryAnalysis.isRunning('fixture-0'), false)
    retryStorage()
    const recovered = libraryService.list().find(beat => !before.has(beat.id))!
    assert.ok(recovered)
    assert.equal(recovered.id, resultBeatId)
    assert.equal(recovered.filePath, resultOutputPath)
    assert.equal((await probeMediaFile(recovered.filePath)).audio?.codec, 'flac')
    assert.equal(JSON.parse(await readFile(recovered.sidecarPath!, 'utf8')).output.fingerprint, recovered.fingerprint)
    const originalUnlink = fs.unlink
    fs.unlink = (async (file: Parameters<typeof fs.unlink>[0]) => {
      if (String(file) === recovered.sidecarPath) throw Object.assign(new Error('Injected locked sidecar'), { code: 'EPERM' })
      return originalUnlink(file)
    }) as typeof fs.unlink
    try {
      const removed = await libraryService.remove(recovered.id, true)
      assert.equal(removed.ok, false)
      assert.match(removed.reason!, /Audio removed/)
      assert.equal(libraryService.get(recovered.id)?.missing, true)
      assert.ok(await readFile(recovered.sidecarPath!))
    } finally { fs.unlink = originalUnlink }
    assert.equal((await libraryService.remove(recovered.id, true)).ok, true)
  })
  await check('sidecar synchronization failure is reported with saved library correction', async () => {
    const beat = libraryService.get('fixture-3')!
    const sidecarPath = path.join(app.getPath('userData'), 'missing', 'sidecar.json')
    libraryService.add({ ...beat, sidecarPath })
    await libraryService.updateMetadata(beat.id, { bpm: 127 })
    const saved = libraryService.get(beat.id)!
    assert.equal(saved.bpm, 127)
    assert.equal(saved.sidecarSync?.status, 'error')
    assert.equal(saved.analysisStatus, beat.analysisStatus)
    assert.deepEqual(saved.analysis, beat.analysis)
    const newAnalysis = { ...beat.analysis!, analyzedAt: beat.analysis!.analyzedAt + 1 }
    await libraryService.applyAnalysis(beat.id, newAnalysis)
    assert.equal(libraryService.get(beat.id)?.analysis?.analyzedAt, newAnalysis.analyzedAt)
    assert.equal(libraryService.get(beat.id)?.sidecarSync?.status, 'error')
    assert.notEqual(libraryService.get(beat.id)?.analysisStatus, 'failed')
    assert.equal(JSON.parse(await readFile(path.join(app.getPath('userData'), 'library.json'), 'utf8')).find((b: { id: string }) => b.id === beat.id).sidecarSync.status, 'error')
    await mkdir(path.dirname(sidecarPath), { recursive: true })
    await writeFile(sidecarPath, JSON.stringify({ schema: 'sonic-v2/beat', schemaVersion: 2,
      metadata: {}, output: { filePath: beat.fileName, fingerprint: beat.fingerprint } }))
    await libraryService.retrySidecar(beat.id)
    assert.equal(libraryService.get(beat.id)?.sidecarSync?.status, 'synced')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
    assert.equal(sidecar.metadata.bpm, 127)
    assert.deepEqual(sidecar.analysis, newAnalysis)
  })
  await check('barrier: concurrent correction and analysis preserve full sidecar revision', async () => {
    const beat = libraryService.get('fixture-3')!
    const originalRead = fs.readFile
    let release!: () => void, entered!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { entered = resolve })
    let intercepted = false
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      const result = await originalRead(...args)
      if (String(args[0]) === beat.sidecarPath && !intercepted) { intercepted = true; entered(); await barrier }
      return result
    }) as typeof fs.readFile
    let correction: Promise<unknown> | undefined, analysis: Promise<unknown> | undefined
    try {
      correction = libraryService.updateMetadata(beat.id, { bpm: 147, key: 'F# minor' })
      await reached
      const nextAnalysis = { ...beat.analysis!, analyzedAt: beat.analysis!.analyzedAt + 1 }
      analysis = libraryService.applyAnalysis(beat.id, nextAnalysis)
      // Filename ownership verification may now hold the per-beat mutation lock
      // while this controlled sidecar read is paused. Release it, then inspect
      // the final committed revision rather than requiring an interleaving.
      release()
      await Promise.all([correction, analysis])
      const sidecar = JSON.parse(await originalRead(libraryService.get(beat.id)!.sidecarPath!, 'utf8'))
      assert.equal(sidecar.metadata.bpm, 147)
      assert.equal(sidecar.metadata.key, 'F# minor')
      assert.equal(sidecar.metadata.camelot, '11A')
      assert.equal(sidecar.analysis.analyzedAt, nextAnalysis.analyzedAt)
      assert.ok(sidecar.overrides.includes('bpm'))
      assert.deepEqual(sidecar.sources, libraryService.get(beat.id)?.sources)
      assert.deepEqual(sidecar.verification, libraryService.get(beat.id)?.verification)
      assert.equal(libraryService.get(beat.id)?.sidecarSync?.status, 'synced')
    } finally { release(); fs.readFile = originalRead; await Promise.allSettled([correction, analysis].filter(Boolean) as Promise<unknown>[]) }
  })
  await check('rescan and purge preserve metadata committed while checking files', async () => {
    const scan = libraryService.rescan()
    const purge = libraryService.purgeMissing()
    await libraryService.updateMetadata('fixture-3', { bpm: 151 })
    await Promise.all([scan, purge])
    assert.equal(libraryService.get('fixture-3')?.bpm, 151)
    await assert.rejects(libraryService.updateMetadata('fixture-3', { key: 'invalid key' }))
    assert.equal(libraryService.get('fixture-3')?.camelot, '11A')
    await libraryService.updateMetadata('fixture-3', { key: null })
    assert.equal(libraryService.get('fixture-3')?.key, null)
    assert.equal(libraryService.get('fixture-3')?.camelot, null)
  })
  await check('reset uses declared evidence before tags and audio, while measured remains a separate choice', async () => {
    const original = libraryService.get('fixture-3')!
    const sources = { title: { bpm: 140, key: 'C major', camelot: '8B' },
      description: { bpm: 142 }, filename: {} }
    libraryService.update(original.id, { sources, embedded: { bpm: 150, key: 'A minor' } })
    await libraryService.updateMetadata(original.id, { bpm: 180, key: 'E minor' })
    const manual = libraryService.get(original.id)!
    const decision = decideMetadataField('bpm', { current: manual, overrides: manual.overrides,
      sources: manual.sources, embedded: manual.embedded, analyzed: { bpm: 128 } })
    assert.equal(decision.origin, 'manual')
    assert.equal(decision.resetOrigin, 'title')
    assert.equal(decision.resetValue, 140)
    assert.equal(decision.measuredValue, 128)
    await libraryService.updateMetadata(original.id, {}, ['bpm', 'altBpm'])
    let reset = libraryService.get(original.id)!
    assert.equal(reset.bpm, 140)
    assert.equal(reset.key, 'E minor')
    assert.equal(reset.overrides.includes('bpm'), false)
    await libraryService.updateMetadata(original.id, {}, ['key', 'camelot'])
    reset = libraryService.get(original.id)!
    assert.equal(reset.key, 'C major')
    assert.equal(reset.camelot, '8B')
    assert.equal(reset.overrides.includes('key'), false)
    assert.equal(reset.sidecarSync?.status, 'synced')
  })
  await check('controlled queue debounce failure retains latest order and never escapes the timer', async () => {
    queueService.init()
    queueService.flush()
    const queuePath = path.join(app.getPath('userData'), 'queue.json')
    const original = globalThis.setTimeout
    let callback: (() => void) | undefined
    let handle: ReturnType<typeof setTimeout> | undefined
    globalThis.setTimeout = ((fn: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 900) { callback = fn; handle = original(() => {}, 60000); return handle }
      return original(fn, delay, ...args)
    }) as typeof setTimeout
    const errors: string[] = []
    queueService.on('persistence-error', error => errors.push(String(error)))
    const intended = queueService.snapshot().jobs.map(job => job.id).reverse()
    try {
      queueService.reorder(intended)
      assert.ok(callback, 'debounced write must be scheduled')
      await rename(queuePath, `${queuePath}.saved`); await mkdir(queuePath)
      try { assert.doesNotThrow(() => callback!()) } finally {
        await rmdir(queuePath); await rename(`${queuePath}.saved`, queuePath)
      }
      assert.equal(errors.length, 1)
      assert.deepEqual(queueService.snapshot().jobs.map(job => job.id), intended)
      queueService.flush()
      assert.deepEqual(JSON.parse(await readFile(queuePath, 'utf8')).jobs.map((job: { id: string }) => job.id), intended)
    } finally { globalThis.setTimeout = original; if (handle) clearTimeout(handle); await queueService.stopAll() }
  })
  await check('analysis deadline includes capacity wait and removes its waiter', async () => {
    const gate = analysisService as unknown as { active: number; waiting: (() => void)[] }
    const originalActive = gate.active
    gate.active = 100
    const beat = libraryService.get('fixture-0')!
    try {
      const result = await analysisService.analyze({ requestId: 'deadline-capacity', inputPath: beat.filePath,
        durationSec: beat.durationSec, force: true, timeoutMs: 50 })
      assert.equal(result.ok, false)
      assert.equal(result.cancelled, false)
      assert.match(result.error ?? '', /timed out after 50 ms/)
      assert.equal(gate.waiting.length, 0)
      assert.equal(gate.active, 100)
      assert.equal(analysisService.isRunning('deadline-capacity'), false)
    } finally { gate.active = originalActive }
  })
  await check('analysis deadline starts before engine resolution completes', async () => {
    const originalResolve = engineService.resolve
    engineService.resolve = (async (_name, _force, signal) => new Promise(resolve => {
      if (signal?.aborted) { resolve({ name: 'ffmpeg', path: null, version: null, origin: null }); return }
      signal?.addEventListener('abort', () => resolve({ name: 'ffmpeg', path: null,
        version: null, origin: null }), { once: true })
    })) as typeof engineService.resolve
    const beat = libraryService.get('fixture-0')!
    try {
      const result = await analysisService.analyze({ requestId: 'deadline-resolution', inputPath: beat.filePath,
        durationSec: beat.durationSec, force: true, timeoutMs: 25 })
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /timed out after 25 ms/)
      assert.equal(analysisService.isRunning('deadline-resolution'), false)
    } finally { engineService.resolve = originalResolve }
  })
  await check('cancelling during capacity wait settles without occupying a slot', async () => {
    const gate = analysisService as unknown as { active: number; waiting: (() => void)[] }
    const originalActive = gate.active
    gate.active = 100
    const beat = libraryService.get('fixture-0')!
    try {
      const pending = analysisService.analyze({ requestId: 'cancel-capacity', inputPath: beat.filePath,
        durationSec: beat.durationSec, force: true })
      const deadline = Date.now() + 10_000
      while (!gate.waiting.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(gate.waiting.length, 1, 'request should reach the controlled capacity gate')
      analysisService.cancel('cancel-capacity')
      const result = await pending
      assert.equal(result.cancelled, true)
      assert.equal(gate.waiting.length, 0)
      assert.equal(gate.active, 100)
      assert.equal(analysisService.isRunning('cancel-capacity'), false)
    } finally { gate.active = originalActive }
  })
  await writeFile(path.join(app.getPath('userData'), 'service-results.json'), JSON.stringify(checks, null, 2))
  console.log(JSON.stringify(checks, null, 2)); app.exit(checks.every(check => check.ok) ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
