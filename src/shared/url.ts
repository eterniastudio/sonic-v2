/**
 * Source URL classification. Shared so paste-time validation in the renderer
 * matches what the main process will actually accept.
 */

export interface ParsedVideoUrl {
  ok: boolean
  /** Canonical https URL, when the input could be normalised. */
  normalized: string | null
  videoId: string | null
  provider: 'youtube' | 'soundcloud' | null
  reason: string | null
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be'
])

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/** A playlist is expanded separately; media jobs always retain single-track URLs. */
export function parsePlaylistUrl(input: string): string | null {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !YOUTUBE_HOSTS.has(url.hostname)) return null
    const path = url.pathname
    if (path !== '/playlist' && path !== '/watch' && !((url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') && /^\/[A-Za-z0-9_-]{11}$/.test(path))) return null
    const id = url.searchParams.get('list')
    return id && /^[A-Za-z0-9_-]{2,200}$/.test(id) ? `https://www.youtube.com/playlist?list=${id}` : null
  } catch { return null }
}

export function extractIntakeUrls(blob: string): { tracks: ParsedVideoUrl[]; playlists: string[]; rejected: string[] } {
  const playlists = new Set<string>()
  const tracks: string[] = []
  for (const token of blob.split(/[\s,]+/).filter(Boolean)) {
    const playlist = parsePlaylistUrl(token)
    if (playlist) playlists.add(playlist)
    else tracks.push(token)
  }
  const parsed = extractVideoUrls(tracks.join('\n'))
  return { tracks: parsed.accepted, playlists: [...playlists], rejected: parsed.rejected }
}
const SOUNDCLOUD_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'])
const SOUNDCLOUD_SHARE_HOSTS = new Set(['on.soundcloud.com', 'soundcloud.app.goo.gl'])
const SOUNDCLOUD_COLLECTIONS = new Set(['tracks', 'albums', 'sets', 'reposts', 'likes', 'spotlight', 'comments'])

export function isSoundCloudShareUrl(input: string): boolean {
  try { return SOUNDCLOUD_SHARE_HOSTS.has(new URL(input).hostname) } catch { return false }
}

export function parseVideoUrl(input: string): ParsedVideoUrl {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: false, normalized: null, videoId: null, provider: null, reason: 'Empty input' }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return {
      ok: false,
      normalized: null,
      videoId: null,
      provider: null,
      reason: 'Not a valid URL'
    }
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      normalized: null,
      videoId: null,
      provider: null,
      reason: 'Only https links are supported'
    }
  }

  if (url.username || url.password || url.port) {
    return { ok: false, normalized: null, videoId: null, provider: null, reason: 'Links with credentials or custom ports are not supported' }
  }

  const host = url.hostname.toLowerCase()
  if (SOUNDCLOUD_HOSTS.has(host) || SOUNDCLOUD_SHARE_HOSTS.has(host)) {
    const segments = url.pathname.replace(/\/$/, '').split('/').slice(1)
    const share = SOUNDCLOUD_SHARE_HOSTS.has(host)
    const valid = share
      ? segments.length === 1 && /^[A-Za-z0-9_-]+$/.test(segments[0])
      : (segments.length === 2 || (segments.length === 3 && /^s-[A-Za-z0-9]+$/.test(segments[2]))) &&
        segments.slice(0, 2).every(segment => /^[A-Za-z0-9_-]+$/.test(segment)) &&
        !SOUNDCLOUD_COLLECTIONS.has(segments[1]) &&
        !['discover', 'search', 'you', 'stations', 'stream', 'charts'].includes(segments[0])
    if (!valid) return { ok: false, normalized: null, videoId: null, provider: 'soundcloud', reason: 'Use a SoundCloud track link — playlists and profiles are not supported' }
    let normalized = `https://${share ? host : 'soundcloud.com'}/${segments.join('/')}`
    const secret = url.searchParams.get('secret_token')
    if (!share && segments.length === 2 && secret && /^s-[A-Za-z0-9]+$/.test(secret)) normalized += `/${secret}`
    return { ok: true, normalized, videoId: null, provider: 'soundcloud', reason: null }
  }

  if (!YOUTUBE_HOSTS.has(host)) {
    return {
      ok: false,
      normalized: null,
      videoId: null,
      provider: null,
      reason: 'Only YouTube and SoundCloud track links are supported'
    }
  }

  let videoId: string | null = null

  if (host.endsWith('youtu.be')) {
    videoId = url.pathname.replace(/^\//, '').split('/')[0] ?? null
  } else if (url.pathname === '/watch') {
    videoId = url.searchParams.get('v')
  } else {
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live') {
      videoId = segments[1] ?? null
    }
  }

  if (!videoId || !VIDEO_ID.test(videoId)) {
    return {
      ok: false,
      normalized: null,
      videoId: null,
      provider: 'youtube',
      reason: 'Could not read a video id — playlists and channel links are not supported'
    }
  }

  return {
    ok: true,
    normalized: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    provider: 'youtube',
    reason: null
  }
}

/**
 * Pulls every distinct, valid video URL out of a pasted blob.
 * Accepts newline-, comma-, or whitespace-separated input.
 */
export function extractVideoUrls(blob: string): { accepted: ParsedVideoUrl[]; rejected: string[] } {
  const tokens = blob
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  const accepted: ParsedVideoUrl[] = []
  const rejected: string[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    const parsed = parseVideoUrl(token)
    if (parsed.ok && parsed.normalized) {
      if (seen.has(parsed.normalized)) continue
      seen.add(parsed.normalized)
      accepted.push(parsed)
    } else {
      rejected.push(token)
    }
  }

  return { accepted, rejected }
}

export function thumbnailFor(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}

/** Pulls the video id out of a stored source URL, if it is one. */
export function videoIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  return parseVideoUrl(url).videoId
}

/** Sixteen-by-nine cover art for a stored source URL, or null. */
export function coverArtFor(url: string | null | undefined): string | null {
  const id = videoIdFromUrl(url)
  return id ? thumbnailFor(id) : null
}
