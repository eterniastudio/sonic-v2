import type { MetadataValues } from '@shared/domain'
import { parseText } from '@shared/metadata'
import { run } from '../lib/child'
import { engineService } from './engine'

export interface MediaStreamInfo {
  codec: string | null
  sampleRate: number | null
  channels: number | null
  bitrateKbps: number | null
  bitsPerSample: number | null
}

export interface MediaInfo {
  durationSec: number
  sizeBytes: number
  container: string
  formatName: string
  bitrateKbps: number | null
  audio: MediaStreamInfo | null
  tags: Record<string, string>
}

interface RawFfprobeOutput {
  format?: {
    duration?: string
    size?: string
    bit_rate?: string
    format_name?: string
    format_long_name?: string
    tags?: Record<string, unknown>
  }
  streams?: {
    codec_type?: string
    codec_name?: string
    sample_rate?: string
    channels?: number
    bit_rate?: string
    bits_per_raw_sample?: string
    bits_per_sample?: string
  }[]
}

function toNumber(value: string | number | undefined): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Reads container and stream facts for a local file. */
export async function probeMediaFile(filePath: string, signal?: AbortSignal): Promise<MediaInfo> {
  const ffprobe = await engineService.resolve('ffprobe', false, signal)
  if (signal?.aborted) throw new Error('Reading audio metadata was cancelled.')
  if (!ffprobe.path) {
    throw new Error('ffprobe is not installed. Run media engine setup from Settings.')
  }

  const result = await run(
    ffprobe.path,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: 60_000, signal }
  )

  if (result.aborted || signal?.aborted) throw new Error('Reading audio metadata was cancelled.')
  if (result.code !== 0) {
    throw new Error(`ffprobe could not read ${filePath}: ${result.stderr.trim().slice(0, 200)}`)
  }

  if (result.timedOut) throw new Error('Reading audio metadata timed out.')
  if (result.stdoutTruncated) throw new Error('Audio metadata exceeded the capture limit.')

  let raw: RawFfprobeOutput
  try {
    raw = JSON.parse(result.stdout) as RawFfprobeOutput
  } catch {
    throw new Error('ffprobe returned output that could not be parsed.')
  }

  const audioStream = raw.streams?.find((stream) => stream.codec_type === 'audio') ?? null
  const tags: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw.format?.tags ?? {})) {
    if (value == null) continue
    tags[key] = String(value)
  }

  const formatBitrate = toNumber(raw.format?.bit_rate)
  const streamBitrate = toNumber(audioStream?.bit_rate)

  return {
    durationSec: toNumber(raw.format?.duration) ?? 0,
    sizeBytes: toNumber(raw.format?.size) ?? 0,
    container: raw.format?.format_name ?? '',
    formatName: raw.format?.format_long_name ?? raw.format?.format_name ?? '',
    bitrateKbps: (formatBitrate ?? streamBitrate ?? 0) / 1000 || null,
    audio: audioStream
      ? {
          codec: audioStream.codec_name ?? null,
          sampleRate: toNumber(audioStream.sample_rate),
          channels: audioStream.channels ?? null,
          bitrateKbps: streamBitrate != null ? streamBitrate / 1000 : null,
          bitsPerSample:
            toNumber(audioStream.bits_per_raw_sample) ?? toNumber(audioStream.bits_per_sample)
        }
      : null,
    tags
  }
}

/**
 * Maps container tags onto Sonic's metadata fields.
 *
 * Standard ID3 frames (TIT2/TPE1/TBPM/TKEY) and their Vorbis/MP4 equivalents
 * are folded into one shape, and free-text comments are run through the same
 * parser used for titles so detune and tuning survive a round trip.
 */
export function tagsToMetadata(tags: Record<string, string>): MetadataValues {
  const lower: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags)) {
    lower[key.toLowerCase()] = value
  }

  const out: MetadataValues = {}

  const title = lower['title'] ?? lower['tit2']
  if (title && title.trim().length > 0) out.title = title.trim()

  const artist = lower['artist'] ?? lower['tpe1'] ?? lower['album_artist'] ?? lower['albumartist']
  if (artist && artist.trim().length > 0) out.producer = artist.trim()

  const genre = lower['genre'] ?? lower['tcon']
  if (genre && genre.trim().length > 0) out.genre = genre.trim()

  const bpmRaw = lower['tbpm'] ?? lower['bpm']
  if (bpmRaw) {
    const bpm = Number(bpmRaw)
    if (Number.isFinite(bpm) && bpm >= 40 && bpm <= 300) out.bpm = bpm
  }

  const keyRaw = lower['tkey'] ?? lower['key'] ?? lower['initialkey']
  if (keyRaw && keyRaw.trim().length > 0) {
    const parsed = parseText(keyRaw.trim(), 'tags')
    if (parsed.values.key) out.key = parsed.values.key
    if (parsed.values.camelot) out.camelot = parsed.values.camelot
  }

  const comment = lower['comment'] ?? lower['comm'] ?? lower['description']
  if (comment && comment.trim().length > 0) {
    const parsed = parseText(comment, 'tags')
    for (const [field, value] of Object.entries(parsed.values)) {
      if (out[field as keyof MetadataValues] == null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(out as any)[field] = value
      }
    }
  }

  return out
}

/** Convenience: probe a file and return only its interpreted metadata. */
export async function readEmbeddedMetadata(filePath: string): Promise<MetadataValues> {
  const info = await probeMediaFile(filePath)
  return tagsToMetadata(info.tags)
}
