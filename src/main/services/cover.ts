import path from 'node:path'
import { existsSync } from 'node:fs'
import { downloadToFile } from '../lib/net'
import { ensureDir, removeFile } from '../lib/fsx'
import { coverCacheDir } from './paths'

/**
 * Downloads a provider thumbnail for use as embedded cover art.
 *
 * Failures are non-fatal by design: cover art is cosmetic, and a missing image
 * must never block an export.
 */
export async function fetchCover(
  url: string | null,
  key: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!url) return null

  const directory = coverCacheDir()
  await ensureDir(directory)
  const target = path.join(directory, `${key}.jpg`)

  if (existsSync(target)) return target

  try {
    await downloadToFile(url, target, { signal, idleTimeoutMs: 20_000 })
    return target
  } catch {
    await removeFile(target)
    return null
  }
}

export async function forgetCover(key: string): Promise<void> {
  await removeFile(path.join(coverCacheDir(), `${key}.jpg`))
}
