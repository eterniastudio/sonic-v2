import { create } from 'zustand'
import type {
  AccentId,
  AppInfo,
  BeatMetadata,
  EngineProgress,
  EngineStatus,
  Job,
  LibraryBeat,
  MetadataField,
  PresetId,
  QueueSnapshot,
  Settings
} from '@shared/domain'
import type { IpcEvents, JobPatch } from '@shared/ipc'

/** Directly derived from the push channel, so the two can never drift apart. */
export type AnalysisProgressEvent = IpcEvents['analysis:progress']
import { DEFAULT_PRESET_ID } from '@shared/presets'
import { DEFAULT_NAMING_TEMPLATE } from '@shared/template'
import { ipc } from '../lib/ipc'

export type ViewId = 'download' | 'library' | 'settings'

/** Mirrors the main-process defaults so the first paint is never unstyled. */
const FALLBACK_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'violet',
  reduceMotion: 'system',
  downloadDir: '',
  defaultPresetId: DEFAULT_PRESET_ID,
  namingTemplate: DEFAULT_NAMING_TEMPLATE,
  concurrency: 2,
  autoStart: true,
  channelMode: 'preserve',
  normalizeLufs: null,
  embedTags: true,
  writeSidecar: true,
  sidecarInSubfolder: true,
  embedThumbnail: true,
  analyzeOnDownload: true,
  analysisConcurrency: 1,
  rewriteTagsOnEdit: false,
  ytdlpPath: null,
  ffmpegPath: null,
  ffprobePath: null,
  maxDurationSec: 3600,
  skipExisting: true,
  cookiesFromBrowser: 'none',
  rescanIntervalMs: 120_000
}

interface AppState {
  booted: boolean
  info: AppInfo | null
  settings: Settings
  engine: EngineStatus | null
  engineProgress: EngineProgress | null
  queue: QueueSnapshot
  library: LibraryBeat[]
  view: ViewId
  /** Job currently open in the metadata inspector. */
  selectedJobId: string | null
  commandOpen: boolean
  /** Library entry to scroll to and highlight when the Library view opens. */
  libraryFocusId: string | null
  /** Live analysis progress for a library track, or null. */
  analysisProgress: AnalysisProgressEvent | null

  bootstrap: () => Promise<void>
  setView: (view: ViewId) => void
  setSelectedJob: (id: string | null) => void
  setCommandOpen: (open: boolean) => void
  setLibraryFocus: (id: string | null) => void

  patchSettings: (patch: Partial<Settings>) => Promise<void>
  chooseDownloadDir: () => Promise<void>
  setAccent: (accent: AccentId) => Promise<void>
  cycleTheme: () => Promise<void>
  toggleAutoStart: () => Promise<void>

  setupEngine: () => Promise<void>
  pickTool: (name: 'yt-dlp' | 'ffmpeg' | 'ffprobe') => Promise<void>

  addUrls: (urls: string[]) => Promise<void>
  startJobs: (ids: string[] | null) => Promise<void>
  cancelJob: (id: string) => Promise<void>
  retryJob: (id: string) => Promise<void>
  removeJob: (id: string) => Promise<void>
  clearFinished: () => Promise<void>
  setPaused: (paused: boolean) => Promise<void>
  setConcurrency: (value: number) => Promise<void>
  reorderJobs: (ids: string[]) => Promise<void>
  updateJob: (id: string, patch: JobPatch) => Promise<void>
  setJobPreset: (id: string, presetId: PresetId) => Promise<void>

  rescanLibrary: () => Promise<void>
  updateBeatMetadata: (
    id: string,
    patch: Partial<BeatMetadata>,
    clearOverrides?: MetadataField[]
  ) => Promise<void>
  removeBeat: (id: string, deleteFiles: boolean, expected?: { filePath: string; fingerprint: string }) => Promise<void>
  reexportBeat: (id: string, presetId: PresetId) => Promise<{ ok: boolean; error: string | null }>

  /** Run (or re-run) acoustic analysis on a library track. Never re-downloads. */
  analyzeBeat: (id: string, force?: boolean) => Promise<{ ok: boolean; error: string | null }>
  cancelAnalysis: (beatId: string) => Promise<void>
  /** Queue every track that has never been analysed. Returns how many were queued. */
  analyzeMissing: () => Promise<number>
  clearAnalysisCache: () => Promise<number>
  setAnalysisProgress: (progress: AnalysisProgressEvent | null) => void
}

const EMPTY_QUEUE: QueueSnapshot = { jobs: [], paused: false, concurrency: 2 }

