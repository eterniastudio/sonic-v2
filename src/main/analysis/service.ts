import { EventEmitter } from 'node:events'
import { isStopping } from '../lifecycle'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AudioAnalysis } from '@shared/analysis'
import { ANALYSIS_ENGINE } from '@shared/analysis'
import { ensureDir, removeFile } from '../lib/fsx'
import { analysisDir } from '../services/paths'
import { engineService } from '../services/engine'
import { settingsService } from '../services/settings'
import { analysisCache } from './cache'
import { decodeWindow, planWindows } from './decode'
import { probeMediaFile } from '../services/ffprobe'
import { assembleAnalysis } from './merge'
import type { AnalysisWorkerJob, AnalysisWorkerReply, AnalysisWorkerWindow } from './protocol'

export interface AnalyzeRequest {
  /**
   * Caller-owned identity (job id, or library id plus a generation counter).
   * Used for cancellation and to reject results that arrive after the caller
   * has moved on.
   */
  requestId: string
  inputPath: string
  /** Duration from ffprobe. 0 when unknown; window planning then falls back. */
  durationSec: number
  channels?: number
  /** Ignore a cached result and analyse again. */
  force?: boolean
}

export interface AnalyzeOutcome {
  ok: boolean
  analysis: AudioAnalysis | null
  fromCache: boolean
  cancelled: boolean
  error: string | null
  elapsedMs: number
}

export interface AnalysisProgress {
  requestId: string
  phase: 'starting' | 'decoding' | 'analyzing' | 'done' | 'failed' | 'cancelled'
  message: string
}

/** Hard ceiling for one analysis, including decode. */
const ANALYSIS_TIMEOUT_MS = 180_000

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

/** Streaming SHA-256 — the analysis-cache identity, not the export fingerprint. */
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Orchestrates audio analysis.
 *
 * Owns the process boundaries: ffmpeg decodes on a child process, the DSP runs
 * on a worker thread, and the main process only ever coordinates. Concurrency is
 * bounded, every wait is cancellable, and all scratch files are removed on every
 * exit path — including cancellation and failure.
 */
class AnalysisService extends EventEmitter {
  private active = 0
  private waiting: (() => void)[] = []
  private readonly inFlight = new Map<
    string,
    { worker: Worker | null; controller: AbortController }
  >()
  private readonly requests = new Set<string>()
  private readonly cancelled = new Set<string>()
  private readonly tasks = new Set<Promise<AnalyzeOutcome>>()

  /** True while this request id is being worked on. */
  isRunning(requestId: string): boolean {
    return this.inFlight.has(requestId)
  }

  /** Analyzer identity, surfaced through diagnostics. */
  get engine(): string {
    return ANALYSIS_ENGINE
  }

  /**
   * Cancels every in-flight request whose id starts with `prefix`.
   *
   * Request ids are namespaced (`beat:<id>:<generation>`), so this lets a caller
   * cancel a logical target without tracking each generation it started.
   */
  cancelPrefix(prefix: string): void {
    for (const requestId of [...this.requests]) {
      if (requestId.startsWith(prefix)) this.cancel(requestId)
    }
  }

  /** Analyses an audio file. Resolves; never throws for expected failures. */
  async analyze(request: AnalyzeRequest): Promise<AnalyzeOutcome> {
    if (isStopping()) return this.cancelledOutcome(Date.now())
    this.requests.add(request.requestId)
    this.cancelled.delete(request.requestId)
    const task = this.perform(request)
    this.tasks.add(task)
    try { return await task }
    finally { this.tasks.delete(task); this.requests.delete(request.requestId); this.cancelled.delete(request.requestId) }
  }

