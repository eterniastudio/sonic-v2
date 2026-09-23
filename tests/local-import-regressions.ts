import { app } from 'electron'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rmdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { localImportService } from '../src/main/services/localImport'
import { libraryService } from '../src/main/services/library'
import { libraryAnalysis } from '../src/main/analysis/libraryAnalysis'
import { retryStorage } from '../src/main/lib/jsonStore'

async function waitReview(id: string): Promise<NonNullable<ReturnType<typeof localImportService.status>>> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const review = localImportService.status(id)
    if (review && review.phase !== 'scanning' && review.phase !== 'importing') return review
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Import review did not settle.')
}

async function digest(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

app.whenReady().then(async () => {
  const profile = app.getPath('userData')
  const folder = path.join(profile, 'local-import-originals')
  const nested = path.join(folder, 'nested')
  await mkdir(nested, { recursive: true })
  const first = path.join(folder, 'Unicode ♫ [132 BPM] [A minor].wav')
  const second = path.join(nested, 'Another original.wav')
  const broken = path.join(folder, 'broken.mp3')
  const unsupported = path.join(folder, 'notes.txt')
  await copyFile(path.join(profile, 'exports', 'fixture-1.wav'), first)
  await copyFile(path.join(profile, 'exports', 'fixture-2.wav'), second)
  await writeFile(broken, 'not audio')
  await writeFile(unsupported, 'not audio')
  const firstHash = await digest(first)
  const secondHash = await digest(second)
  const seenQueue: string[][] = []
  const queue = libraryAnalysis.queue.bind(libraryAnalysis)
  libraryAnalysis.queue = (ids: string[]) => { seenQueue.push([...ids]); return ids.length }
  try {
    const shallowId = localImportService.begin([folder], 'folder', false)
    const shallow = await waitReview(shallowId)
    assert.equal(shallow.phase, 'ready')
    assert.ok(shallow.items.some(item => item.filePath === first && item.status === 'ready'))
    assert.ok(!shallow.items.some(item => item.filePath === second))
    assert.ok(shallow.items.some(item => item.filePath === broken && item.status === 'failed'))
    assert.ok(shallow.items.some(item => item.filePath === unsupported && item.status === 'unsupported'))

    const deepId = localImportService.begin([folder], 'folder', true)
    const deep = await waitReview(deepId)
    assert.equal(deep.phase, 'ready')
    const ready = deep.items.filter(item => item.status === 'ready')
    assert.equal(ready.length, 2)
    assert.ok(ready.every(item => item.duplicateOf), 'equal bytes in existing records should be warnings, not forced merges')
    const chosen = ready.map(item => item.id)
    const confirmed = await localImportService.confirm(deepId, chosen)
    assert.equal(confirmed.phase, 'done')
    assert.equal(confirmed.items.filter(item => item.status === 'imported').length, 2)
    assert.equal(seenQueue.flat().length, 2)
    const imported = libraryService.list().filter(beat => beat.filePath === first || beat.filePath === second)
    assert.equal(imported.length, 2)
    assert.ok(imported.every(beat => beat.fileOwnership === 'external' && beat.sourceKind === 'local' &&
      beat.sidecarPath === null && beat.publishedTags === null && beat.presetId === 'original'))
    assert.equal(imported.find(beat => beat.filePath === first)?.bpm, 132)
    assert.equal(await digest(first), firstHash)
    assert.equal(await digest(second), secondHash)

    const repeatId = localImportService.begin([first, second], 'files', false)
    const repeat = await waitReview(repeatId)
    assert.ok(repeat.items.every(item => item.status === 'already-indexed'))
    await localImportService.confirm(repeatId, repeat.items.map(item => item.id))
    assert.equal(libraryService.list().filter(beat => beat.filePath === first || beat.filePath === second).length, 2)

    const recovery = path.join(folder, 'Recovery original.wav')
    await copyFile(path.join(profile, 'exports', 'fixture-3.wav'), recovery)
    const recoveryHash = await digest(recovery)
    const recoveryId = localImportService.begin([recovery], 'files', false)
    const recoveryReview = await waitReview(recoveryId)
    const libraryPath = path.join(profile, 'library.json')
    const savedLibraryPath = `${libraryPath}.import-test-saved`
    await rename(libraryPath, savedLibraryPath)
    await mkdir(libraryPath)
    let failed
    try { failed = await localImportService.confirm(recoveryId, [recoveryReview.items[0].id]) }
    finally { await rmdir(libraryPath); await rename(savedLibraryPath, libraryPath) }
    assert.equal(failed.phase, 'error')
    assert.match(failed.error ?? '', /Library save is pending/)
    await assert.rejects(localImportService.cancel(recoveryId), /save is pending/)
    assert.equal(libraryService.list().some(beat => beat.filePath === recovery), false)
    retryStorage()
    const recovered = localImportService.status(recoveryId)!
    assert.equal(recovered.phase, 'ready')
    assert.equal(recovered.items[0].status, 'imported')
    const retried = await localImportService.confirm(recoveryId, [recoveryReview.items[0].id])
    assert.equal(retried.phase, 'done')
    assert.equal(libraryService.list().filter(beat => beat.filePath === recovery).length, 1)
    assert.equal(await digest(recovery), recoveryHash)
    assert.equal(seenQueue.flat().length, 3)

    const admission = path.join(folder, 'Admission original.wav')
    await copyFile(path.join(profile, 'exports', 'fixture-0.wav'), admission)
    const admissionId = localImportService.begin([admission], 'files', false)
    const admissionReview = await waitReview(admissionId)
    const previousQueue = libraryAnalysis.queue
    let failAdmission = true
    libraryAnalysis.queue = (ids: string[]) => {
      if (failAdmission) { failAdmission = false; throw new Error('Injected analysis admission failure') }
      seenQueue.push([...ids]); return ids.length
    }
    const admissionFailed = await localImportService.confirm(admissionId, [admissionReview.items[0].id])
    assert.equal(admissionFailed.phase, 'error')
    assert.equal(admissionFailed.items[0].status, 'imported')
    assert.match(localImportService.status(admissionId)?.error ?? '', /analysis scheduling needs attention/)
    assert.equal(libraryService.list().filter(beat => beat.filePath === admission).length, 1)
    const admissionRetried = await localImportService.confirm(admissionId, [admissionReview.items[0].id])
    assert.equal(admissionRetried.phase, 'done')
    assert.equal(seenQueue.flat().length, 4)
    libraryAnalysis.queue = previousQueue

    const pendingId = localImportService.begin([first], 'files', false)
    const cancelled = await localImportService.cancel(pendingId)
    assert.equal(cancelled?.phase, 'cancelled')
    assert.equal(await digest(first), firstHash)

    try {
      const linked = path.join(folder, 'linked.wav')
      await symlink(first, linked, 'file')
      const linkId = localImportService.begin([linked], 'files', false)
      const link = await waitReview(linkId)
      assert.equal(link.items[0]?.status, 'unsupported')
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }

    try {
      const cycle = path.join(folder, 'cycle')
      await symlink(folder, cycle, 'junction')
      const cycleId = localImportService.begin([folder], 'folder', true)
      const cycleReview = await waitReview(cycleId)
      assert.equal(cycleReview.phase, 'ready')
      assert.equal(cycleReview.items.find(item => item.filePath === cycle)?.status, 'unsupported')
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }

    const missingId = localImportService.begin([path.join(folder, 'missing')], 'folder', true)
    const missingReview = await waitReview(missingId)
    assert.equal(missingReview.items[0]?.status, 'unreadable')

    const oversizedFolder = path.join(profile, 'over-count-limit')
    await mkdir(oversizedFolder)
    await Promise.all(Array.from({ length: 1_001 }, (_, index) =>
      writeFile(path.join(oversizedFolder, `entry-${index}.txt`), 'x')))
    const limitedId = localImportService.begin([oversizedFolder], 'folder', false)
    const limited = await waitReview(limitedId)
    assert.equal(limited.phase, 'error')
    assert.match(limited.error ?? '', /file limit/)
    assert.equal((await localImportService.confirm(limitedId, limited.items.map(item => item.id))).phase, 'error')

    console.log(JSON.stringify({ ok: true, imported: imported.length + 2, queued: seenQueue.flat().length,
      originalsUnchanged: true, duplicateReimportSafe: true, partialFailuresVisible: true,
      failedLibraryCommitRecovered: true, analysisAdmissionRetryable: true, scanLimitBlocksConfirmation: true }))
  } finally {
    libraryAnalysis.queue = queue
    await localImportService.shutdown()
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
