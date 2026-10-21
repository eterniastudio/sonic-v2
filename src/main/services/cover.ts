import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, readdir, rename, stat } from 'node:fs/promises'
import { downloadToFile } from '../lib/net'
import { ensureDir, removeFile } from '../lib/fsx'
import { coverCacheDir } from './paths'

const PARTIAL = '.part'
/** A partial file this old belongs to no live download (downloads stall out far sooner). */
const STALE_PARTIAL_MS = 60 * 60_000

/** A cached cover is reusable only if it is non-empty and, when it is a JPEG, complete. */
async function usableCover(file: string): Promise<boolean> {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    if (size < 4) return false
    const head = Buffer.alloc(2), tail = Buffer.alloc(2)
    await handle.read(head, 0, 2, 0)
    await handle.read(tail, 0, 2, size - 2)
    // JPEG data ends with an EOI marker; other provider formats are accepted as-is.
    return !(head[0] === 0xff && head[1] === 0xd8) || (tail[0] === 0xff && tail[1] === 0xd9)
  } catch {
    return false
  } finally { await handle?.close() }
}

/**
 * Downloads a provider thumbnail for use as embedded cover art.
 *
 * Failures are non-fatal by design: cover art is cosmetic, and a missing image
 * must never block an export. The image is written to a private partial file
 * and renamed into place, so an interrupted download is never reused.
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

  if (await usableCover(target)) return target

  const partial = path.join(directory, `${key}.${process.pid}.${randomUUID()}.jpg${PARTIAL}`)
  try {
    await downloadToFile(url, partial, { signal, idleTimeoutMs: 20_000 })
    if (!(await usableCover(partial))) throw new Error('Incomplete cover image.')
    await rename(partial, target)
    return target
  } catch {
    await removeFile(partial)
    return null
  }
}

export async function forgetCover(key: string): Promise<void> {
  await removeFile(path.join(coverCacheDir(), `${key}.jpg`))
}

/**
 * Removes cached covers whose job is gone, plus abandoned partial downloads.
 * `liveKeys` are the ids of every job still in the queue. Returns the number removed.
 */
export async function pruneCovers(liveKeys: Iterable<string>, now = Date.now()): Promise<number> {
  const keep = new Set(liveKeys)
  let entries: string[]
  try { entries = await readdir(coverCacheDir()) } catch { return 0 }
  let removed = 0
  for (const name of entries) {
    const file = path.join(coverCacheDir(), name)
    if (name.endsWith(PARTIAL)) {
      // A partial may belong to a download in flight; only an old one is abandoned.
      const info = await stat(file).catch(() => null)
      if (!info || now - info.mtimeMs < STALE_PARTIAL_MS) continue
    } else if (!name.endsWith('.jpg') || keep.has(name.slice(0, -'.jpg'.length))) continue
    await removeFile(file)
    removed++
  }
  return removed
}