  private async perform(request: AnalyzeRequest): Promise<AnalyzeOutcome> {
    const started = Date.now()

    const ffmpeg = await engineService.resolve('ffmpeg')
    if (!ffmpeg.path) {
      return {
        ok: false,
        analysis: null,
        fromCache: false,
        cancelled: false,
        error: 'ffmpeg is not installed, so audio cannot be decoded for analysis.',
        elapsedMs: Date.now() - started
      }
    }

    // If the caller does not know how long the file is, measure it.
    //
    // Window planning needs a real duration: assuming one would analyse a few
    // seconds of a three-minute track and report "inconclusive" for material
    // that is perfectly analysable. This was a live defect — a 133 s beat was
    // being judged on 6 s of audio.
    let durationSec = request.durationSec
    if (!(durationSec > 0)) {
      try {
        const info = await probeMediaFile(request.inputPath)
        durationSec = info.durationSec
      } catch {
        // Leave it unknown; the window planner handles that case generously.
        durationSec = 0
      }
    }

    let inputId: string
    try {
      inputId = await hashFile(request.inputPath)
    } catch {
      return {
        ok: false,
        analysis: null,
        fromCache: false,
        cancelled: false,
        error: 'The audio file could not be read for analysis.',
        elapsedMs: Date.now() - started
      }
    }

    if (this.cancelled.has(request.requestId)) return this.cancelledOutcome(started)

    if (!request.force) {
      const cached = analysisCache.get(inputId)
      if (cached) {
        this.emitProgress(request.requestId, 'done', 'Loaded a cached analysis.')
        return {
          ok: true,
          analysis: cached,
          fromCache: true,
          cancelled: false,
          error: null,
          elapsedMs: Date.now() - started
        }
      }
    }

    await this.acquire()

    if (this.cancelled.has(request.requestId)) {
      this.release()
      return this.cancelledOutcome(started)
    }

    const controller = new AbortController()
    this.inFlight.set(request.requestId, { worker: null, controller })

    const workDir = analysisDir()
    const scratch: string[] = []

    try {
      this.emitProgress(request.requestId, 'starting', 'Preparing audio…')

      const plan = planWindows(durationSec)
      await ensureDir(workDir)

      const decodeOne = async (
        window: { offsetSec: number; durationSec: number },
        index: number
      ): Promise<AnalysisWorkerWindow> => {
        const outputPath = path.join(
          workDir,
          `${safeSegment(request.requestId)}_${index}.f32`
        )
        scratch.push(outputPath)

        const decoded = await decodeWindow({
          inputPath: request.inputPath,
          ffmpegPath: ffmpeg.path as string,
          outputPath,
          signal: controller.signal,
          offsetSec: window.offsetSec,
          durationSec: window.durationSec
        })

        return {
          path: decoded.path,
          sampleRate: decoded.sampleRate,
          sourceDurationSec: durationSec > 0 ? durationSec : decoded.durationSec
        }
      }

      this.emitProgress(request.requestId, 'decoding', 'Decoding audio…')
      // Decode branches independently; a bad window does not erase the other branch.
      let tempoWindow: AnalysisWorkerWindow | null = null
      try { tempoWindow = await decodeOne(plan.tempo, 0) } catch (error) {
        if (controller.signal.aborted) throw error
      }

      const keyWindows: AnalysisWorkerWindow[] = []
      for (let index = 0; index < plan.key.length; index += 1) {
        if (this.cancelled.has(request.requestId)) throw new Error('Cancelled')
        try { keyWindows.push(await decodeOne(plan.key[index], index + 1)) } catch (error) {
          if (controller.signal.aborted) throw error
        }
      }

      if (this.cancelled.has(request.requestId)) {
        return this.cancelledOutcome(started)
      }

      this.emitProgress(request.requestId, 'analyzing', 'Analyzing tempo and key…')

      const job: AnalysisWorkerJob = { tempo: tempoWindow, key: keyWindows }
      const reply = await this.runWorker(request.requestId, job, controller)

      if (this.cancelled.has(request.requestId)) {
        return this.cancelledOutcome(started)
      }

      if (!reply.ok || (!reply.tempo && !reply.key)) {
        return {
          ok: false,
          analysis: null,
          fromCache: false,
          cancelled: false,
          error: reply.error ?? 'The analyser did not return a result.',
          elapsedMs: Date.now() - started
        }
      }

      const tempo = reply.tempo ?? {
        status: 'failed' as const,
        bpm: null,
        bpmExact: null,
        alternatives: [],
        confidence: null,
        warning: 'Tempo analysis did not run.'
      }
      const key = reply.key ?? {
        status: 'failed' as const,
        key: null,
        camelot: null,
        alternatives: [],
        confidence: null,
        tuningCents: null,
        warning: 'Key analysis did not run.'
      }

      const analyzedSeconds = plan.tempo.durationSec + plan.key.reduce((total, w) => total + w.durationSec, 0)

      const analysis = assembleAnalysis({
        tempo,
        key,
        inputId,
        inputName: path.basename(request.inputPath),
        analyzedAt: Date.now(),
        sampleRate: tempoWindow?.sampleRate ?? keyWindows[0]?.sampleRate ?? 22050,
        channels: request.channels ?? 0,
        durationSec: durationSec > 0 ? durationSec : tempoWindow?.sourceDurationSec ?? keyWindows[0]?.sourceDurationSec ?? 0,
        analyzedSeconds,
        windowDescription: plan.description
      })

      // A cache failure cannot invalidate a completed acoustic result. JsonStore retains
      // the unsaved cache revision and reports it independently through storage status.
      try { analysisCache.set(inputId, analysis) } catch { /* retryable storage failure */ }
      this.emitProgress(request.requestId, 'done', 'Analysis complete.')

      return {
        ok: true,
        analysis,
        fromCache: false,
        cancelled: false,
        error: null,
        elapsedMs: Date.now() - started
      }
    } catch (error) {
      if (this.cancelled.has(request.requestId) || controller.signal.aborted) {
        return this.cancelledOutcome(started)
      }
      const message = error instanceof Error ? error.message : String(error)
      this.emitProgress(request.requestId, 'failed', message)
      return {
        ok: false,
        analysis: null,
        fromCache: false,
        cancelled: false,
        error: message,
        elapsedMs: Date.now() - started
      }
    } finally {
      // Always remove scratch PCM, and always release the slot.
      for (const file of scratch) await removeFile(file).catch(() => undefined)
      this.inFlight.delete(request.requestId)
      this.release()
    }
  }

