import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { assertAccepting, ownOperation } from './lifecycle'
import { retryStorage, storageEvents, storageStatus } from './lib/jsonStore'
import type { IpcChannel, IpcMap } from '@shared/ipc'
import { createDraft, parseDeclared } from '@shared/metadata'
import { SAMPLE_METADATA } from '@shared/sample'
import { renderTemplate } from '@shared/template'
import { parseVideoUrl } from '@shared/url'
import { broadcast } from './broadcast'
import { fileExists } from './lib/fsx'
import { libraryAnalysis } from './analysis/libraryAnalysis'
import { engineService } from './services/engine'
import { libraryService } from './services/library'
import { defaultDownloadDir } from './services/paths'
import { probeUrl } from './services/probe'
import { queueService } from './services/queue'
import { reexportBeat } from './services/reexport'
import { settingsService } from './services/settings'
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  syncWindowTheme,
  toggleMaximizeWindow
} from './window'

type Handler<K extends IpcChannel> = (
  ...args: IpcMap[K]['args']
) => IpcMap[K]['result'] | Promise<IpcMap[K]['result']>

/** Registers one channel, with the channel list checked at compile time. */
function handle<K extends IpcChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    const readOnly = /:(get|list|snapshot|status|info|isMaximized|readClipboard|previewTemplate|parse|openSidecar)$/.test(channel)
    if (channel.startsWith('window:') || channel === 'storage:status' || channel === 'storage:retry') return handler(...(args as IpcMap[K]['args']))
    if (!readOnly) assertAccepting()
    return ownOperation(async () => {
      const result = await handler(...(args as IpcMap[K]['args']))
      // Queue progress is optimistic/debounced; user-command acknowledgement is a disk commit.
      if (channel.startsWith('queue:') && !readOnly) queueService.flush()
      return result
    })
  })
}

