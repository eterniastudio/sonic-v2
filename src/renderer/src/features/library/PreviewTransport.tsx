import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Copy,
  MoreHorizontal,
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
import { Dropdown, DropdownItem, DropdownSeparator } from '@/components/ui/Dropdown'
import { Button, IconButton } from '@/components/ui/Button'
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
    <div data-preview-state="inspecting" className="p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <span className="section-label">TRACK DETAILS</span>
        <IconButton label="Close preview" size="icon-xs" onClick={onClose}><X /></IconButton>
      </div>
      <h2 className="text-[17px] leading-snug font-semibold tracking-[-0.025em] break-words text-fg">{beat.title}</h2>
      <p className="mt-1 text-[12px] text-fg-muted">{beat.producer || beat.sourceChannel || (beat.sourceKind === 'local' ? 'Local audio' : 'Unknown channel')}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-fg-subtle nums">
        <span>{beat.format.toUpperCase()}</span><span>·</span><span>{formatDuration(beat.durationSec)}</span><span>·</span><span>{formatBytes(beat.sizeBytes)}</span>
      </div>

      <div className="my-4 grid grid-cols-[0.8fr_1.2fr] divide-x divide-line border-y border-line py-3.5">
        <div className="pr-3">
          <span className="block text-[10px] font-medium tracking-[0.08em] text-fg-subtle uppercase">Tempo</span>
          <span className="mt-1 block text-[25px] leading-tight font-medium tracking-[-0.04em] text-fg nums">{beat.bpm != null ? formatBpm(beat.bpm) : '—'}<span className="ml-1 text-[10px] tracking-normal text-fg-subtle">BPM</span></span>
          {beat.bpm != null ? <OriginMark origin={bpmDecision.origin} /> : null}
        </div>
        <div className="pl-4">
          <span className="block text-[10px] font-medium tracking-[0.08em] text-fg-subtle uppercase">Musical key</span>
          <span className="mt-2 block text-[15px] leading-tight font-medium tracking-tight text-fg">{beat.key || 'Not analyzed'}{beat.camelot ? <span className="ml-2 text-[11px] text-accent">{beat.camelot}</span> : null}</span>
          {beat.key ? <OriginMark origin={keyDecision.origin} /> : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" className="flex-1" leading={<Play className="fill-current" />} disabled={beat.missing} onClick={() => playOne(beat.id)}>Play this beat</Button>
        <Dropdown align="end" trigger={({ toggle }) => <IconButton label="Beat actions" variant="secondary" onClick={toggle}><MoreHorizontal /></IconButton>}>
          {close => <>
            <DropdownItem icon={<FolderOpen />} onSelect={async () => { await ipc.invoke('library:revealFile', beat.id); close() }}>Reveal in folder</DropdownItem>
            <DropdownItem icon={<ExternalLink />} onSelect={async () => { await ipc.invoke('library:openFile', beat.id); close() }}>Open in default player</DropdownItem>
            <DropdownItem icon={<FileJson />} disabled={beat.sidecarPath == null} onSelect={async () => {
              const opened = await ipc.invoke('library:openSidecarFile', beat.id)
              if (!opened) toast({ kind: 'error', title: 'No sidecar is recorded for this beat.' })
              close()
            }}>Show sidecar JSON</DropdownItem>
            {beat.fileOwnership === 'external' ? <DropdownItem icon={<Copy />} disabled={beat.missing} onSelect={() => { onRequestExport(); close() }}>Export prepared copy</DropdownItem> : null}
            <DropdownSeparator />
            <DropdownItem icon={<Trash2 />} tone="danger" onSelect={() => { onRequestDelete(); close() }}>{beat.fileOwnership === 'external' ? 'Remove from library' : 'Delete this beat'}</DropdownItem>
          </>}
        </Dropdown>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Tooltip label="Tap along to set the tempo"><button type="button" onClick={tap} className="flex h-8 items-center gap-1.5 rounded-[7px] px-2 text-[11px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"><Timer className="size-3.5" />Tap tempo</button></Tooltip>
        {tapBpm != null ? <button type="button" onClick={() => applyBpm(tapBpm)} className="h-7 rounded-[6px] bg-accent-soft px-2 text-[11px] font-medium text-accent" title="Apply the tapped tempo to this beat">Use {tapBpm}</button> : null}
        <span className="flex-1" />
        <Tooltip label="Halve the tempo"><IconButton label="Halve the tempo" size="icon-sm" disabled={beat.bpm == null || beat.bpm / 2 < MIN_BPM} onClick={() => applyBpm((beat.bpm ?? 0) / 2)}><span className="text-[11px] font-medium">½</span></IconButton></Tooltip>
        <Tooltip label="Double the tempo"><IconButton label="Double the tempo" size="icon-sm" disabled={beat.bpm == null || beat.bpm * 2 > MAX_BPM} onClick={() => applyBpm((beat.bpm ?? 0) * 2)}><span className="text-[11px] font-medium">2×</span></IconButton></Tooltip>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <AnalysisStatusBadge beat={beat} />
        <span className="flex-1" />
        <AnalyzeButton beat={beat} />
      </div>
      <MetadataCorrection key={beat.id} beat={beat} />
      {libraryStorage?.error ? <p role="alert" className="mt-3 text-[11px] leading-relaxed text-danger">Library changes could not be saved. {libraryStorage.error}</p> : null}
      <details className="mt-3 border-t border-line pt-3 text-[11px] text-fg-muted">
        <summary className="cursor-pointer font-medium text-fg-muted marker:text-fg-subtle">File &amp; metadata</summary>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[11px]">
          <dt className="text-fg-subtle">Added</dt><dd className="text-right">{formatRelativeTime(beat.addedAt, now)}</dd>
          {beat.sampleRate ? <><dt className="text-fg-subtle">Sample rate</dt><dd className="text-right nums">{formatSampleRate(beat.sampleRate)}</dd></> : null}
          {beat.bitrateKbps ? <><dt className="text-fg-subtle">Bitrate</dt><dd className="text-right nums">{formatBitrate(beat.bitrateKbps)}</dd></> : null}
          {beat.channels ? <><dt className="text-fg-subtle">Channels</dt><dd className="text-right">{formatChannelCount(beat.channels)}</dd></> : null}
          <dt className="text-fg-subtle">Preset</dt><dd className="text-right break-words">{beat.presetId}</dd>
          {beat.detune != null && beat.detune !== 0 ? <><dt className="text-fg-subtle">Detune</dt><dd className="text-right nums">{beat.detune > 0 ? '+' : ''}{beat.detune} ¢</dd></> : null}
        </dl>
        <p className="mt-3 break-all font-mono text-[10px] text-fg-subtle">{beat.fileName}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {beat.fileOwnership === 'external' ? <Badge size="sm" tone="outline">local original</Badge> : null}
          {beat.overrides.length > 0 ? <Badge size="sm" tone="accent">{beat.overrides.length} manual</Badge> : null}
          <Badge size="sm" tone={librarySaved ? 'success' : 'warning'}>{librarySaved ? 'library saved' : libraryStorage ? 'library save pending' : 'library status checking'}</Badge>
          {beat.sidecarPath ? <Badge size="sm" tone={beat.sidecarSync?.status === 'error' ? 'danger' : beat.sidecarSync?.status === 'synced' ? 'success' : 'warning'}>sidecar {beat.sidecarSync?.status ?? 'pending'}</Badge> : null}
          <Badge size="sm" tone={tags === 'current' ? 'success' : tags === 'unknown' ? 'neutral' : 'warning'}>{tags === 'current' ? 'audio tags match' : tags === 'absent' ? 'audio tags absent' : tags === 'out-of-sync' ? 'audio tags need re-export' : 'audio tags unverified'}</Badge>
        </div>
      </details>
      {beat.analysis && beat.analysis.warnings.length > 0 ? <ul className="mt-3 space-y-1">{beat.analysis.warnings.map(warning => <li key={warning} className="flex gap-1.5 text-[11px] leading-relaxed text-warning"><TriangleAlert className="mt-0.5 size-3 shrink-0" /><span className="min-w-0">{warning}</span></li>)}</ul> : null}
    </div>
  )
}
/** Show the decision's real origin, including legacy values with no evidence. */
function OriginMark({ origin }: { origin: FieldOrigin }): ReactNode {
  const label = origin === 'embedded' ? 'tag' : origin === 'description' ? 'description' : origin === 'filename' ? 'filename' : origin === 'title' ? 'title' : origin === 'legacy' ? 'unknown' : origin
  return (
    <span
      title={origin === 'legacy' ? 'Origin was not saved for this older record' : `Source: ${label}`}
      className="mt-1 inline-block text-[9px] tracking-wide text-fg-subtle capitalize"
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
  return <details className="mt-3 border-t border-line pt-3 text-[11px] text-fg-muted"><summary className="cursor-pointer font-medium marker:text-fg-subtle">Correct BPM / key</summary>
    <fieldset disabled={pending} className="mt-3 grid grid-cols-2 gap-2 [&_button]:rounded-[6px] [&_button]:px-2 [&_button]:py-1.5 [&_button]:text-[10px] [&_button]:transition-colors [&_button:disabled]:opacity-40">
      <label className="text-[10px] text-fg-subtle">BPM<input aria-label="Manual BPM" className="mt-1 h-8 w-full rounded-[6px] border border-line bg-surface-2 px-2 text-[12px] text-fg" value={bpm} onChange={event => setDraft(current => ({ ...current, bpm: event.target.value }))} /></label>
      <label className="text-[10px] text-fg-subtle">Key<input aria-label="Manual key" className="mt-1 h-8 w-full rounded-[6px] border border-line bg-surface-2 px-2 text-[12px] text-fg" value={key} onChange={event => setDraft(current => ({ ...current, key: event.target.value }))} /></label>
      <button type="button" disabled={!dirty || pending} onClick={() => void save()} className="col-span-2 bg-accent-soft font-medium text-accent hover:bg-[var(--sonic-accent-line)]">{pending ? 'Saving…' : 'Save corrections'}</button>
      <button type="button" aria-label="Reset BPM to evidence priority" disabled={!beat.overrides.includes('bpm')} className="border border-line hover:bg-surface-2" onClick={() => void save({ kind: 'reset', field: 'bpm' })} title={`Evidence priority: ${bpmDecision.resetOrigin}`}>
        Reset BPM
      </button>
      <button type="button" aria-label="Reset key to evidence priority" disabled={!beat.overrides.includes('key')} className="border border-line hover:bg-surface-2" onClick={() => void save({ kind: 'reset', field: 'key' })} title={`Evidence priority: ${keyDecision.resetOrigin}`}>
        Reset key
      </button>
      <button type="button" disabled={bpmDecision.measuredValue == null} className="hover:bg-surface-2" onClick={() => void save({ kind: 'measured', field: 'bpm' })} title="Choose the audio estimate as a manual correction">Use measured BPM</button>
      <button type="button" disabled={keyDecision.measuredValue == null} className="hover:bg-surface-2" onClick={() => void save({ kind: 'measured', field: 'key' })} title="Choose the audio estimate as a manual correction">Use measured key</button>
    </fieldset>{error ? <p role="alert" className="mt-1 text-danger">{error}</p> : null}
  </details>
}
