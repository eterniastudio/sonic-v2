import { EventEmitter } from 'node:events'
import { isStopping } from '../lifecycle'
import type { AudioAnalysis } from '@shared/analysis'
import { analysisService, type AnalysisProgress } from './service'
import { analysisCache } from './cache'
import { libraryService } from '../services/library'
import { settingsService } from '../services/settings'

/**
 * Connects acoustic analysis to the library.
 *
 * Library analysis works entirely from the file already on disk — no download,
 * no network — so a track captured before analysis existed can be measured
 * offline. Results are rejected if the record was removed or the file changed
 * while the analysis was in flight.
 */
class LibraryAnalysisCoordinator extends EventEmitter {
  /** Beat ids queued behind the concurrency limit. */
  private readonly pending: string[] = []
  private readonly running = new Set<string>()
  private readonly tasks = new Set<Promise<{ ok: boolean; error: string | null; analysis: AudioAnalysis | null }>>()

  constructor() {
    super()
    analysisService.on('progress', (progress: AnalysisProgress) => {
      // The request id encodes the beat, so progress can be routed back to a row.
      const beatId = this.beatIdFromRequest(progress.requestId)
      this.emit('progress', { beatId, jobId: null, phase: progress.phase, message: progress.message })
    })
  }

  private requestIdFor(beatId: string, generation: number): string {
    return `beat:${beatId}:${generation}`
  }

  private beatIdFromRequest(requestId: string): string | null {
    const parts = requestId.split(':')
    return parts[0] === 'beat' && parts.length >= 2 ? parts[1] : null
  }

  isRunning(beatId: string): boolean {
    return this.running.has(beatId)
  }

  get queuedCount(): number {
    return this.pending.length
  }

  /**
   * Analyzes one library track.
   *
   * `force` re-runs even when a cached result exists.
   */
  async analyze(
    beatId: string,
    options: { force?: boolean } = {}
  ): Promise<{ ok: boolean; error: string | null; analysis: AudioAnalysis | null }> {
    const task = this.perform(beatId, options)
    this.tasks.add(task)
    try { return await task } finally { this.tasks.delete(task) }
  }

  async shutdown(): Promise<void> {
    this.cancelAll()
    await Promise.allSettled([...this.tasks])
  }

  private async perform(
    beatId: string,
    options: { force?: boolean }
  ): Promise<{ ok: boolean; error: string | null; analysis: AudioAnalysis | null }> {
    if (isStopping()) return { ok: false, error: 'Sonic is closing.', analysis: null }
    const beat = libraryService.get(beatId)
    if (!beat) return { ok: false, error: 'That beat is no longer in your library.', analysis: null }
    if (beat.missing) {
      return { ok: false, error: 'The audio file for this beat is missing.', analysis: null }
    }
    if (this.running.has(beatId)) {
      return { ok: false, error: 'This beat is already being analyzed.', analysis: null }
    }

    this.running.add(beatId)
    // Removing an entry from `pending` is the caller's job; direct calls are not queued.
    const pendingIndex = this.pending.indexOf(beatId)
    if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1)

    let acoustic: AudioAnalysis | null = null
    try {
      libraryService.setAnalysisStatus(beatId, 'analyzing')
      const outcome = await analysisService.analyze({
        requestId: this.requestIdFor(beatId, Date.now()),
        inputPath: beat.filePath,
        durationSec: beat.durationSec,
        channels: beat.channels ?? undefined,
        force: options.force === true
      })

      if (outcome.cancelled) {
        libraryService.setAnalysisStatus(beatId, 'not-analyzed')
        return { ok: false, error: null, analysis: null }
      }

      if (!outcome.ok || !outcome.analysis) {
        libraryService.markAnalysisFailed(beatId)
        return { ok: false, error: outcome.error ?? 'Analysis failed.', analysis: null }
      }

      // The record may have been deleted while the analysis ran; applyAnalysis
      // returns null in that case rather than resurrecting it.
      acoustic = outcome.analysis
      const applied = await libraryService.applyAnalysis(beatId, outcome.analysis)
      if (!applied) {
        return {
          ok: false,
          error: 'This beat was removed before the analysis finished.',
          analysis: null
        }
      }

      return { ok: true, error: null, analysis: outcome.analysis }
    } catch (error) {
      if (acoustic) return {
        ok: true,
        error: `Audio analysis completed; library update was not committed. Retry saving, then Analyze audio to reuse the cached result: ${String(error)}`,
        analysis: acoustic
      }
      try { libraryService.markAnalysisFailed(beatId) } catch { /* Keep the failed storage revision for explicit retry. */ }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        analysis: null
      }
    } finally {
      this.running.delete(beatId)
      this.drain()
    }
  }

  /** Queues several tracks, running them as capacity allows. */
  queue(beatIds: string[]): number {
    if (isStopping()) return 0
    const fresh = beatIds.filter(
      (id) => !this.running.has(id) && !this.pending.includes(id) && libraryService.get(id) != null
    )
    for (const id of fresh) {
      libraryService.setAnalysisStatus(id, 'queued')
      this.pending.push(id)
    }
    this.drain()
    return fresh.length
  }

  cancel(beatId: string): void {
    const index = this.pending.indexOf(beatId)
    if (index !== -1) {
      this.pending.splice(index, 1)
      libraryService.setAnalysisStatus(beatId, 'not-analyzed')
      return
    }
    if (this.running.has(beatId)) {
      // The request id carries the beat id, so a prefix cancel clears every
      // generation for that beat.
      analysisService.cancelPrefix(`beat:${beatId}:`)
      libraryService.setAnalysisStatus(beatId, 'not-analyzed')
    }
  }

  cancelAll(): void {
    for (const id of this.pending) {
      try { libraryService.setAnalysisStatus(id, 'not-analyzed') } catch { /* Pending storage error remains visible and retryable. */ }
    }
    this.pending.length = 0
    analysisService.cancelAll()
  }

  /** Starts as many queued analyses as the configured concurrency allows. */
  private drain(): void {
    if (isStopping()) return
    const limit = Math.max(1, settingsService.get().analysisConcurrency)
    while (this.running.size < limit && this.pending.length > 0) {
      const beatId = this.pending.shift()
      if (!beatId) break
      if (this.running.has(beatId)) continue
      void this.analyze(beatId).catch(error => this.emit('storage-error', String(error)))
    }
  }

  status(): {
    engine: string
    cacheEntries: number
    running: number
    queued: number
    concurrency: number
    enabled: boolean
  } {
    return {
      engine: analysisService.engine,
      cacheEntries: analysisCache.size(),
      running: this.running.size,
      queued: this.pending.length,
      concurrency: settingsService.get().analysisConcurrency,
      enabled: settingsService.get().analyzeOnDownload
    }
  }

  clearCache(): number {
    const size = analysisCache.size()
    analysisCache.clear()
    return size
  }
}

export const libraryAnalysis = new LibraryAnalysisCoordinator()