  /** Requests cancellation. Safe to call for an unknown or finished request. */
  cancel(requestId: string): void {
    this.cancelled.add(requestId)
    const entry = this.inFlight.get(requestId)
    if (!entry) return

    entry.controller.abort()
    void entry.worker?.terminate()

    // Bound the tombstone so the set cannot grow forever.
    if (this.cancelled.size > 200) {
      const [oldest] = this.cancelled
      this.cancelled.delete(oldest)
    }
  }

  /** Cancels everything; used on app shutdown. */
  cancelAll(): void {
    for (const requestId of [...this.requests]) this.cancel(requestId)
  }

  async shutdown(): Promise<void> {
    this.cancelAll()
    await Promise.allSettled([...this.tasks])
  }

  private cancelledOutcome(started: number): AnalyzeOutcome {
    return {
      ok: false,
      analysis: null,
      fromCache: false,
      cancelled: true,
      error: null,
      elapsedMs: Date.now() - started
    }
  }

  /** Runs the DSP on a worker thread with a hard timeout. */
  private runWorker(
    requestId: string,
    job: AnalysisWorkerJob,
    controller: AbortController
  ): Promise<AnalysisWorkerReply> {
    return new Promise<AnalysisWorkerReply>((resolve) => {
      const workerPath = path.join(__dirname, 'analysisWorker.js')
      let settled = false
      let worker: Worker

      const finish = (reply: AnalysisWorkerReply): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate().then(() => resolve(reply), () => resolve(reply))
      }

      const timer = setTimeout(() => {
        finish({
          ok: false,
          tempo: null,
          key: null,
          error: `Analysis timed out after ${Math.round(ANALYSIS_TIMEOUT_MS / 1000)}s.`,
          elapsedMs: ANALYSIS_TIMEOUT_MS
        })
      }, ANALYSIS_TIMEOUT_MS)

      try {
        worker = new Worker(workerPath, { workerData: job })
      } catch (error) {
        clearTimeout(timer)
        settled = true
        resolve({
          ok: false,
          tempo: null,
          key: null,
          error:
            'The analysis worker could not start: ' +
            (error instanceof Error ? error.message : String(error)),
          elapsedMs: 0
        })
        return
      }

      const entry = this.inFlight.get(requestId)
      if (entry) entry.worker = worker

      worker.on('message', (reply: AnalysisWorkerReply) => finish(reply))
      worker.on('error', (error) => {
        finish({ ok: false, tempo: null, key: null, error: error.message, elapsedMs: 0 })
      })
      worker.on('exit', (code) => {
        if (code !== 0) {
          finish({
            ok: false,
            tempo: null,
            key: null,
            error: `The analysis worker exited with code ${code}.`,
            elapsedMs: 0
          })
        }
      })

      controller.signal.addEventListener('abort', () => {
        finish({ ok: false, tempo: null, key: null, error: 'Cancelled', elapsedMs: 0 })
      })
    })
  }

  private async acquire(): Promise<void> {
    const limit = Math.max(1, settingsService.get().analysisConcurrency)
    while (this.active >= limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    this.waiting.shift()?.()
  }

  private emitProgress(
    requestId: string,
    phase: AnalysisProgress['phase'],
    message: string
  ): void {
    this.emit('progress', { requestId, phase, message } satisfies AnalysisProgress)
  }
}

export const analysisService = new AnalysisService()
export { ANALYSIS_ENGINE }
