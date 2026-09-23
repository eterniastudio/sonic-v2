import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile, unlink, rename, lstat, link, open } from 'node:fs/promises'
import path from 'node:path'
import type {
  AnalysisStatus,
  AudioAnalysis
} from '@shared/analysis'
import { analyzedValuesFrom, deriveAnalysisStatus } from '@shared/analysis'
import type { BeatMetadata, BeatSidecar, LibraryBeat, MetadataField, MetadataValues, MetadataVerification, PresetId, SourceKind, SourceValues } from '@shared/domain'
import { reconcile, BPM_MIN, BPM_MAX } from '@shared/metadata'
import { parseKeyString } from '@shared/music'
import { renderExportStem, resolveCollision } from '@shared/template'
import { buildAudioEvidence } from '@shared/metadata'
import { verifyMetadata } from '@shared/verification'
import { JsonStore, storageDiagnostic } from '../lib/jsonStore'
import { fileExists, fileSize, pathExists, sha256File } from '../lib/fsx'
import { libraryFile } from './paths'
import { settingsService } from './settings'
import { isStopping } from '../lifecycle'

/** Fields a manual library edit can address, and therefore can override. */
const FIELD_KEYS = new Set<string>([
  'title',
  'producer',
  'bpm',
  'altBpm',
  'key',
  'camelot',
  'detune',
  'tuning',
  'genre'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Defensive read: a hand-edited or older library file must not crash the app. */
function normalizeLibrary(raw: unknown): LibraryBeat[] {
  if (!Array.isArray(raw)) throw new Error('Invalid library: expected an array of records.')
  const out: LibraryBeat[] = []

  for (const entry of raw) {
    if (!isRecord(entry)) throw new Error('Invalid library record: expected an object.')
    const filePath = typeof entry.filePath === 'string' ? entry.filePath : null
    if (!filePath) throw new Error('Invalid library record: missing filePath.')

    let restoredChannel = typeof entry.sourceChannel === 'string' ? entry.sourceChannel : null
    if (!restoredChannel && typeof entry.sidecarPath === 'string') {
      try {
        const sidecar = JSON.parse(readFileSync(entry.sidecarPath, 'utf8')) as BeatSidecar
        if (typeof entry.fingerprint === 'string' && entry.fingerprint && sidecar.schema === 'sonic-v2/beat' && sidecar.output?.filePath === path.basename(filePath) &&
          sidecar.output?.fingerprint === entry.fingerprint && sidecar.source?.url === entry.sourceUrl) {
          restoredChannel = sidecar.source.channel?.trim() || sidecar.source.uploader?.trim() || null
        }
      } catch { /* An absent or damaged optional sidecar cannot erase a library record. */ }
    }
    out.push({
      id: typeof entry.id === 'string' ? entry.id : path.basename(filePath),
      title: typeof entry.title === 'string' ? entry.title : path.parse(filePath).name,
      producer: typeof entry.producer === 'string' ? entry.producer : null,
      bpm: typeof entry.bpm === 'number' ? entry.bpm : null,
      altBpm: typeof entry.altBpm === 'number' ? entry.altBpm : null,
      key: typeof entry.key === 'string' ? entry.key : null,
      camelot: typeof entry.camelot === 'string' ? entry.camelot : null,
      detune: typeof entry.detune === 'number' ? entry.detune : null,
      presetId: (typeof entry.presetId === 'string' ? entry.presetId : 'mp3-320') as PresetId,
      format: typeof entry.format === 'string' ? entry.format : path.extname(filePath).replace('.', ''),
      filePath,
      fileName: typeof entry.fileName === 'string' ? entry.fileName : path.basename(filePath),
      sidecarPath: typeof entry.sidecarPath === 'string' ? entry.sidecarPath : null,
      sidecarSync: isRecord(entry.sidecarSync) && ['pending', 'synced', 'error'].includes(String(entry.sidecarSync.status))
        ? entry.sidecarSync as LibraryBeat['sidecarSync'] : undefined,
      sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : 0,
      durationSec: typeof entry.durationSec === 'number' ? entry.durationSec : 0,
      bitrateKbps: typeof entry.bitrateKbps === 'number' ? entry.bitrateKbps : null,
      sampleRate: typeof entry.sampleRate === 'number' ? entry.sampleRate : null,
      channels: typeof entry.channels === 'number' ? entry.channels : null,
      sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : null,
      sourceChannel: restoredChannel,
      namingTemplate: typeof entry.namingTemplate === 'string' ? entry.namingTemplate : null,
      namingIndex: typeof entry.namingIndex === 'number' ? entry.namingIndex : null,
      sourceKind: (typeof entry.sourceKind === 'string' ? entry.sourceKind : 'unknown') as SourceKind,
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
      fingerprint: typeof entry.fingerprint === 'string' ? entry.fingerprint : '',
      missing: entry.missing === true,
      // Records written before analysis existed simply have no analysis, and no
      // knowledge of which fields were hand-edited is invented for them. Analysis
      // only ever fills empty fields, so nothing is lost by defaulting to none.
      analysisStatus: (entry.analysisStatus === 'queued' || entry.analysisStatus === 'analyzing'
        ? (entry.analysis ? deriveAnalysisStatus((entry.analysis as AudioAnalysis).tempo, (entry.analysis as AudioAnalysis).key) : 'not-analyzed')
        : typeof entry.analysisStatus === 'string'
        ? entry.analysisStatus
        : 'not-analyzed') as AnalysisStatus,
      analysis: (entry.analysis as AudioAnalysis | null | undefined) ?? null,
      overrides: Array.isArray(entry.overrides)
        ? (entry.overrides.filter((value) => typeof value === 'string') as MetadataField[])
        : [],
      // Records written before analysis existed have no per-source provenance.
      // Leaving it empty is honest: verification simply reports "unverified"
      // rather than inventing what the source once said.
      sources: normalizeSources(entry.sources),
      embedded: (entry.embedded as MetadataValues | undefined) ?? {},
      verification: (entry.verification as MetadataVerification | null | undefined) ?? null
    })
  }

  return out
}

const EMPTY_SOURCES: SourceValues = { title: {}, description: {}, filename: {} }

function normalizeSources(raw: unknown): SourceValues {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SOURCES
  const candidate = raw as Partial<SourceValues>
  return {
    title: (candidate.title as MetadataValues | undefined) ?? {},
    description: (candidate.description as MetadataValues | undefined) ?? {},
    filename: (candidate.filename as MetadataValues | undefined) ?? {}
  }
}

/** Rebuilds the declared-vs-measured cross-check for a stored record. */
function recomputeVerification(beat: LibraryBeat): MetadataVerification | null {
  const final = {
    title: beat.title,
    producer: beat.producer,
    bpm: beat.bpm,
    altBpm: beat.altBpm,
    key: beat.key,
    camelot: beat.camelot,
    detune: beat.detune,
    tuning: null,
    genre: null
  }

  return verifyMetadata({
    sources: beat.sources,
    embedded: beat.embedded,
    analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {},
    analysis: beat.analysis,
    final,
    overrides: beat.overrides
  })
}

/**
 * Re-normalises a record's key/Camelot pair through the same shared rules the
 * inspector uses, so a library record can never hold a Camelot code belonging to
 * a different key.
 */
function reconcileBeat(beat: LibraryBeat, overrides: MetadataField[]): LibraryBeat {
  const current = {
    title: beat.title,
    producer: beat.producer,
    bpm: beat.bpm,
    altBpm: beat.altBpm,
    key: beat.key,
    camelot: beat.camelot,
    detune: beat.detune
  }

  const { final } = reconcile({
    declared: current,
    overrides,
    previousFinal: current
  })

  return {
    ...beat,
    title: final.title,
    producer: final.producer,
    bpm: final.bpm,
    altBpm: final.altBpm,
    key: final.key,
    camelot: final.camelot,
    detune: final.detune
  }
}

export interface DeleteResult {
  ok: boolean
  reason: string | null
}

class LibraryService extends EventEmitter {
  private store = new JsonStore<LibraryBeat[]>(libraryFile(), [], normalizeLibrary)
  private rescanTimer: NodeJS.Timeout | null = null
  private stopped = false
  private readonly sidecarTasks = new Map<string, Promise<void>>()
  private readonly scanTasks = new Set<Promise<LibraryBeat[]>>()
  private readonly deleting = new Set<string>()
  private readonly beatMutations = new Map<string, Promise<unknown>>()

  private withBeatMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.beatMutations.get(id) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(operation)
    this.beatMutations.set(id, task)
    void task.finally(() => { if (this.beatMutations.get(id) === task) this.beatMutations.delete(id) }).catch(() => undefined)
    return task
  }

  list(): LibraryBeat[] {
    // Newest first is the only sensible default for a download library.
    return [...this.store.read()].sort((a, b) => b.addedAt - a.addedAt)
  }

  get(id: string): LibraryBeat | null {
    return this.store.read().find((beat) => beat.id === id) ?? null
  }

  add(beat: LibraryBeat): LibraryBeat[] {
    const next = [beat, ...this.store.read().filter((entry) => entry.id !== beat.id)]
    this.store.write(next)
    this.emitChanged()
    return this.list()
  }

  update(id: string, patch: Partial<LibraryBeat>): LibraryBeat | null {
    let updated: LibraryBeat | null = null
    const next = this.store.read().map((entry) => {
      if (entry.id !== id) return entry
      updated = { ...entry, ...patch }
      return updated
    })
    if (updated) {
      this.store.write(next)
      this.emitChanged()
    }
    return updated
  }

  /**
   * Removes a library record.
   *
   * When `deleteFiles` is set, the audio and its sidecar are only unlinked after
   * the file on disk is re-hashed and matches the fingerprint recorded at export
   * time. A file that was replaced or edited outside Sonic is left alone.
   */
  async remove(id: string, deleteFiles: boolean): Promise<DeleteResult & { library: LibraryBeat[] }> {
    if (this.stopped || this.deleting.has(id)) return { ok: false, reason: 'This record is closing or already being deleted.', library: this.list() }
    this.deleting.add(id)
    const removed: string[] = []
    try {
      await this.beatMutations.get(id)?.catch(() => undefined)
      const sidecarPath = this.get(id)?.sidecarPath
      if (sidecarPath) await this.sidecarTasks.get(path.resolve(sidecarPath).toLowerCase())
      return await this.removeVerified(id, deleteFiles, removed)
    } catch (error) {
      const reason = removed.length
        ? `${removed.join(' and ')} removed, but deletion did not finish: ${String(error)}. The library record is retained for recovery.`
        : `Deletion did not finish; no files were removed: ${String(error)}`
      storageDiagnostic(libraryFile(), { operation: 'library-delete-incomplete', id, removed, error: reason })
      if (removed.length && this.get(id)) {
        try { this.update(id, { missing: removed.includes('Audio'), sidecarSync: { status: 'error', error: reason } }) }
        catch (storageError) { this.emit('storage-error', String(storageError)) }
      }
      return { ok: false, reason, library: this.list() }
    } finally { this.deleting.delete(id) }
  }

  private async removeVerified(id: string, deleteFiles: boolean, removed: string[]): Promise<DeleteResult & { library: LibraryBeat[] }> {
    const beat = this.get(id)
    if (!beat) return { ok: false, reason: 'That record is no longer in the library.', library: this.list() }

    if (deleteFiles) {
      // Validate every owned artefact before removing either one.
      if (!beat.fingerprint) return { ok: false, reason: 'This record has no ownership fingerprint. Remove the record while keeping the files.', library: this.list() }
      if (beat.sidecarPath && await fileExists(beat.sidecarPath)) {
        const info = await lstat(beat.sidecarPath)
        const sidecar = JSON.parse(await readFile(beat.sidecarPath, 'utf8')) as BeatSidecar
        if (info.isSymbolicLink() || sidecar.schema !== 'sonic-v2/beat' || sidecar.output.filePath !== beat.fileName || sidecar.output.fingerprint !== beat.fingerprint) {
          return { ok: false, reason: 'The sidecar no longer belongs to this export. Files were left untouched.', library: this.list() }
        }
      }
      const stillThere = await fileExists(beat.filePath)
      if (stillThere) {
        if (beat.fingerprint) {
          const current = await sha256File(beat.filePath)
          if (current !== beat.fingerprint) {
            return {
              ok: false,
              reason: 'This file changed on disk since Sonic exported it, so it was left untouched.',
              library: this.list()
            }
          }
        }
        if ((await lstat(beat.filePath)).isSymbolicLink()) throw new Error('Refusing to delete a linked audio file.')
        if (this.get(id) !== beat) throw new Error('The record changed during verification. Review it and try again.')
        await unlink(beat.filePath)
        removed.push('Audio')
      }

      if (beat.sidecarPath && (await fileExists(beat.sidecarPath))) {
        await unlink(beat.sidecarPath)
        removed.push('Sidecar')
      }
    }

    this.store.write(this.store.read().filter((entry) => entry.id !== id))
    this.emitChanged()
    return { ok: true, reason: null, library: this.list() }
  }

  /** Drops records whose audio is gone, unless they are being kept as missing. */
  purgeMissing(): Promise<LibraryBeat[]> {
    if (this.stopped) return Promise.resolve(this.list())
    return this.trackScan(async () => {
      const missing = new Set<LibraryBeat>()
      for (const beat of this.store.read()) {
        if (!await pathExists(beat.filePath)) missing.add(beat)
      }
      // A rescan must never overwrite metadata committed while stat was awaiting.
      const current = this.store.read()
      const kept = current.filter(beat => !missing.has(beat))
      if (kept.length !== current.length) { this.store.write(kept); this.emitChanged() }
      return this.list()
    })
  }

  /** Re-checks every record against the filesystem and refreshes sizes. */
  rescan(): Promise<LibraryBeat[]> {
    if (this.stopped) return Promise.resolve(this.list())
    return this.trackScan(async () => {
      const observations = new Map<string, { path: string; fingerprint: string; missing: boolean; size: number }>()
      for (const beat of this.store.read()) {
        const exists = await fileExists(beat.filePath)
        observations.set(beat.id, { path: beat.filePath, fingerprint: beat.fingerprint,
          missing: !exists, size: exists ? await fileSize(beat.filePath) : beat.sizeBytes })
      }
      let changed = false
      const next = this.store.read().map(beat => {
        const seen = observations.get(beat.id)
        if (!seen || seen.path !== beat.filePath || seen.fingerprint !== beat.fingerprint) return beat
        const sizeBytes = seen.size > 0 ? seen.size : beat.sizeBytes
        if (seen.missing === beat.missing && sizeBytes === beat.sizeBytes) return beat
        changed = true
        return { ...beat, missing: seen.missing, sizeBytes }
      })
      if (changed) { this.store.write(next); this.emitChanged() }
      return this.list()
    })
  }

  private trackScan(operation: () => Promise<LibraryBeat[]>): Promise<LibraryBeat[]> {
    const task = operation()
    this.scanTasks.add(task)
    void task.then(() => this.scanTasks.delete(task), () => this.scanTasks.delete(task))
    return task
  }

  /**
   * Corrects a library record's musical metadata by hand.
   *
   * Exactly the fields named in `patch` become manual overrides. Fields listed
   * in `clearOverrides` are handed back to the evidence layers — reset to what
   * the audio analysis proposed, or to nothing when there is no analysis.
   */
  async updateMetadata(
    id: string,
    patch: Partial<BeatMetadata>,
    clearOverrides: MetadataField[] = []
  ): Promise<LibraryBeat[]> {
    const sidecarPath = await this.withBeatMutation(id, () => this.updateMetadataLocked(id, patch, clearOverrides))
    if (sidecarPath) await this.synchronizeSidecar(id, sidecarPath)
    return this.list()
  }

  private async updateMetadataLocked(
    id: string,
    patch: Partial<BeatMetadata>,
    clearOverrides: MetadataField[]
  ): Promise<string | null> {
    if (this.stopped || this.deleting.has(id)) throw new Error('This record is closing or being deleted.')
    patch = { ...patch }
    for (const field of ['bpm', 'altBpm'] as const) {
      const value = patch[field]
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value < BPM_MIN || value > BPM_MAX)) {
        throw new Error(`BPM must be between ${BPM_MIN} and ${BPM_MAX}.`)
      }
    }
    if (patch.key !== undefined) {
      const parsed = patch.key ? parseKeyString(patch.key) : null
      if (patch.key && !parsed) throw new Error('Enter a valid musical key.')
      patch.key = parsed?.key ?? null
      patch.camelot = parsed?.camelot ?? null
    }
    const beat = this.get(id)
    if (!beat) return null

    const patched: LibraryBeat = {
      ...beat,
      title: patch.title ?? beat.title,
      producer: patch.producer !== undefined ? patch.producer : beat.producer,
      bpm: patch.bpm !== undefined ? patch.bpm : beat.bpm,
      altBpm: patch.altBpm !== undefined ? patch.altBpm : beat.altBpm,
      key: patch.key !== undefined ? patch.key : beat.key,
      camelot: patch.camelot !== undefined ? patch.camelot : beat.camelot,
      detune: patch.detune !== undefined ? patch.detune : beat.detune
    }

    const edited = Object.keys(patch).filter((key): key is MetadataField => FIELD_KEYS.has(key) && !(key === 'camelot' && patch.key !== undefined))
    let overrides = [...new Set([...beat.overrides.filter(field => !(patch.key !== undefined && field === 'camelot')), ...edited])]
    if (clearOverrides.includes('key') && !clearOverrides.includes('camelot')) clearOverrides = [...clearOverrides, 'camelot']

    if (clearOverrides.length > 0) {
      overrides = overrides.filter((field) => !clearOverrides.includes(field))

      // Put the analysed value back, so "reset" means "trust the audio again"
      // rather than "blank the field".
      const proposed = beat.analysis ? analyzedValuesFrom(beat.analysis) : null
      for (const field of clearOverrides) {
        if (field === 'bpm') patched.bpm = proposed?.bpm ?? null
        if (field === 'altBpm') patched.altBpm = proposed?.altBpm ?? null
        if (field === 'key') patched.key = proposed?.key ?? null
        if (field === 'camelot') patched.camelot = proposed?.camelot ?? null
      }
    }

    const reconciled = reconcileBeat(patched, overrides)
    const updated: LibraryBeat = { ...reconciled, overrides,
      sidecarSync: beat.sidecarPath ? { status: 'pending', error: null } : undefined }
    updated.verification = recomputeVerification(updated)

    await this.commitBeatWithName(beat, updated)

    this.emitChanged()
    return updated.sidecarPath
  }

  /** Marks a record as queued/analyzing so the UI can show progress. */
  setAnalysisStatus(id: string, status: AnalysisStatus): void {
    let changed = false
    const next = this.store.read().map((entry) => {
      if (entry.id !== id || entry.analysisStatus === status) return entry
      changed = true
      return { ...entry, analysisStatus: status }
    })
    if (changed) {
      this.store.write(next)
      this.emitChanged()
    }
  }

  /**
   * Folds a completed analysis into a record.
   *
   * Fills empty fields only. An existing value — whether declared in the title,
   * read from a tag, or set by hand — is never overwritten by an estimate; the
   * producer promotes the detected value explicitly instead.
   */
  async applyAnalysis(id: string, analysis: AudioAnalysis): Promise<LibraryBeat | null> {
    const result = await this.withBeatMutation(id, () => this.applyAnalysisLocked(id, analysis))
    if (!result) return null
    if (result.sidecarPath) await this.synchronizeSidecar(id, result.sidecarPath)
    return this.get(id)
  }

  private async applyAnalysisLocked(id: string, analysis: AudioAnalysis): Promise<{ sidecarPath: string | null } | null> {
    if (this.stopped || this.deleting.has(id)) return null
    let beat = this.get(id)
    if (!beat) return null
    const filePath = beat.filePath
    const hash = await sha256File(filePath)
    beat = this.get(id)
    if (!beat || this.deleting.has(id) || beat.filePath !== filePath || hash !== analysis.inputId) return null

    const proposed = analyzedValuesFrom(analysis)
    const overrides = beat.overrides
    const keep = <T>(field: MetadataField, current: T | null, next: T | null): T | null =>
      overrides.includes(field) || current != null ? current : next

    const merged: LibraryBeat = {
      ...beat,
      bpm: keep('bpm', beat.bpm, proposed.bpm),
      altBpm: keep('altBpm', beat.altBpm, proposed.altBpm),
      key: keep('key', beat.key, proposed.key),
      camelot: keep('camelot', beat.camelot, proposed.camelot),
      analysis,
      analysisStatus: deriveAnalysisStatus(analysis.tempo, analysis.key)
    }

    const updated = reconcileBeat(merged, overrides)
    updated.sidecarSync = updated.sidecarPath ? { status: 'pending', error: null } : undefined
    updated.verification = recomputeVerification(updated)
    await this.commitBeatWithName(beat, updated)

    this.emitChanged()
    return { sidecarPath: updated.sidecarPath }
  }

  /** Records that an analysis attempt failed, so the UI can offer a retry. */
  markAnalysisFailed(id: string): void {
    let changed = false
    const next = this.store.read().map((entry) => {
      if (entry.id !== id || entry.analysisStatus === 'failed') return entry
      changed = true
      return { ...entry, analysisStatus: 'failed' as AnalysisStatus }
    })
    if (changed) {
      this.store.write(next)
      this.emitChanged()
    }
  }

  /** Tracks that still need an analysis run. */
  listNeedingAnalysis(): LibraryBeat[] {
    return this.list().filter(
      (beat) =>
        !beat.missing &&
        (beat.analysisStatus === 'not-analyzed' || beat.analysisStatus === 'failed')
    )
  }

  /** Retry the optional output only; the saved acoustic result remains authoritative. */
  async retrySidecar(id: string): Promise<LibraryBeat[]> {
    if (this.stopped || this.deleting.has(id)) throw new Error('This record is closing or being deleted.')
    const beat = this.get(id)
    if (beat?.sidecarPath) {
      this.update(id, { sidecarSync: { status: 'pending', error: null } })
      await this.synchronizeSidecar(id, beat.sidecarPath)
    }
    return this.list()
  }

  /** Commit a new basename without ever replacing someone else's export. */
  private async commitBeatWithName(previous: LibraryBeat, updated: LibraryBeat): Promise<void> {
    const template = previous.namingTemplate || settingsService.get().namingTemplate
    const desiredStem = renderExportStem(template, {
      metadata: { title: updated.title, producer: updated.producer || updated.sourceChannel || null,
        bpm: updated.bpm, altBpm: updated.altBpm, key: updated.key, camelot: updated.camelot,
        detune: updated.detune, tuning: null, genre: null },
      presetId: updated.presetId, sourceKind: updated.sourceKind, durationSec: updated.durationSec,
      date: new Date(updated.addedAt), index: updated.namingIndex ?? undefined
    })
    const extension = path.extname(previous.fileName)
    const currentStem = path.parse(previous.fileName).name.replace(/ \(\d+\)$/, '')
    if (desiredStem === currentStem || previous.missing) {
      this.store.write(this.store.read().map(entry => entry.id === updated.id ? updated : entry))
      return
    }
    if (!previous.fingerprint || (await sha256File(previous.filePath)) !== previous.fingerprint ||
      (await lstat(previous.filePath)).isSymbolicLink()) throw new Error('The audio file changed on disk; its name was left untouched.')
    let parsed: BeatSidecar | null = null
    if (previous.sidecarPath) {
      try {
        const info = await lstat(previous.sidecarPath)
        parsed = JSON.parse(await readFile(previous.sidecarPath, 'utf8')) as BeatSidecar
        if (!info.isFile() || info.isSymbolicLink() || parsed.schema !== 'sonic-v2/beat' ||
          !parsed.naming || !parsed.metadata ||
          parsed.output.filePath !== previous.fileName || parsed.output.fingerprint !== previous.fingerprint) {
          throw new Error('The sidecar changed on disk.')
        }
      } catch (error) {
        // The library correction is authoritative. An optional, damaged sidecar
        // must not make a user's change disappear; sync will report the error.
        storageDiagnostic(libraryFile(), { operation: 'rename-deferred-sidecar', id: previous.id, error: String(error) })
        this.store.write(this.store.read().map(entry => entry.id === updated.id ? updated : entry))
        return
      }
    }
    const directory = path.dirname(previous.filePath)
    const candidate = resolveCollision(`${desiredStem}${extension}`, name => {
      if (name === previous.fileName) return false
      return existsSync(path.join(directory, name)) || Boolean(previous.sidecarPath && existsSync(path.join(path.dirname(previous.sidecarPath), `${name}.sonic.json`)))
    })
    const nextAudio = path.join(directory, candidate)
    const nextSidecar = previous.sidecarPath ? path.join(path.dirname(previous.sidecarPath), `${candidate}.sonic.json`) : null
    let linked = false
    let createdSidecar = false
    let committed = false
    try {
      await link(previous.filePath, nextAudio)
      linked = true
      if (parsed && nextSidecar) {
        parsed.naming.fileName = candidate
        parsed.output.filePath = candidate
        parsed.metadata = { ...parsed.metadata, title: updated.title, producer: updated.producer,
          bpm: updated.bpm, altBpm: updated.altBpm, key: updated.key, camelot: updated.camelot, detune: updated.detune }
        const output = await open(nextSidecar, 'wx')
        createdSidecar = true
        try { await output.writeFile(JSON.stringify(parsed, null, 2), 'utf8'); await output.sync() }
        finally { await output.close() }
      }
      updated.filePath = nextAudio
      updated.fileName = candidate
      updated.sidecarPath = nextSidecar
      updated.namingTemplate = template
      this.store.write(this.store.read().map(entry => entry.id === updated.id ? updated : entry))
      committed = true
    } catch (error) {
      if (!committed) {
        if (createdSidecar && nextSidecar) await unlink(nextSidecar).catch(() => undefined)
        if (linked) await unlink(nextAudio).catch(() => undefined)
      }
      throw error
    }
    for (const oldPath of [previous.sidecarPath, previous.filePath]) {
      if (!oldPath) continue
      try { await unlink(oldPath) }
      catch (error) { storageDiagnostic(libraryFile(), { operation: 'rename-old-file-cleanup', id: previous.id, oldPath, error: String(error) }) }
    }
  }

  /** Serialize the entire read/merge/replace, using fresh authoritative state. */
  private synchronizeSidecar(id: string, sidecarPath: string): Promise<void> {
    const key = path.resolve(sidecarPath).toLowerCase()
    const previous = this.sidecarTasks.get(key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      let temporary: string | null = null
      let beat: LibraryBeat | null = null
      let stage = 'inspect'
      try {
        const info = await lstat(sidecarPath)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Sidecar is not a regular owned file.')
        stage = 'read'
        const parsed = JSON.parse(await readFile(sidecarPath, 'utf8')) as BeatSidecar
        beat = this.get(id)
        if (!beat || beat.sidecarPath !== sidecarPath || this.deleting.has(id)) return
        stage = 'validate'
        if (parsed.schema !== 'sonic-v2/beat' || parsed.output?.filePath !== beat.fileName || parsed.output?.fingerprint !== beat.fingerprint) {
          throw new Error('The sidecar no longer belongs to this export.')
        }
        parsed.schemaVersion = 2
        parsed.metadata = { ...parsed.metadata, title: beat.title, producer: beat.producer,
          bpm: beat.bpm, altBpm: beat.altBpm, key: beat.key, camelot: beat.camelot, detune: beat.detune }
        parsed.analysis = beat.analysis
        parsed.audioEvidence = beat.analysis ? buildAudioEvidence(beat.analysis) : []
        parsed.verification = beat.verification
        parsed.overrides = [...beat.overrides]
        parsed.sources = beat.sources
        parsed.embedded = beat.embedded
        if (parsed.source) parsed.source.channel = beat.sourceChannel ?? null
        temporary = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`
        stage = 'write'
        await writeFile(temporary, JSON.stringify(parsed, null, 2), { encoding: 'utf8', flag: 'wx' })
        stage = 'replace'
        await rename(temporary, sidecarPath)
        stage = 'save-sync-status'
        if (JSON.stringify(this.get(id)) === JSON.stringify(beat)) this.update(id, { sidecarSync: { status: 'synced', error: null } })
      } catch (error) {
        const current = this.get(id)
        const message = `Library saved; sidecar synchronization failed: ${String(error)}`
        storageDiagnostic(libraryFile(), { operation: 'sidecar-synchronization', stage, id, sidecarPath, temporary,
          temporaryExists: temporary ? existsSync(temporary) : false, destinationExists: existsSync(sidecarPath), directoryExists: existsSync(path.dirname(sidecarPath)),
          analysisAt: current?.analysis?.analyzedAt, error: String(error), stack: error instanceof Error ? error.stack : null })
        if (current?.sidecarPath === sidecarPath && (!beat || JSON.stringify(current) === JSON.stringify(beat))) {
          try { this.update(id, { sidecarSync: { status: 'error', error: message } }) }
          catch (storageError) { this.emit('storage-error', String(storageError)) }
        }
        this.emit('storage-error', message)
      } finally {
        if (temporary) {
          try { await unlink(temporary) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('storage-error', `Owned temporary cleanup failed: ${String(error)}`)
          }
        }
      }
    })
    this.sidecarTasks.set(key, task)
    void task.finally(() => { if (this.sidecarTasks.get(key) === task) this.sidecarTasks.delete(key) })
    return task
  }

  /** Starts a periodic background rescan so deleted files show up on their own. */
  scheduleRescan(intervalMs: number): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer)
      this.rescanTimer = null
    }
    if (intervalMs <= 0 || this.stopped || isStopping()) return
    this.rescanTimer = setInterval(() => {
      void this.rescan().catch(error => this.emit('storage-error', String(error)))
    }, intervalMs)
    this.rescanTimer.unref?.()
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.scheduleRescan(0)
    await Promise.allSettled([...this.scanTasks, ...this.sidecarTasks.values(), ...this.beatMutations.values()])
  }

  private emitChanged(): void {
    this.emit('changed', this.list())
  }
}

export const libraryService = new LibraryService()
