import type { ProbeResult } from '@shared/domain'
import { parseVideoUrl } from '@shared/url'
import { run } from '../lib/child'
import { engineService } from './engine'
import { settingsService } from './settings'

interface YtDlpInfo {
  id?: string
  title?: string
  description?: string
  uploader?: string
  channel?: string
  thumbnail?: string
  duration?: number
  is_live?: boolean
  live_status?: string
  webpage_url?: string
  _type?: string
  entries?: unknown[]
}

export function preferredSourceChannel(info: Pick<YtDlpInfo, 'channel' | 'uploader'>): string | null {
  return info.channel?.trim() || info.uploader?.trim() || null
}

/** Builds the shared, non-interactive prefix every yt-dlp invocation uses. */
export async function baseYtDlpArgs(): Promise<string[]> {
  const settings = settingsService.get()
  const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-call-home']

  if (settings.cookiesFromBrowser !== 'none') {
    args.push('--cookies-from-browser', settings.cookiesFromBrowser)
  }

  const ffmpeg = await engineService.resolve('ffmpeg')
  if (ffmpeg.path) {
    args.push('--ffmpeg-location', ffmpeg.path)
  }

  return args
}

/**
 * Capture ceiling for a metadata dump.
 *
 * `--dump-single-json` is not a log — it is a structured document. A real
 * YouTube video routinely returns over a megabyte (a 10-minute upload measured
 * 1.28 MB), mostly formats, thumbnails, chapters and automatic captions. Under
 * the default 512 KB log cap that document was cut in half and every probe
 * failed with a parse error, so this path gets its own, much larger ceiling.
 */
const PROBE_MAX_CAPTURE_BYTES = 32 * 1024 * 1024

/** Reads a URL's metadata without downloading any media. */
export async function probeUrl(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const parsed = parseVideoUrl(url)
  const empty: ProbeResult = {
    url,
    videoId: parsed.videoId,
    title: '',
    description: null,
    uploader: null,
    thumbnail: null,
    durationSec: null,
    isLive: false,
    error: null
  }

  if (!parsed.ok || !parsed.normalized) {
    return { ...empty, error: parsed.reason ?? 'Unsupported URL' }
  }

  const ytdlp = await engineService.resolve('yt-dlp')
  if (!ytdlp.path) {
    return { ...empty, error: 'yt-dlp is not installed yet. Finish media engine setup first.' }
  }

  const args = [
    ...(await baseYtDlpArgs()),
    '--dump-single-json',
    '--skip-download',
    '--socket-timeout',
    '20',
    '--retries',
    '2',
    parsed.normalized
  ]

  const result = await run(ytdlp.path, args, {
    signal,
    timeoutMs: 60_000,
    maxCaptureBytes: PROBE_MAX_CAPTURE_BYTES
  })

  if (result.aborted) {
    return { ...empty, error: 'Cancelled' }
  }

  if (result.timedOut) return { ...empty, error: 'Reading source metadata timed out after 60 seconds.' }

  if (result.code !== 0) {
    return { ...empty, error: summariseYtDlpError(result.stderr) }
  }

  // Say what actually happened rather than reporting a parse failure.
  if (result.stdoutTruncated) {
    return {
      ...empty,
      error: 'The metadata for this link was unexpectedly large and could not be read in full.'
    }
  }

  const jsonStart = result.stdout.indexOf('{')
  if (jsonStart === -1) {
    return { ...empty, error: 'yt-dlp returned no metadata for this link.' }
  }

  let info: YtDlpInfo
  try {
    info = JSON.parse(result.stdout.slice(jsonStart)) as YtDlpInfo
  } catch {
    return { ...empty, error: 'Could not read the metadata yt-dlp returned.' }
  }

  const isLive = info.is_live === true || info.live_status === 'is_live'

  return {
    url: parsed.normalized,
    videoId: info.id ?? parsed.videoId,
    title: info.title?.trim() ?? '',
    description: info.description ?? null,
    uploader: preferredSourceChannel(info),
    thumbnail: info.thumbnail ?? null,
    durationSec: typeof info.duration === 'number' ? info.duration : null,
    isLive,
    error: null
  }
}

/** Turns yt-dlp's noisy stderr into one actionable sentence. */
export function summariseYtDlpError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/^ERROR:\s*/i, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('WARNING'))

  const joined = lines.join(' ')
  if (joined.length === 0) return 'yt-dlp could not read this link.'

  if (/private video/i.test(joined)) return 'This video is private.'
  if (/video unavailable/i.test(joined)) return 'This video is unavailable.'
  if (/age|sign in to confirm/i.test(joined)) {
    return 'YouTube asked for a signed-in session. Set a browser for cookies in Settings, then retry.'
  }
  if (/removed|deleted|terminated/i.test(joined)) return 'This video has been removed.'
  if (/not available in your country|geo/i.test(joined)) return 'This video is region-locked.'
  if (/timed out|timeout/i.test(joined)) return 'The connection to YouTube timed out.'
  if (/urlopen error|unable to download|network/i.test(joined)) {
    return 'Could not reach YouTube. Check your connection.'
  }

  return lines[lines.length - 1].slice(0, 240)
}