export const useApp = create<AppState>()((set, get) => ({
  booted: false,
  info: null,
  settings: FALLBACK_SETTINGS,
  engine: null,
  engineProgress: null,
  queue: EMPTY_QUEUE,
  library: [],
  view: 'download',
  selectedJobId: null,
  commandOpen: false,
  libraryFocusId: null,
  analysisProgress: null,

  async bootstrap() {
    const [info, settings, engine, queue, library] = await Promise.all([
      ipc.invoke('app:info'),
      ipc.invoke('settings:get'),
      ipc.invoke('engine:status'),
      ipc.invoke('queue:snapshot'),
      ipc.invoke('library:list')
    ])
    set({ info, settings, engine, queue, library, booted: true })
  },

  setView: (view) => set({ view }),
  setSelectedJob: (selectedJobId) => set({ selectedJobId }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setLibraryFocus: (libraryFocusId) => set({ libraryFocusId }),

  async patchSettings(patch) {
    const settings = await ipc.invoke('settings:patch', patch)
    set({ settings })
  },

  async chooseDownloadDir() {
    const chosen = await ipc.invoke('settings:chooseDir', get().settings.downloadDir || null)
    if (chosen) await get().patchSettings({ downloadDir: chosen })
  },

  async setAccent(accent) {
    await get().patchSettings({ accent })
  },

  async cycleTheme() {
    const order: Settings['theme'][] = ['dark', 'light', 'system']
    const current = order.indexOf(get().settings.theme)
    await get().patchSettings({ theme: order[(current + 1) % order.length] })
  },

  async toggleAutoStart() {
    await get().patchSettings({ autoStart: !get().settings.autoStart })
  },

  async setupEngine() {
    const engine = await ipc.invoke('engine:setup')
    set({ engine })
  },

  async pickTool(name) {
    await ipc.invoke('engine:pickTool', name)
  },

  async addUrls(urls) {
    const queue = await ipc.invoke('queue:add', urls)
    set({ queue })
  },

  async startJobs(ids) {
    const queue = await ipc.invoke('queue:start', ids)
    set({ queue })
  },

  async cancelJob(id) {
    const queue = await ipc.invoke('queue:cancel', id)
    set({ queue })
  },

  async retryJob(id) {
    const queue = await ipc.invoke('queue:retry', id)
    set({ queue })
  },

  async removeJob(id) {
    const queue = await ipc.invoke('queue:remove', id)
    set({ queue, selectedJobId: get().selectedJobId === id ? null : get().selectedJobId })
  },

  async clearFinished() {
    const queue = await ipc.invoke('queue:clearFinished')
    set({ queue })
  },

  async setPaused(paused) {
    const queue = await ipc.invoke('queue:setPaused', paused)
    set({ queue })
  },

  async setConcurrency(value) {
    const queue = await ipc.invoke('queue:setConcurrency', value)
    set({ queue, settings: { ...get().settings, concurrency: queue.concurrency } })
  },

  async reorderJobs(ids) {
    const queue = await ipc.invoke('queue:reorder', ids)
    set({ queue })
  },

  async updateJob(id, patch) {
    const job = await ipc.invoke('queue:updateJob', id, patch)
    if (!job) return
    set({ queue: { ...get().queue, jobs: get().queue.jobs.map((entry) => (entry.id === id ? job : entry)) } })
  },

  async setJobPreset(id, presetId) {
    await get().updateJob(id, { presetId })
  },

  async rescanLibrary() {
    const library = await ipc.invoke('library:rescan')
    set({ library })
  },

  async updateBeatMetadata(id, patch, clearOverrides) {
    const library = await ipc.invoke('library:updateMetadata', id, patch, clearOverrides)
    set({ library })
  },

  async analyzeBeat(id, force = false) {
    const result = await ipc.invoke('analysis:beat', id, force)
    // The library list arrives through `library:changed`; nothing to set here.
    return { ok: result.ok, error: result.error }
  },

  async cancelAnalysis(beatId) {
    await ipc.invoke('analysis:cancel', beatId)
  },

  async analyzeMissing() {
    const result = await ipc.invoke('analysis:queueMissing')
    return result.queued
  },

  async clearAnalysisCache() {
    const result = await ipc.invoke('analysis:clearCache')
    return result.cleared
  },

  setAnalysisProgress: (analysisProgress) => set({ analysisProgress }),

  async removeBeat(id, deleteFiles, expected) {
    const library = await ipc.invoke('library:remove', id, deleteFiles, expected)
    set({ library })
  },

  async reexportBeat(id, presetId) {
    const result = await ipc.invoke('library:reexport', id, presetId)
    const library = await ipc.invoke('library:list')
    set({ library })
    return { ok: result.ok, error: result.error }
  }
}))

/** Convenience selector: the job currently open in the inspector. */
export function selectSelectedJob(state: AppState): Job | null {
  if (!state.selectedJobId) return null
  return state.queue.jobs.find((job) => job.id === state.selectedJobId) ?? null
}

/** Metadata of the selected job, or null. */
export function selectSelectedMetadata(state: AppState): BeatMetadata | null {
  return selectSelectedJob(state)?.metadata.final ?? null
}
