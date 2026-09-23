import path from 'node:path'
import type { PresetId } from '@shared/domain'
import { getPreset } from '@shared/presets'
import { ensureDir, fileExists, removeFile } from '../lib/fsx'
import { probeMediaFile } from './ffprobe'
import { libraryService } from './library'
import { stagingDir } from './paths'
import { buildTagContext, publishExport } from './publish'
import { buildAudioEvidence } from '@shared/metadata'
import { settingsService } from './settings'
import { transcode } from './transcode'
import { engineService } from './engine'
import { sha256File } from '../lib/fsx'

export interface ReexportResult {
  ok: boolean
  outputPath: string | null
  error: string | null
}

/**
 * Creates a new export of an existing library beat at a different recipe.
 *
 * This always works from the file already on disk, so exporting a lossy MP3 to
 * a lossless preset cannot restore detail that was never there — the UI says so
 * rather than implying an upgrade.
 */
export async function reexportBeat(beatId: string, presetId: PresetId): Promise<ReexportResult> {
  const beat = libraryService.get(beatId)
  if (!beat) {
    return { ok: false, outputPath: null, error: 'That beat is no longer in your library.' }
  }

  if (!(await fileExists(beat.filePath))) {
    return { ok: false, outputPath: null, error: 'The source file for this beat is missing.' }
  }

  const settings = settingsService.get()
  const preset = getPreset(presetId)
  const tempOutput = path.join(stagingDir(), `reexport_${beat.id}.${preset.extension}`)
  const controller = new AbortController()

  try {
    await ensureDir(stagingDir())
    const source = await probeMediaFile(beat.filePath)

    await transcode({
      inputPath: beat.filePath,
      outputPath: tempOutput,
      presetId,
      channels: settings.channelMode,
      lufs: settings.normalizeLufs,
      coverPath: null,
      tags: buildTagContext(
        {
          title: beat.title,
          producer: beat.producer,
          bpm: beat.bpm,
          altBpm: beat.altBpm,
          key: beat.key,
          camelot: beat.camelot,
          detune: beat.detune,
          tuning: null,
          genre: null
        },
        beat.sourceUrl
      ),
      durationSec: source.durationSec,
      signal: controller.signal,
      onProgress: () => undefined
    })

    const output = await probeMediaFile(tempOutput)
    const fingerprint = await sha256File(tempOutput)

    const [ytdlp, ffmpeg] = await Promise.all([
      engineService.resolve('yt-dlp'),
      engineService.resolve('ffmpeg')
    ])

    const result = await publishExport({
      jobId: `reexport_${beat.id}`,
      stagedPath: tempOutput,
      extension: preset.extension,
      metadata: {
        title: beat.title,
        producer: beat.producer,
        bpm: beat.bpm,
        altBpm: beat.altBpm,
        key: beat.key,
        camelot: beat.camelot,
        detune: beat.detune,
        tuning: null,
        genre: null
      },
      presetId,
      sourceKind: beat.sourceKind,
      sourceUrl: beat.sourceUrl,
      videoId: null,
      uploader: beat.sourceChannel ?? null,
      sourceTitle: beat.title,
      evidence: [],
      conflicts: [],
      // Provenance carries over: re-exporting must not throw away the analysis
      // history or the producer's overrides.
      analysis: beat.analysis,
      audioEvidence: beat.analysis ? buildAudioEvidence(beat.analysis) : [],
      verification: beat.verification,
      overrides: beat.overrides,
      sources: beat.sources,
      embedded: beat.embedded,
      channels: settings.channelMode,
      lufs: settings.normalizeLufs,
      embedTags: settings.embedTags,
      fingerprint,
      index: 1,
      durationSec: output.durationSec,
      engine: { ytdlp: ytdlp.version, ffmpeg: ffmpeg.version },
      output: {
        sizeBytes: output.sizeBytes,
        format: output.container,
        bitrateKbps: output.audio?.bitrateKbps ?? output.bitrateKbps,
        sampleRate: output.audio?.sampleRate ?? null,
        channels: output.audio?.channels ?? null
      }
    })

    return { ok: true, outputPath: result.filePath, error: null }
  } catch (error) {
    await removeFile(tempOutput)
    return {
      ok: false,
      outputPath: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
