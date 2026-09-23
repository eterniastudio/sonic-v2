/**
 * Source URL classification. Shared so paste-time validation in the renderer
 * matches what the main process will actually accept.
 */

export interface ParsedVideoUrl {
  ok: boolean
  /** Canonical https URL, when the input could be normalised. */
  normalized: string | null
  videoId: string | null
  provider: 'youtube' | null
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

  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    return {
      ok: false,
      normalized: null,
      videoId: null,
      provider: null,
      reason: 'Only YouTube links are supported'
    }
  }

  const host = url.hostname.toLowerCase()
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
    if (parsed.ok && parsed.normalized && parsed.videoId) {
      if (seen.has(parsed.videoId)) continue
      seen.add(parsed.videoId)
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
