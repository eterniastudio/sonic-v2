import type { ChannelMode, PresetId } from './domain'

export interface PresetDefinition {
  id: PresetId
  label: string
  /** Compact badge shown in dense UI. */
  short: string
  description: string
  extension: string
  lossless: boolean
  /** Whether the container can carry embedded cover art. */
  supportsCoverArt: boolean
  /** Audio codec arguments handed to ffmpeg. */
  codecArgs: string[]
  /** Relative size hint, used only for UI copy. */
  sizeHint: string
}

export const PRESETS: readonly PresetDefinition[] = [
  {
    id: 'mp3-320',
    label: 'MP3 320',
    short: '320',
    description: 'Constant 320 kbps MP3. The safe default for sharing and DJ software.',
    extension: 'mp3',
    lossless: false,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'libmp3lame', '-b:a', '320k'],
    sizeHint: '~2.4 MB/min'
  },
  {
    id: 'mp3-v0',
    label: 'MP3 V0',
    short: 'V0',
    description: 'Highest-quality variable-bitrate MP3. Smaller than 320 with equal transparency.',
    extension: 'mp3',
    lossless: false,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'libmp3lame', '-q:a', '0'],
    sizeHint: '~1.9 MB/min'
  },
  {
    id: 'm4a-256',
    label: 'M4A AAC 256',
    short: 'AAC',
    description: 'AAC at 256 kbps in an M4A container. Great quality per megabyte.',
    extension: 'm4a',
    lossless: false,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'aac', '-b:a', '256k'],
    sizeHint: '~1.9 MB/min'
  },
  {
    id: 'flac',
    label: 'FLAC',
    short: 'FLAC',
    description: 'Lossless compressed audio for archiving and further production work.',
    extension: 'flac',
    lossless: true,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'flac', '-compression_level', '8'],
    sizeHint: '~6 MB/min'
  },
  {
    id: 'wav-44100-24',
    label: 'WAV 44.1 / 24',
    short: 'WAV 44',
    description: '24-bit PCM at 44.1 kHz. The standard session format for most DAWs.',
    extension: 'wav',
    lossless: true,
    supportsCoverArt: false,
    codecArgs: ['-c:a', 'pcm_s24le', '-ar', '44100'],
    sizeHint: '~15 MB/min'
  },
  {
    id: 'wav-48000-24',
    label: 'WAV 48 / 24',
    short: 'WAV 48',
    description: '24-bit PCM at 48 kHz, for video and 48 kHz production sessions.',
    extension: 'wav',
    lossless: true,
    supportsCoverArt: false,
    codecArgs: ['-c:a', 'pcm_s24le', '-ar', '48000'],
    sizeHint: '~16 MB/min'
  },
  {
    id: 'opus-192',
    label: 'Opus 192',
    short: 'Opus',
    description: 'Efficient 192 kbps Opus. Small files, excellent quality.',
    extension: 'opus',
    lossless: false,
    supportsCoverArt: false,
    codecArgs: ['-c:a', 'libopus', '-b:a', '192k'],
    sizeHint: '~1.4 MB/min'
  },
  {
    id: 'original',
    label: 'Original stream',
    short: 'Src',
    description: 'Keep the acquired audio stream untouched — no re-encode, no quality loss.',
    extension: 'm4a',
    lossless: true,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'copy'],
    sizeHint: 'source'
  }
] as const

export const PRESET_MAP: Record<PresetId, PresetDefinition> = PRESETS.reduce(
  (accumulator, preset) => {
    accumulator[preset.id] = preset
    return accumulator
  },
  {} as Record<PresetId, PresetDefinition>
)

export const DEFAULT_PRESET_ID: PresetId = 'mp3-320'

export function getPreset(id: PresetId | string | null | undefined): PresetDefinition {
  if (id && id in PRESET_MAP) return PRESET_MAP[id as PresetId]
  return PRESET_MAP[DEFAULT_PRESET_ID]
}

export interface FfmpegTagContext {
  title?: string | null
  producer?: string | null
  album?: string | null
  comment?: string | null
  date?: string | null
  genre?: string | null
  bpm?: number | null
  key?: string | null
}

export interface FfmpegBuildContext {
  inputPath: string
  outputPath: string
  channels: ChannelMode
  /** Target loudness in LUFS, or null to leave dynamics alone. */
  lufs: number | null
  coverPath: string | null
  tags: FfmpegTagContext
}

/** ID3v2 / Vorbis keys differ slightly; MP3 accepts the raw frame names. */
function tagArgs(preset: PresetDefinition, tags: FfmpegTagContext): string[] {
  const pairs: [string, string | number | null | undefined][] = [
    ['title', tags.title],
    ['artist', tags.producer],
    ['album', tags.album],
    ['comment', tags.comment],
    ['date', tags.date],
    ['genre', tags.genre],
    ['TBPM', tags.bpm],
    ['TKEY', tags.key]
  ]

  const args: string[] = []
  for (const [key, value] of pairs) {
    if (value == null || value === '') continue
    args.push('-metadata', `${key}=${String(value)}`)
  }

  if (preset.extension === 'mp3') {
    args.push('-id3v2_version', '3', '-write_id3v1', '1')
  }
  return args
}

/**
 * Builds a complete, non-interactive ffmpeg argument vector for one export.
 *
 * Every argument is enumerated — there is no path for arbitrary producer input
 * to reach ffmpeg as a flag, and source container metadata is stripped first so
 * only Sonic's reviewed values are written.
 */
export function buildFfmpegArgs(presetId: PresetId, context: FfmpegBuildContext): string[] {
  const preset = getPreset(presetId)
  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-i', context.inputPath]

  const wantsCover = Boolean(context.coverPath) && preset.supportsCoverArt
  if (wantsCover && context.coverPath) {
    args.push('-i', context.coverPath)
  }

  args.push('-map', '0:a:0')

  if (wantsCover) {
    args.push('-map', '1:v:0', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic')
  }

  // Strip the source container's own tags before writing reviewed values.
  args.push('-map_metadata', '-1')

  args.push(...preset.codecArgs)

  if (context.channels === 'stereo') args.push('-ac', '2')
  if (context.channels === 'mono') args.push('-ac', '1')

  if (context.lufs != null && preset.id !== 'original') {
    args.push('-af', `loudnorm=I=${context.lufs}:TP=-1.0:LRA=11`)
  }

  args.push(...tagArgs(preset, context.tags))

  args.push(context.outputPath)
  return args
}