function isSafeExternal(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export function registerIpcHandlers(): void {
  handle('storage:status', () => storageStatus())
  handle('storage:retry', () => {
    queueService.flush()
    retryStorage()
    broadcast('settings:changed', settingsService.get())
    broadcast('library:changed', libraryService.list())
    return storageStatus()
  })
  handle('library:retrySidecar', id => libraryService.retrySidecar(id))
  handle('app:readClipboard', () => clipboard.readText())
  // ------------------------------------------------------------------ app
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userDataDir: app.getPath('userData'),
    defaultDownloadDir: defaultDownloadDir()
  }))

  handle('app:openExternal', async (url) => {
    if (!isSafeExternal(url)) return false
    await shell.openExternal(url)
    return true
  })

  handle('app:revealPath', (target) => {
    if (!target) return false
    shell.showItemInFolder(target)
    return true
  })

  handle('app:openPath', async (target) => {
    if (!target) return false
    if (!(await fileExists(target))) return false
    const error = await shell.openPath(target)
    return error.length === 0
  })

  // --------------------------------------------------------------- window
  handle('window:minimize', () => {
    minimizeWindow()
  })
  handle('window:toggleMaximize', () => toggleMaximizeWindow())
  handle('window:close', () => {
    closeWindow()
  })
  handle('window:isMaximized', () => isWindowMaximized())

  // --------------------------------------------------------------- engine
  handle('engine:status', () => engineService.status())

  handle('engine:setup', async () => {
    const status = await engineService.setup()
    broadcast('engine:status', status)
    broadcast('app:notice', {
      kind: status.ready ? 'success' : 'error',
      message: status.ready
        ? 'Media engine ready.'
        : (status.lastError ?? 'Some media tools are still missing.')
    })
    return status
  })

  handle('engine:pickTool', async (name) => {
    const label = name === 'yt-dlp' ? 'yt-dlp' : name
    const result = await dialog.showOpenDialog({
      title: `Select the ${label} executable`,
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Executables', extensions: ['exe'] }]
          : [{ name: 'All files', extensions: ['*'] }]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]

    if (name === 'yt-dlp') settingsService.patch({ ytdlpPath: chosen })
    if (name === 'ffmpeg') settingsService.patch({ ffmpegPath: chosen })
    if (name === 'ffprobe') settingsService.patch({ ffprobePath: chosen })

    engineService.invalidate()
    const status = await engineService.status(true)
    broadcast('engine:status', status)
    return chosen
  })

  // ------------------------------------------------------------- settings
  handle('settings:get', () => settingsService.get())

  handle('settings:patch', (patch) => {
    const before = settingsService.get()
    const next = settingsService.patch(patch)

    if (before.rescanIntervalMs !== next.rescanIntervalMs) {
      libraryService.scheduleRescan(next.rescanIntervalMs)
    }
    if (
      before.ytdlpPath !== next.ytdlpPath ||
      before.ffmpegPath !== next.ffmpegPath ||
      before.ffprobePath !== next.ffprobePath
    ) {
      engineService.invalidate()
    }
    if (next.concurrency !== queueService.snapshot().concurrency) {
      queueService.setConcurrency(next.concurrency)
    }

    syncWindowTheme()
    return next
  })

  handle('settings:chooseDir', async (current) => {
    const result = await dialog.showOpenDialog({
      title: 'Choose where Sonic V2 saves your beats',
      defaultPath: current ?? defaultDownloadDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('settings:previewTemplate', (template, presetId) =>
    renderTemplate(template, {
      metadata: SAMPLE_METADATA,
      presetId,
      sourceKind: 'youtube',
      index: 1,
      durationSec: 214
    })
  )

  // ---------------------------------------------------------------- probe
  handle('probe:url', (url) => probeUrl(url))

  // ---------------------------------------------------------------- queue
  handle('queue:snapshot', () => queueService.snapshot())
  handle('queue:add', (urls) => queueService.add(urls))
  handle('queue:remove', (id) => queueService.remove(id))
  handle('queue:start', (ids) => queueService.start(ids))
  handle('queue:cancel', (id) => queueService.cancel(id))
  handle('queue:retry', (id) => queueService.retry(id))
  handle('queue:setPaused', (paused) => queueService.setPaused(paused))
  handle('queue:setConcurrency', (value) => queueService.setConcurrency(value))
  handle('queue:reorder', (ids) => queueService.reorder(ids))
  handle('queue:updateJob', (id, patch) => queueService.updateJob(id, patch))
  handle('queue:clearFinished', () => queueService.clearFinished())

  // -------------------------------------------------------------- library
  handle('library:list', () => libraryService.list())
  handle('library:openSource', async (id) => {
    const url = libraryService.get(id)?.sourceUrl
    if (!url) return false
    const parsed = parseVideoUrl(url)
    if (!parsed.ok || !parsed.normalized) return false
    await shell.openExternal(parsed.normalized)
    return true
  })
  handle('library:refreshSource', async (id) => {
    const beat = libraryService.get(id)
    if (!beat?.sourceUrl) throw new Error('This beat has no saved YouTube link.')
    const result = await probeUrl(beat.sourceUrl)
    if (result.error || !result.uploader) throw new Error(result.error || 'The source did not return a channel name.')
    libraryService.update(id, { sourceChannel: result.uploader })
    if (beat.sidecarPath) await libraryService.retrySidecar(id)
    return libraryService.list()
  })

  handle('library:updateMetadata', (id, patch, clearOverrides) =>
    libraryService.updateMetadata(id, patch, clearOverrides ?? [])
  )

  handle('library:remove', async (id, deleteFiles, expected) => {
    const current = libraryService.get(id)
    if (expected && (!current || current.filePath !== expected.filePath || current.fingerprint !== expected.fingerprint)) throw new Error('This export changed after confirmation opened. Review it and try again.')
    libraryAnalysis.cancel(id)
    const result = await libraryService.remove(id, deleteFiles)
    if (!result.ok && result.reason) {
      throw new Error(result.reason)
    }
    return result.library
  })

  handle('library:rescan', () => libraryService.rescan())

  handle('library:reexport', async (id, presetId) => reexportBeat(id, presetId))

  handle('library:openSidecar', async (id) => {
    const beat = libraryService.get(id)
    if (!beat?.sidecarPath) return null
    if (!(await fileExists(beat.sidecarPath))) return null
    return beat.sidecarPath
  })

  // ------------------------------------------------------------- metadata
  handle('metadata:parse', (sources) => {
    const { values, evidence, bySource } = parseDeclared(sources)
    return createDraft({ declared: values, evidence, sources: bySource })
  })

  // ------------------------------------------------------------- analysis
  handle('analysis:beat', (id, force) => libraryAnalysis.analyze(id, { force }))

  handle('analysis:cancel', (beatId) => {
    libraryAnalysis.cancel(beatId)
  })

  handle('analysis:queueMissing', () => {
    const pending = libraryService.listNeedingAnalysis()
    const queued = libraryAnalysis.queue(pending.map((beat) => beat.id))
    return { queued }
  })

  handle('analysis:clearCache', () => ({ cleared: libraryAnalysis.clearCache() }))

  handle('analysis:status', () => libraryAnalysis.status())
}

/** Subscribes the renderer to service events. */
export function wireServiceEvents(): void {
  storageEvents.on('changed', () => broadcast('storage:changed', storageStatus()))
  libraryService.on('storage-error', (error: string) => broadcast('app:notice', { kind: 'error', message: error }))
  libraryAnalysis.on('storage-error', (error: string) => broadcast('app:notice', { kind: 'error', message: error }))
  queueService.on('persistence-error', (error: string) => broadcast('app:notice', {
    kind: 'error', message: `Queue changes could not be saved to disk: ${error}`
  }))
  queueService.on('changed', (snapshot) => broadcast('queue:changed', snapshot))
  libraryService.on('changed', (beats) => broadcast('library:changed', beats))
  engineService.on('progress', (progress) => broadcast('engine:progress', progress))
  libraryAnalysis.on('progress', (progress) => broadcast('analysis:progress', progress))
  settingsService.on('changed', (settings) => {
    libraryService.scheduleRescan(settings.rescanIntervalMs)
    broadcast('settings:changed', settings)
    syncWindowTheme()
  })
}
