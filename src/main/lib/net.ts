import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { ensureDir, removeFile } from './fsx'
import path from 'node:path'

export interface DownloadOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void
  /** Give up if no bytes arrive for this long. */
  idleTimeoutMs?: number
}

const DEFAULT_IDLE_TIMEOUT = 45_000

/**
 * Streams an HTTP(S) resource to disk with progress reporting.
 *
 * Uses the platform fetch so redirects, TLS and proxy settings behave the same
 * as the rest of Electron's networking.
 */
export async function downloadToFile(
  url: string,
  destination: string,
  options: DownloadOptions = {}
): Promise<void> {
  await ensureDir(path.dirname(destination))

  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  let idleTimer: NodeJS.Timeout | null = null
  const idleTimeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), idleTimeout)
  }

  try {
    resetIdle()
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'SonicV2/2.0 (+https://github.com/eterniastudio/sonic)',
        accept: '*/*',
        ...options.headers
      }
    })

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`)
    }
    if (!response.body) {
      throw new Error(`Empty response body for ${url}`)
    }

    const declaredLength = Number(response.headers.get('content-length'))
    const totalBytes = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : null

    const file = createWriteStream(destination)
    const reader = response.body.getReader()
    let received = 0
    let lastReport = 0

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()

      const chunk = Buffer.from(value)
      received += chunk.byteLength
      if (!file.write(chunk)) {
        await once(file, 'drain')
      }

      // Throttle UI updates to roughly 20/s.
      const now = Date.now()
      if (options.onProgress && now - lastReport > 50) {
        lastReport = now
        options.onProgress(received, totalBytes)
      }
    }

    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })

    options.onProgress?.(received, totalBytes ?? received)
  } catch (error) {
    await removeQuietly(destination)
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error('Download stalled and was cancelled')
    }
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** Fetches a small text resource, e.g. a checksum manifest. */
export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal,
    headers: { 'user-agent': 'SonicV2/2.0', accept: 'text/plain,*/*' }
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response.text()
}

async function removeQuietly(target: string): Promise<void> {
  await removeFile(target)
}
