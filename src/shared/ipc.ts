/**
 * The typed contract between the renderer and the main process.
 *
 * `IpcMap` is the single source of truth: both sides derive their signatures
 * from it, so adding a channel is a compile error until it is handled.
 */

import type {
  AppInfo,
  BeatMetadata,
  EngineProgress,
  EngineStatus,
  Job,
  LibraryBeat,
  MetadataDraft,
  MetadataField,
  PresetId,
  ProbeResult,
  QueueSnapshot,
  Settings,
  TemplatePreview
} from './domain'
import type { AudioAnalysis } from './analysis'

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'ffprobe'

/** Editable slice of a job — everything a producer can change before export. */
export interface JobPatch {
  presetId?: PresetId
  /** Set one field by hand. Records it as a manual override. */
  metadataEdit?: { field: MetadataField; value: string | number | null }
  /** Return fields to the evidence layers, discarding the manual override. */
  clearOverrides?: MetadataField[]
  /** Promote the analysed value into `final` as an explicit decision. */
  adoptAnalyzed?: MetadataField[]
}

export interface IpcMap {
  'storage:status': { args: []; result: StorageStatus[] }
  'storage:retry': { args: []; result: StorageStatus[] }
  'library:retrySidecar': { args: [id: string]; result: LibraryBeat[] }
  'app:readClipboard': { args: []; result: string }
  'app:info': { args: []; result: AppInfo }
  'app:openDirectory': { args: [kind: 'userData' | 'downloads' | 'engine']; result: boolean }

  'window:minimize': { args: []; result: void }
  'window:toggleMaximize': { args: []; result: boolean }
  'window:close': { args: []; result: void }
  'window:isMaximized': { args: []; result: boolean }

  'engine:status': { args: []; result: EngineStatus }
  'engine:setup': { args: []; result: EngineStatus }
  'engine:pickTool': { args: [name: ToolName]; result: string | null }

  'settings:get': { args: []; result: Settings }
  'settings:patch': { args: [patch: Partial<Settings>]; result: Settings }
  'settings:chooseDir': { args: []; result: string | null }
  'settings:previewTemplate': {
    args: [template: string, presetId: PresetId]
    result: TemplatePreview
  }

  'probe:url': { args: [url: string]; result: ProbeResult }

  'queue:snapshot': { args: []; result: QueueSnapshot }
  'queue:add': { args: [urls: string[]]; result: QueueSnapshot }
  'queue:remove': { args: [id: string]; result: QueueSnapshot }
  'queue:start': { args: [ids: string[] | null]; result: QueueSnapshot }
  'queue:cancel': { args: [id: string]; result: QueueSnapshot }
  'queue:retry': { args: [id: string]; result: QueueSnapshot }
  'queue:setPaused': { args: [paused: boolean]; result: QueueSnapshot }
  'queue:setConcurrency': { args: [value: number]; result: QueueSnapshot }
  'queue:reorder': { args: [ids: string[]]; result: QueueSnapshot }
  'queue:updateJob': { args: [id: string, patch: JobPatch]; result: Job | null }
  'queue:clearFinished': { args: []; result: QueueSnapshot }
  'queue:revealOutput': { args: [id: string]; result: boolean }
  'queue:openOutput': { args: [id: string]; result: boolean }

  'library:list': { args: []; result: LibraryBeat[] }
  'library:openSource': { args: [id: string]; result: boolean }
  'library:refreshSource': { args: [id: string]; result: LibraryBeat[] }
  'library:revealFile': { args: [id: string]; result: boolean }
  'library:openFile': { args: [id: string]; result: boolean }
  'library:openSidecarFile': { args: [id: string]; result: boolean }
  'library:updateMetadata': {
    args: [id: string, patch: Partial<BeatMetadata>, clearOverrides?: MetadataField[]]
    result: LibraryBeat[]
  }
  'library:remove': { args: [id: string, deleteFiles: boolean, expected?: { filePath: string; fingerprint: string }]; result: LibraryBeat[] }

  // --------------------------------------------------------------- analysis
  'analysis:beat': {
    args: [id: string, force: boolean]
    result: { ok: boolean; error: string | null; analysis: AudioAnalysis | null }
  }
  'analysis:cancel': { args: [beatId: string]; result: void }
  'analysis:queueMissing': { args: []; result: { queued: number } }
  'analysis:clearCache': { args: []; result: { cleared: number } }
  'analysis:status': {
    args: []
    result: {
      engine: string
      cacheEntries: number
      running: number
      queued: number
      concurrency: number
      enabled: boolean
    }
  }
  'library:rescan': { args: []; result: LibraryBeat[] }
  'library:reexport': {
    args: [id: string, presetId: PresetId]
    result: { ok: boolean; outputPath: string | null; error: string | null }
  }

  'metadata:parse': {
    args: [{ title?: string | null; description?: string | null; filename?: string | null }]
    result: MetadataDraft
  }
}

/** Push channels, main → renderer. */
export interface IpcEvents {
  'storage:changed': StorageStatus[]
  'queue:changed': QueueSnapshot
  'engine:status': EngineStatus
  'engine:progress': EngineProgress
  'settings:changed': Settings
  'library:changed': LibraryBeat[]
  'app:notice': { kind: 'info' | 'success' | 'error'; message: string }
  'window:maximized': boolean
  /** Analysis progress for a library track or a download job. */
  'analysis:progress': {
    /** Library beat id when analysing an existing track, else null. */
    beatId: string | null
    jobId: string | null
    phase: 'starting' | 'decoding' | 'analyzing' | 'done' | 'failed' | 'cancelled'
    message: string
  }
}

export type IpcChannel = keyof IpcMap
export type IpcEventChannel = keyof IpcEvents

export const IPC_EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'storage:changed',
  'queue:changed',
  'engine:status',
  'engine:progress',
  'settings:changed',
  'library:changed',
  'app:notice',
  'window:maximized',
  'analysis:progress'
] as const

export const IPC_CHANNELS: readonly IpcChannel[] = [
  'storage:status',
  'storage:retry',
  'library:retrySidecar',
  'app:info',
  'app:readClipboard',
  'app:openDirectory',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:isMaximized',
  'engine:status',
  'engine:setup',
  'engine:pickTool',
  'settings:get',
  'settings:patch',
  'settings:chooseDir',
  'settings:previewTemplate',
  'probe:url',
  'queue:snapshot',
  'queue:add',
  'queue:remove',
  'queue:start',
  'queue:cancel',
  'queue:retry',
  'queue:setPaused',
  'queue:setConcurrency',
  'queue:reorder',
  'queue:updateJob',
  'queue:clearFinished',
  'queue:revealOutput',
  'queue:openOutput',
  'library:list',
  'library:openSource',
  'library:refreshSource',
  'library:revealFile',
  'library:openFile',
  'library:openSidecarFile',
  'library:updateMetadata',
  'library:remove',
  'analysis:beat',
  'analysis:cancel',
  'analysis:queueMissing',
  'analysis:clearCache',
  'analysis:status',
  'library:rescan',
  'library:reexport',
  'metadata:parse'
] as const

export interface StorageStatus { file: string; revision: number; persisted: number; error: string | null }
