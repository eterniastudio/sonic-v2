import { parentPort, workerData } from 'node:worker_threads'
import type { KeyAnalysis, TempoAnalysis } from '@shared/analysis'
import { emptyKeyAnalysis, emptyTempoAnalysis } from '@shared/analysis'
import { readPcmFile } from './decode'
import { estimateKey, estimateTempo } from './dsp'
import { mergeKeyAnalyses } from './merge'

/**
 * Analysis worker entry.
 *
 * Runs on a worker thread so a multi-second STFT pass never blocks the main
 * process — the queue keeps reporting progress and the UI keeps responding while
 * a track is being analysed.
 *
 * Reads only file paths from `workerData`; the PCM itself is read here, off the
 * main thread.
 */

export interface AnalysisWorkerJob {
  tempo: { path: string; sampleRate: number; sourceDurationSec: number } | null
  key: { path: string; sampleRate: number; sourceDurationSec: number }[]
}

export interface AnalysisWorkerReply {
  ok: boolean
  tempo: TempoAnalysis | null
  key: KeyAnalysis | null
  error: string | null
  elapsedMs: number
}

async function run(): Promise<AnalysisWorkerReply> {
  const started = Date.now()
  const job = workerData as AnalysisWorkerJob | undefined

  if (!job) {
    return { ok: false, tempo: null, key: null, error: 'Analysis worker started without a job', elapsedMs: 0 }
  }

  let tempo: TempoAnalysis | null = null
  if (job.tempo) {
    try {
      const pcm = await readPcmFile(job.tempo.path)
      tempo = estimateTempo({ pcm, sampleRate: job.tempo.sampleRate, sourceDurationSec: job.tempo.sourceDurationSec })
    } catch (error) {
      tempo = { ...emptyTempoAnalysis(), status: 'failed', warning: `Tempo input could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const keyResults: KeyAnalysis[] = []
  for (const window of job.key) {
    try {
      const pcm = await readPcmFile(window.path)
      keyResults.push(estimateKey({ pcm, sampleRate: window.sampleRate, sourceDurationSec: window.sourceDurationSec }))
    } catch (error) {
      keyResults.push({ ...emptyKeyAnalysis(), status: 'failed', warning: `Key window input could not be read: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  return {
    ok: true,
    tempo,
    key: keyResults.length > 0 ? mergeKeyAnalyses(keyResults) : null,
    error: null,
    elapsedMs: Date.now() - started
  }
}

const port = parentPort

if (port) {
  run()
    .then((reply) => {
      port.postMessage(reply)
    })
    .catch((error: unknown) => {
      port.postMessage({
        ok: false,
        tempo: null,
        key: null,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: 0
      } satisfies AnalysisWorkerReply)
    })
}
