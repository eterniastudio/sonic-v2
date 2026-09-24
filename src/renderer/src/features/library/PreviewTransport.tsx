import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Copy,
  ExternalLink,
  FileJson,
  FolderOpen,
  Play,
  Timer,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import type { StorageStatus } from '@shared/ipc'
import { analyzedValuesFrom, describeAnalysisStatus } from '@shared/analysis'
import { decideMetadataField, publishedTagStatus, BPM_MIN as MIN_BPM, BPM_MAX as MAX_BPM, type FieldOrigin } from '@shared/metadata'
import { parseKeyString } from '@shared/music'
import { formatBitrate, formatBpm, formatBytes, formatChannelCount, formatDuration, formatRelativeTime, formatSampleRate } from '@shared/format'
import { ipc } from '@/lib/ipc'
import { useIpcEvent, useNow } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { Badge } from '@/components/ui/Badge'
import { CircleMenu } from '@/components/obsidian/CircleMenu'
import { IconButton } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { toast } from '@/components/ui/Toaster'
import { usePlaybackActions } from '@/features/playback/playbackSession'

/** Metadata inspector. Audio belongs to the persistent shell player. */
export function PreviewTransport({
  beat,
  onClose,
  onRequestDelete,
  onRequestExport
}: {
  beat: LibraryBeat
  onClose: () => void
  onRequestDelete: () => void
  onRequestExport: () => void
}): ReactNode {
  const { playOne } = usePlaybackActions()
  const updateBeatMetadata = useApp((state) => state.updateBeatMetadata)
  const now = useNow(30_000)
  const [storage, setStorage] = useState<StorageStatus[]>([])
  useIpcEvent('storage:changed', setStorage)
  useEffect(() => { void ipc.invoke('storage:status').then(setStorage).catch(() => undefined) }, [])
  const libraryStorage = storage.find(item => /[\\/]library\.json$/i.test(item.file))
  const librarySaved = libraryStorage != null && !libraryStorage.error && libraryStorage.persisted >= libraryStorage.revision
  const evidenceInput = { current: beat, overrides: beat.overrides, sources: beat.sources,
    embedded: beat.embedded, analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {} }
  const bpmDecision = decideMetadataField('bpm', evidenceInput)
  const keyDecision = decideMetadataField('key', evidenceInput)
  const tags = publishedTagStatus(beat, beat.publishedTags)

  const tapTimes = useRef<number[]>([])

  const [tapBpm, setTapBpm] = useState<number | null>(null)

  const applyBpm = (next: number | null): void => {
    if (next == null) return
    const clamped = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(next * 10) / 10))
    void updateBeatMetadata(beat.id, { bpm: clamped }).catch(error => toast({ kind: 'error', title: 'Tempo was not fully saved', description: String(error) }))
  }

  const tap = (): void => {
    const now = performance.now()
    const recent = tapTimes.current.filter((time) => now - time < 2600)
    recent.push(now)
    tapTimes.current = recent

    if (recent.length < 2) {
      setTapBpm(null)
      return
    }

    const intervals: number[] = []
    for (let index = 1; index < recent.length; index += 1) {
      intervals.push(recent[index] - recent[index - 1])
    }
    const average = intervals.reduce((total, value) => total + value, 0) / intervals.length
    const bpm = Math.round(60000 / average)
    setTapBpm(bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null)
  }

  return (
    <div
      data-preview-state="inspecting"
      className="shrink-0 rounded-[14px] border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[180px] flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-fg">{beat.title}</span>
            {beat.producer ? (
              <span className="truncate text-[11.5px] text-fg-muted">· {beat.producer}</span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle nums">
            <span className="text-fg-muted">{formatDuration(beat.durationSec)}</span>
            <span>·</span>
            <span>{beat.format.toUpperCase()}</span>
            {beat.bitrateKbps ? (
              <>
                <span>·</span>
                <span>{formatBitrate(beat.bitrateKbps)}</span>
              </>
            ) : null}
            {beat.sampleRate ? (
              <>
                <span>·</span>
                <span>{formatSampleRate(beat.sampleRate)}</span>
              </>
            ) : null}
            {beat.channels ? (
              <>
                <span>·</span>
                <span>{formatChannelCount(beat.channels)}</span>
              </>
            ) : null}
            <span>·</span>
            <span>{formatBytes(beat.sizeBytes)}</span>
            <span>·</span>
            <span>added {formatRelativeTime(beat.addedAt, now)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" disabled={beat.missing} onClick={() => playOne(beat.id)}
            className="flex h-8 items-center gap-1.5 rounded-[8px] bg-accent-soft px-2.5 text-[11.5px] font-medium text-accent transition-colors hover:bg-[var(--sonic-accent-line)] disabled:opacity-40">
            <Play className="size-3.5" /> Play this beat
          </button>
          <Tooltip label="Tap along to set the tempo">
            <button
              type="button"
              onClick={tap}
              className="flex h-8 items-center gap-1.5 rounded-[8px] border border-line bg-surface-2 px-2.5 text-[11.5px] text-fg-muted transition-colors duration-[var(--duration-quick)] hover:border-line-strong hover:text-fg"
            >
              <Timer className="size-3.5" />
              Tap
            </button>
          </Tooltip>

          {tapBpm != null ? (
            <button
              type="button"
              onClick={() => applyBpm(tapBpm)}
              className="h-8 rounded-[8px] bg-accent-soft px-2.5 text-[11.5px] font-medium text-accent transition-colors duration-[var(--duration-quick)] hover:bg-[var(--sonic-accent-line)]"
              title="Apply the tapped tempo to this beat"
            >
              Use {tapBpm}
            </button>
          ) : null}
        </div>

        <span className="mx-0.5 h-7 w-px shrink-0 bg-line" />

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label="Halve the tempo">
            <IconButton
              label="Halve the tempo"
              size="icon-sm"
              variant="ghost"
              disabled={beat.bpm == null || beat.bpm / 2 < MIN_BPM}
              onClick={() => applyBpm((beat.bpm ?? 0) / 2)}
            >
              <span className="text-[11px] font-semibold">½</span>
            </IconButton>
          </Tooltip>
          <Tooltip label="Double the tempo">
            <IconButton
              label="Double the tempo"
              size="icon-sm"
              variant="ghost"
              disabled={beat.bpm == null || beat.bpm * 2 > MAX_BPM}
              onClick={() => applyBpm((beat.bpm ?? 0) * 2)}
            >
              <span className="text-[11px] font-semibold">2×</span>
            </IconButton>
          </Tooltip>

          <span className="mx-0.5 h-7 w-px bg-line" />

          <Tooltip label={beat.fileOwnership === 'external' ? 'Open, export or remove from library' : 'Reveal, open or delete this beat'}>
            <span>
              <CircleMenu
                label="Beat actions"
                radius={72}
                items={[
                  {
                    id: 'reveal',
                    label: 'Reveal in folder',
                    icon: <FolderOpen />,
                    onSelect: () => ipc.invoke('library:revealFile', beat.id)
                  },
                  {
                    id: 'open',
                    label: 'Open in default player',
                    icon: <ExternalLink />,
                    onSelect: () => ipc.invoke('library:openFile', beat.id)
                  },
                  {
                    id: 'sidecar',
                    label: 'Show sidecar JSON',
                    icon: <FileJson />,
                    disabled: beat.sidecarPath == null,
                    onSelect: () => ipc.invoke('library:openSidecarFile', beat.id).then((opened) => {
                      if (!opened) toast({ kind: 'error', title: 'No sidecar is recorded for this beat.' })
                    })
                  },
                  ...(beat.fileOwnership === 'external' ? [{
                    id: 'export',
                    label: 'Export prepared copy',
                    icon: <Copy />,
                    disabled: beat.missing,
                    onSelect: onRequestExport
                  }] : []),
                  {
                    id: 'delete',
                    label: beat.fileOwnership === 'external' ? 'Remove from library' : 'Delete this beat',
                    icon: <Trash2 />,
                    tone: 'danger',
                    onSelect: onRequestDelete
                  }
                ]}
              />
            </span>
          </Tooltip>
          <Tooltip label="Close">
            <IconButton label="Close preview" size="icon-sm" onClick={onClose}>
              <X />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
        {beat.bpm != null ? (
          <Badge size="sm" tone="accent">
            {formatBpm(beat.bpm)} BPM
            <OriginMark origin={bpmDecision.origin} />
          </Badge>
        ) : null}
        {beat.key ? (
          <Badge size="sm">
            {beat.key}
            <OriginMark origin={keyDecision.origin} />
          </Badge>
        ) : null}
        {beat.camelot ? <Badge size="sm">{beat.camelot}</Badge> : null}
        {beat.detune != null && beat.detune !== 0 ? (
          <Badge size="sm">
            {beat.detune > 0 ? '+' : ''}
            {beat.detune} ¢
          </Badge>
        ) : null}
        <Badge size="sm" tone="outline">
          {beat.presetId}
        </Badge>
        {beat.fileOwnership === 'external' ? <Badge size="sm" tone="outline">local original</Badge> : null}

        <AnalysisStatusBadge beat={beat} />
        {beat.overrides.length > 0 ? (
          <Badge size="sm" tone="accent">
            {beat.overrides.length} manual
          </Badge>
        ) : null}
        <Badge size="sm" tone={librarySaved ? 'success' : 'warning'}>
          {librarySaved ? 'library saved' : libraryStorage ? 'library save pending' : 'library status checking'}
        </Badge>
        {beat.sidecarPath ? <Badge size="sm" tone={beat.sidecarSync?.status === 'error' ? 'danger' : beat.sidecarSync?.status === 'synced' ? 'success' : 'warning'}>
          sidecar {beat.sidecarSync?.status ?? 'pending'}
        </Badge> : null}
        <Badge size="sm" tone={tags === 'current' ? 'success' : tags === 'unknown' ? 'neutral' : 'warning'}>
          {tags === 'current' ? 'audio tags match' : tags === 'absent' ? 'audio tags absent' : tags === 'out-of-sync' ? 'audio tags need re-export' : 'audio tags unverified'}
        </Badge>

        <span className="flex-1" />

        <AnalyzeButton beat={beat} />

        <span className="truncate font-mono text-[10.5px] text-fg-subtle" title={beat.fileName}>
          {beat.fileName}
        </span>
      </div>

      <MetadataCorrection key={beat.id} beat={beat} />
      {beat.analysis && beat.analysis.warnings.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {beat.analysis.warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5 text-[11px] leading-relaxed text-warning">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Show the decision's real origin, including legacy values with no evidence. */
function OriginMark({ origin }: { origin: FieldOrigin }): ReactNode {
  const label = origin === 'embedded' ? 'tag' : origin === 'description' ? 'description' : origin === 'filename' ? 'filename' : origin === 'title' ? 'title' : origin === 'legacy' ? 'unknown' : origin
  return (
    <span
      title={origin === 'legacy' ? 'Origin was not saved for this older record' : `Source: ${label}`}
      className="ml-1 rounded-[3px] bg-[var(--sonic-accent-line)] px-1 text-[9px] font-semibold tracking-wide text-fg uppercase"
    >
      {label}
    </span>
  )
}

function AnalysisStatusBadge({ beat }: { beat: LibraryBeat }): ReactNode {
  const tone: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
    'not-analyzed': 'neutral',
    queued: 'neutral',
    analyzing: 'accent',
    estimated: 'success',
    partial: 'accent',
    inconclusive: 'warning',
    failed: 'danger',
    cancelled: 'neutral'
  }
  const mismatch = beat.verification?.summary.mismatch ?? 0

  return (
    <>
      <Badge size="sm" tone={tone[beat.analysisStatus] ?? 'neutral'}>
        {describeAnalysisStatus(beat.analysisStatus).toLowerCase()}
      </Badge>
      {mismatch > 0 ? (
        <Badge size="sm" tone="warning" icon={<TriangleAlert />}>
          source disagrees with audio
        </Badge>
      ) : null}
    </>
  )
}

/** Analyze / re-analyze / cancel, driven entirely by real state. */
function AnalyzeButton({ beat }: { beat: LibraryBeat }): ReactNode {
  const analyzeBeat = useApp((state) => state.analyzeBeat)
  const cancelAnalysis = useApp((state) => state.cancelAnalysis)

  if (beat.analysisStatus === 'analyzing' || beat.analysisStatus === 'queued') {
    return (
      <button
        type="button"
        onClick={() => void cancelAnalysis(beat.id)}
        className="h-7 rounded-[8px] border border-line bg-surface-2 px-2.5 text-[11.5px] text-fg-muted transition-colors duration-[var(--duration-quick)] hover:border-line-strong hover:text-fg"
      >
        Cancel analysis
      </button>
    )
  }

  const reanalyze = beat.analysis != null

  return (
    <button
      type="button"
      disabled={beat.missing}
      onClick={() => {
        void analyzeBeat(beat.id, reanalyze).then((result) => {
          if (!result.ok && result.error) {
            toast({ kind: 'error', title: 'Analysis failed', description: result.error })
          } else if (result.ok) {
            toast({ kind: 'success', title: `Analyzed ${beat.title}` })
          }
        })
      }}
      className="h-7 rounded-[8px] bg-accent-soft px-2.5 text-[11.5px] font-medium text-accent transition-colors duration-[var(--duration-quick)] hover:bg-[var(--sonic-accent-line)] disabled:pointer-events-none disabled:opacity-40"
    >
      {reanalyze ? 'Re-analyze' : 'Analyze audio'}
    </button>
  )
}

export function MetadataCorrection({ beat }: { beat: LibraryBeat }): ReactNode {
  const update = useApp(state => state.updateBeatMetadata)
  const evidenceInput = { current: beat, overrides: beat.overrides, sources: beat.sources,
    embedded: beat.embedded, analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {} }
  const bpmDecision = decideMetadataField('bpm', evidenceInput)
  const keyDecision = decideMetadataField('key', evidenceInput)
  // null means untouched; an empty string is an intentional manual clearing.
  // Read untouched values directly from the latest record so an analysis update
  // cannot freeze the other field or accidentally turn it into an override.
  const [draft, setDraft] = useState<{ bpm: string | null; key: string | null }>({ bpm: null, key: null })
  const bpm = draft.bpm ?? (beat.bpm == null ? '' : String(beat.bpm))
  const key = draft.key ?? beat.key ?? ''
  const dirty = draft.bpm !== null || draft.key !== null
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState('')
  const save = async (action?: { kind: 'reset' | 'measured'; field: 'bpm' | 'key' }): Promise<void> => {
    if (pendingRef.current) return
    const patch: { bpm?: number | null; key?: string | null } = {}
    if (!action && draft.bpm !== null) {
      const value = draft.bpm.trim()
      if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < MIN_BPM || Number(value) > MAX_BPM)) {
        setError(`Tempo must be ${MIN_BPM}–${MAX_BPM} BPM.`)
        return
      }
      patch.bpm = value === '' ? null : Number(value)
    }
    if (!action && draft.key !== null) {
      const value = draft.key.trim()
      const parsed = parseKeyString(value)
      if (value !== '' && !parsed) {
        setError('Enter a key with its mode (for example F# minor) or a Camelot code (11A).')
        return
      }
      patch.key = parsed?.key ?? null
    }
    if (action?.kind === 'measured') {
      const measured = action.field === 'bpm' ? bpmDecision.measuredValue : keyDecision.measuredValue
      if (measured == null) { setError('No measured value is available for this field.'); return }
      if (action.field === 'bpm') patch.bpm = Number(measured)
      else patch.key = String(measured)
    }
    pendingRef.current = true
    setPending(true); setError('')
    try {
      await update(beat.id, patch, action?.kind === 'reset' ? action.field === 'key' ? ['key', 'camelot'] : ['bpm', 'altBpm'] : undefined)
      setDraft(current => action ? { ...current, [action.field]: null } : { bpm: null, key: null })
    } catch (failure) {
      // A rejected operation can still have committed the library before an
      // optional output failed. Keep the submitted draft and explain the error;
      // do not infer success from a coincidentally matching incoming value.
      setError(String(failure))
    } finally { pendingRef.current = false; setPending(false) }
  }
  return <details className="mt-2 text-xs text-fg-muted"><summary className="cursor-pointer">Correct BPM / key</summary>
    <fieldset disabled={pending} className="mt-2 flex flex-wrap items-center gap-2">
      <label>BPM <input aria-label="Manual BPM" className="w-20 rounded border border-line bg-surface px-2 py-1" value={bpm} onChange={event => setDraft(current => ({ ...current, bpm: event.target.value }))} /></label>
      <label>Key <input aria-label="Manual key" className="w-28 rounded border border-line bg-surface px-2 py-1" value={key} onChange={event => setDraft(current => ({ ...current, key: event.target.value }))} /></label>
      <button type="button" disabled={!dirty || pending} onClick={() => void save()} className="rounded bg-accent-soft px-3 py-1 text-accent">{pending ? 'Saving…' : 'Save corrections'}</button>
      <button type="button" disabled={!beat.overrides.includes('bpm')} onClick={() => void save({ kind: 'reset', field: 'bpm' })} title={`Evidence priority: ${bpmDecision.resetOrigin}`}>
        Reset BPM to evidence priority
      </button>
      <button type="button" disabled={!beat.overrides.includes('key')} onClick={() => void save({ kind: 'reset', field: 'key' })} title={`Evidence priority: ${keyDecision.resetOrigin}`}>
        Reset key to evidence priority
      </button>
      <button type="button" disabled={bpmDecision.measuredValue == null} onClick={() => void save({ kind: 'measured', field: 'bpm' })} title="Choose the audio estimate as a manual correction">Use measured BPM</button>
      <button type="button" disabled={keyDecision.measuredValue == null} onClick={() => void save({ kind: 'measured', field: 'key' })} title="Choose the audio estimate as a manual correction">Use measured key</button>
    </fieldset>{error ? <p role="alert" className="mt-1 text-danger">{error}</p> : null}
  </details>
}
