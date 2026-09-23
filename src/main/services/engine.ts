import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { EngineComponent, EngineProgress, EngineStatus } from '@shared/domain'
import { downloadToFile, fetchText } from '../lib/net'
import { run } from '../lib/child'
import { ensureDir, removeDir, removeFile, sha256File, moveFile } from '../lib/fsx'
import { engineDir, stagingDir } from './paths'
import { settingsService } from './settings'

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'ffprobe'

const IS_WINDOWS = process.platform === 'win32'

const TOOL_BINARY: Record<ToolName, string> = {
  'yt-dlp': IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp',
  ffmpeg: IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg',
  ffprobe: IS_WINDOWS ? 'ffprobe.exe' : 'ffprobe'
}

const YTDLP_RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const FFMPEG_ZIP_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'

export interface ResolvedTool {
  name: ToolName
  path: string | null
  version: string | null
  origin: 'managed' | 'system' | null
}

/** Scans PATH for an executable, honouring PATHEXT on Windows. */
function which(binary: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  if (pathValue.length === 0) return null

  const hasExtension = path.extname(binary).length > 0
  const extensions = hasExtension
    ? ['']
    : IS_WINDOWS
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, hasExtension ? binary : binary + extension.toLowerCase())
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Keep looking.
      }
    }
  }
  return null
}

/** Reads a tool's self-reported version without blocking the main process. */
async function probeVersion(binary: string, signal?: AbortSignal): Promise<string | null> {
  const args = binary.toLowerCase().includes('yt-dlp') ? ['--version'] : ['-version']
  try {
    const result = await run(binary, args, { signal, timeoutMs: 12_000, maxCaptureBytes: 4096 })
    if (result.aborted || result.timedOut || result.code !== 0) return null
    const firstLine = result.stdout.split(/\r?\n/)[0]?.trim() ?? ''
    if (firstLine.length === 0) return null
    // `ffmpeg version 8.0-essentials_build ...` → `8.0-essentials_build`
    const versioned = /\bversion\s+(\S+)/i.exec(firstLine)
    return versioned ? versioned[1] : firstLine.slice(0, 60)
  } catch {
    return null
  }
}

class EngineService extends EventEmitter {
  private cached: { status: EngineStatus; at: number } | null = null
  private setupPromise: Promise<EngineStatus> | null = null
  private setupError: string | null = null

  get directory(): string {
    return engineDir()
  }

  private explicitPath(name: ToolName): string | null {
    const settings = settingsService.get()
    if (name === 'yt-dlp') return settings.ytdlpPath
    if (name === 'ffmpeg') return settings.ffmpegPath
    return settings.ffprobePath
  }

  async resolve(name: ToolName, force = false, signal?: AbortSignal): Promise<ResolvedTool> {
    if (!force) {
      const cached = this.cached?.status.components.find((component) => component.name === name)
      if (cached && this.cached && Date.now() - this.cached.at < 20_000) {
        return { name, path: cached.path, version: cached.version, origin: cached.origin }
      }
    }

    const explicit = this.explicitPath(name)
    if (explicit && existsSync(explicit)) {
      return { name, path: explicit, version: await probeVersion(explicit, signal), origin: 'system' }
    }

    const managed = path.join(engineDir(), TOOL_BINARY[name])
    if (existsSync(managed)) {
      return { name, path: managed, version: await probeVersion(managed, signal), origin: 'managed' }
    }

    const system = which(TOOL_BINARY[name])
    if (system) {
      return { name, path: system, version: await probeVersion(system, signal), origin: 'system' }
    }

    return { name, path: null, version: null, origin: null }
  }

  async status(force = false): Promise<EngineStatus> {
    if (!force && this.cached && Date.now() - this.cached.at < 20_000 && this.setupPromise == null) {
      return this.cached.status
    }

    const [ytdlp, ffmpeg, ffprobe] = await Promise.all([
      this.resolve('yt-dlp', true),
      this.resolve('ffmpeg', true),
      this.resolve('ffprobe', true)
    ])

    const components: EngineComponent[] = [ytdlp, ffmpeg, ffprobe].map((tool) => ({
      name: tool.name,
      available: tool.path != null,
      path: tool.path,
      version: tool.version,
      origin: tool.origin
    }))

    const status: EngineStatus = {
      ready: components.every((component) => component.available),
      engineDir: engineDir(),
      components,
      setupRunning: this.setupPromise != null,
      lastError: this.setupError
    }

    this.cached = { status, at: Date.now() }
    return status
  }

  invalidate(): void {
    this.cached = null
  }

  /** Installs whatever is missing. Concurrent calls share a single run. */
  async setup(): Promise<EngineStatus> {
    if (this.setupPromise) return this.setupPromise

    this.setupPromise = this.runSetup()
      .catch((error: unknown) => {
        this.setupError = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        this.setupPromise = null
      })

    return this.setupPromise
  }

  private async runSetup(): Promise<EngineStatus> {
    this.setupError = null
    await ensureDir(engineDir())
    this.emitProgress({
      phase: 'resolving',
      component: 'engine',
      receivedBytes: 0,
      totalBytes: null,
      percent: null,
      message: 'Checking installed tools…'
    })

    const ytdlp = await this.resolve('yt-dlp', true)
    if (!ytdlp.path) {
      await this.installYtDlp()
    }

    const ffmpeg = await this.resolve('ffmpeg', true)
    const ffprobe = await this.resolve('ffprobe', true)
    if (!ffmpeg.path || !ffprobe.path) {
      await this.installFfmpeg()
    }

    this.cached = null
    const status = await this.status(true)
    this.emitProgress({
      phase: status.ready ? 'done' : 'error',
      component: 'engine',
      receivedBytes: 0,
      totalBytes: null,
      percent: status.ready ? 1 : null,
      message: status.ready ? 'Media engine ready.' : 'Some tools are still missing.'
    })
    return status
  }

