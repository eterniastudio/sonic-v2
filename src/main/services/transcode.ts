import path from 'node:path'
import type { ChannelMode, PresetId } from '@shared/domain'
import { buildFfmpegArgs, getPreset, type FfmpegTagContext } from '@shared/presets'
import { run } from '../lib/child'
import { removeFile } from '../lib/fsx'
import { engineService } from './engine'

export interface TranscodeOptions {
  inputPath: string
  outputPath: string
  presetId: PresetId
  channels: ChannelMode
  lufs: number | null
  coverPath: string | null
  tags: FfmpegTagContext
  durationSec: number | null
  signal: AbortSignal
  onProgress: (percent: number | null) => void
  onLog?: (line: string) => void
}

/** Parses ffmpeg's `-progress` stream, which reports `out_time=HH:MM:SS.ffffff`. */
function parseOutTime(line: string): number | null {
  const match = /^out_time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line.trim())
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/**
 * Converts one staged audio file into the chosen export recipe and writes the
 * reviewed metadata as container tags.
 */
export async function transcode(options: TranscodeOptions): Promise<void> {
  options.signal.throwIfAborted()
  const ffmpeg = await engineService.resolve('ffmpeg', false, options.signal)
  options.signal.throwIfAborted()
  if (!ffmpeg.path) {
    throw new Error('ffmpeg is not installed. Run media engine setup from Settings.')
  }

  const preset = getPreset(options.presetId)
  const coverPath = preset.supportsCoverArt ? options.coverPath : null

  const args = buildFfmpegArgs(options.presetId, {
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    channels: options.channels,
    lufs: options.lufs,
    coverPath,
    tags: options.tags
  })

  // Machine-readable progress goes to stdout; the human log stays on stderr.
  const bannerIndex = args.indexOf('-hide_banner')
  args.splice(bannerIndex + 1, 0, '-progress', 'pipe:1', '-nostats', '-loglevel', 'error')

  const result = await run(ffmpeg.path, args, {
    signal: options.signal,
    onStdoutLine: (line) => {
      if (line.startsWith('progress=end')) {
        options.onProgress(1)
        return
      }
      const seconds = parseOutTime(line)
      if (seconds == null || !options.durationSec || options.durationSec <= 0) return
      options.onProgress(Math.max(0, Math.min(0.999, seconds / options.durationSec)))
    },
    onStderrLine: (line) => options.onLog?.(line)
  })

  if (result.aborted) {
    await removeFile(options.outputPath)
    throw new Error('Cancelled')
  }

  if (result.code !== 0) {
    await removeFile(options.outputPath)
    const detail = result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-3)
      .join(' ')
    throw new Error(`Conversion failed: ${detail.slice(0, 300) || 'ffmpeg reported an error.'}`)
  }

  options.onProgress(1)
}

/** Remuxes into the final container without re-encoding, for the `original` preset. */
export function sourceExtensionFor(presetId: PresetId, stagedExtension: string): string {
  if (presetId !== 'original') return getPreset(presetId).extension
  // The `original` recipe keeps whatever container the provider handed us.
  const normalised = stagedExtension.toLowerCase()
  if (normalised === 'webm') return 'webm'
  if (normalised === 'm4a' || normalised === 'mp4') return 'm4a'
  if (normalised === 'opus' || normalised === 'ogg' || normalised === 'oga') return 'opus'
  if (normalised === 'mp3') return 'mp3'
  if (normalised === 'flac') return 'flac'
  if (normalised === 'wav') return 'wav'
  return normalised || 'm4a'
}

export function tempOutputFor(jobId: string, stagingDirPath: string, extension: string): string {
  return path.join(stagingDirPath, `${jobId}.out.${extension}`)
}
