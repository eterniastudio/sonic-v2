import { parsePlaylistUrl, parseVideoUrl } from '@shared/url'
import { PLAYLIST_LIMIT, type PlaylistReview } from '@shared/playlist'
import { run } from '../lib/child'
import { assertAccepting } from '../lifecycle'
import { engineService } from './engine'
import { baseYtDlpArgs, summariseYtDlpError } from './probe'

const active = new Map<string, AbortController>()
export function cancelPlaylist(requestId: string): void { active.get(requestId)?.abort() }
export function stopPlaylists(): void { for (const controller of active.values()) controller.abort() }

/** Only canonical video identities from the extractor can enter the download queue. */
export function readPlaylistInfo(raw: unknown): PlaylistReview {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { entries?: unknown }).entries)) throw new Error('YouTube returned no playlist entries.')
  const info = raw as { title?: unknown; entries: unknown[]; playlist_count?: unknown }
  const tracks: PlaylistReview['tracks'] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const value of info.entries.slice(0, PLAYLIST_LIMIT)) {
    if (!value || typeof value !== 'object') { skipped++; continue }
    const entry = value as Record<string, unknown>
    const id = typeof entry.id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(entry.id) ? entry.id : null
    const parsed = id ? parseVideoUrl(`https://www.youtube.com/watch?v=${id}`) : null
    const unavailable = ['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(String(entry.availability)) ||
      /^\[(Private|Deleted) video\]$/i.test(String(entry.title)) || entry.is_live === true || entry.live_status === 'is_live' || entry.live_status === 'is_upcoming'
    if (!parsed?.normalized || unavailable || seen.has(parsed.normalized)) { skipped++; continue }
    seen.add(parsed.normalized)
    tracks.push({ url: parsed.normalized, title: typeof entry.title === 'string' ? entry.title.slice(0, 500) : id! })
  }
  return {
    title: typeof info.title === 'string' ? info.title.slice(0, 500) : 'YouTube playlist', tracks, skipped,
    limited: info.entries.length > PLAYLIST_LIMIT || (typeof info.playlist_count === 'number' && info.playlist_count > PLAYLIST_LIMIT)
  }
}

export async function inspectPlaylist(url: string, requestId: string): Promise<PlaylistReview> {
  assertAccepting()
  const normalized = parsePlaylistUrl(url)
  if (!normalized) throw new Error('Paste a valid YouTube playlist link.')
  if (active.size) throw new Error('A playlist is already being read. Cancel it or wait for it to finish.')
  const controller = new AbortController()
  active.set(requestId, controller)
  const timer = setTimeout(() => controller.abort(new Error('Reading the playlist timed out after 90 seconds. Please retry.')), 90_000)
  try {
    const { signal } = controller
    const tool = await engineService.resolve('yt-dlp', false, signal)
    signal.throwIfAborted()
    if (!tool.path) throw new Error('Set up the media engine in Settings before reading playlists.')
    const args = (await baseYtDlpArgs(signal)).filter(arg => arg !== '--no-playlist')
    signal.throwIfAborted()
    const result = await run(tool.path, [...args, '--yes-playlist', '--flat-playlist', '--dump-single-json', '--skip-download', '--playlist-end', String(PLAYLIST_LIMIT + 1), '--socket-timeout', '20', '--retries', '2', normalized], { signal, timeoutMs: 85_000, maxCaptureBytes: 8 * 1024 * 1024 })
    signal.throwIfAborted()
    if (result.timedOut) throw new Error('Reading the playlist timed out. Please retry.')
    if (result.code !== 0) throw new Error(summariseYtDlpError(result.stderr, 'youtube'))
    if (result.stdoutTruncated) throw new Error('This playlist returned too much metadata. Try a smaller playlist.')
    let info: unknown
    try { info = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) }
    catch { throw new Error('Could not read the playlist metadata. Please retry.') }
    return readPlaylistInfo(info)
  } finally { clearTimeout(timer); active.delete(requestId) }
}