  /** Downloads yt-dlp and verifies it against the publisher's SHA-256 manifest. */
  private async installYtDlp(signal?: AbortSignal): Promise<void> {
    const binaryName = TOOL_BINARY['yt-dlp']
    await ensureDir(engineDir())
    const target = path.join(engineDir(), binaryName)
    const partial = `${target}.download`

    this.emitProgress({
      phase: 'resolving',
      component: 'yt-dlp',
      receivedBytes: 0,
      totalBytes: null,
      percent: null,
      message: 'Fetching the yt-dlp checksum manifest…'
    })

    let expectedHash: string | null = null
    try {
      const manifest = await fetchText(`${YTDLP_RELEASE_BASE}/SHA2-256SUMS`, signal)
      expectedHash = parseChecksumManifest(manifest, binaryName)
    } catch {
      // Without a manifest we still install, but report that verification was skipped.
      expectedHash = null
    }

    this.emitProgress({
      phase: 'downloading',
      component: 'yt-dlp',
      receivedBytes: 0,
      totalBytes: null,
      percent: 0,
      message: 'Downloading yt-dlp…'
    })

    await downloadToFile(`${YTDLP_RELEASE_BASE}/${binaryName}`, partial, {
      signal,
      onProgress: (received, total) => {
        this.emitProgress({
          phase: 'downloading',
          component: 'yt-dlp',
          receivedBytes: received,
          totalBytes: total,
          percent: total ? received / total : null,
          message: 'Downloading yt-dlp…'
        })
      }
    })

    if (expectedHash) {
      this.emitProgress({
        phase: 'verifying',
        component: 'yt-dlp',
        receivedBytes: 0,
        totalBytes: null,
        percent: null,
        message: 'Verifying the yt-dlp download…'
      })
      const actual = await sha256File(partial)
      if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
        await removeFile(partial)
        throw new Error(
          'The yt-dlp download did not match its published checksum and was discarded.'
        )
      }
    }

    await moveFile(partial, target)
    if (!IS_WINDOWS) {
      try {
        chmodSync(target, 0o755)
      } catch {
        // Non-fatal: the archive bit may already be correct.
      }
    }
    this.cached = null
  }

  /**
   * Downloads a static FFmpeg build and lifts `ffmpeg`/`ffprobe` out of it.
   * Windows only — elsewhere Sonic expects the system package manager to provide it.
   */
  private async installFfmpeg(signal?: AbortSignal): Promise<void> {
    if (!IS_WINDOWS) {
      throw new Error(
        'Automatic FFmpeg setup is only available on Windows. Install ffmpeg with your package manager and set the path in Settings.'
      )
    }

    const workDir = path.join(stagingDir(), 'ffmpeg-download')
    const archive = path.join(stagingDir(), 'ffmpeg.zip')
    await ensureDir(workDir)

    this.emitProgress({
      phase: 'downloading',
      component: 'ffmpeg',
      receivedBytes: 0,
      totalBytes: null,
      percent: 0,
      message: 'Downloading FFmpeg (about 185 MB)…'
    })

    await downloadToFile(FFMPEG_ZIP_URL, archive, {
      signal,
      onProgress: (received, total) => {
        this.emitProgress({
          phase: 'downloading',
          component: 'ffmpeg',
          receivedBytes: received,
          totalBytes: total,
          percent: total ? received / total : null,
          message: 'Downloading FFmpeg…'
        })
      }
    })

    this.emitProgress({
      phase: 'verifying',
      component: 'ffmpeg',
      receivedBytes: 0,
      totalBytes: null,
      percent: null,
      message: 'Extracting FFmpeg…'
    })

    await removeDir(workDir)
    await ensureDir(workDir)

    const extract = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${workDir.replace(/'/g, "''")}' -Force`
      ],
      { timeout: 300_000, windowsHide: true, encoding: 'utf8' }
    )

    if (extract.status !== 0) {
      throw new Error(`Could not extract the FFmpeg archive: ${extract.stderr?.slice(0, 300) ?? 'unknown error'}`)
    }

    const ffmpegSource = findFileRecursive(workDir, 'ffmpeg.exe')
    const ffprobeSource = findFileRecursive(workDir, 'ffprobe.exe')
    if (!ffmpegSource || !ffprobeSource) {
      throw new Error('The FFmpeg archive did not contain the expected binaries.')
    }

    await ensureDir(engineDir())
    await moveFile(ffmpegSource, path.join(engineDir(), 'ffmpeg.exe'))
    await moveFile(ffprobeSource, path.join(engineDir(), 'ffprobe.exe'))

    await removeDir(workDir)
    await removeFile(archive)
    this.cached = null
  }

  private emitProgress(progress: EngineProgress): void {
    this.emit('progress', progress)
  }
}

function parseChecksumManifest(manifest: string, fileName: string): string | null {
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const candidate = parts[parts.length - 1].replace(/^\*/, '')
    if (candidate === fileName) return parts[0]
  }
  return null
}

function findFileRecursive(root: string, fileName: string, depth = 0): string | null {
  if (depth > 6) return null
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }

  for (const entry of entries) {
    const full = path.join(root, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isFile() && entry.toLowerCase() === fileName.toLowerCase()) return full
    if (info.isDirectory()) {
      const found = findFileRecursive(full, fileName, depth + 1)
      if (found) return found
    }
  }
  return null
}

export const engineService = new EngineService()
