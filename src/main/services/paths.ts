import { app } from 'electron'
import path from 'node:path'

/** Root for all Sonic V2 state. Nothing is written outside this plus the export folder. */
export function userDataDir(): string {
  return app.getPath('userData')
}

/** Private staging area for in-flight downloads and conversions. */
export function stagingDir(): string {
  return path.join(userDataDir(), 'staging')
}

/** Where the managed yt-dlp / ffmpeg binaries live. */
export function engineDir(): string {
  return path.join(userDataDir(), 'engine')
}

export function settingsFile(): string {
  return path.join(userDataDir(), 'settings.json')
}

export function libraryFile(): string {
  return path.join(userDataDir(), 'library.json')
}

export function queueFile(): string {
  return path.join(userDataDir(), 'queue.json')
}

export function coverCacheDir(): string {
  return path.join(userDataDir(), 'covers')
}

/** Scratch space for raw PCM decoded for analysis. */
export function analysisDir(): string {
  return path.join(userDataDir(), 'analysis')
}

/** Persistent cache of completed analyses, keyed by input identity. */
export function analysisCacheFile(): string {
  return path.join(userDataDir(), 'analysis-cache.json')
}

/** Default export destination: the user's Music folder. */
export function defaultDownloadDir(): string {
  try {
    return path.join(app.getPath('music'), 'Sonic V2')
  } catch {
    return path.join(userDataDir(), 'exports')
  }
}

export function logsDir(): string {
  return path.join(userDataDir(), 'logs')
}
