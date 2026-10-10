import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { AudioLines, Check, PanelRightOpen, Play, TriangleAlert } from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import { formatBpm, formatDuration } from '@shared/format'
import { cn } from '@/lib/cn'
import { TrackArtwork } from '@/components/audio/TrackArtwork'
import type { PlaybackState } from '@/features/playback/playbackController'

export interface BeatCardProps {
  beat: LibraryBeat
  layout: 'grid' | 'list'
  selected: boolean
  batchSelected?: boolean
  playbackState?: PlaybackState['status']
  onSelect: (event: MouseEvent | KeyboardEvent) => void
  onPlay?: () => void
  onToggleSelection?: () => void
  onContextMenu?: (event: MouseEvent) => void
}

export function BeatCard({ beat, layout, selected, batchSelected = false, playbackState, onSelect, onPlay, onToggleSelection, onContextMenu }: BeatCardProps): ReactNode {
  const unavailable = beat.missing || !!beat.fileAccessError
  const unavailableLabel = beat.fileAccessError ? `Audio file is unavailable: ${beat.fileAccessError}` : 'Audio file is missing'
  const credit = beat.producer || beat.sourceChannel || (beat.sourceKind === 'local' ? 'Local audio' : 'Unknown channel')
  const playbackLabel = playbackState === 'playing' ? 'Playing' : playbackState === 'paused' ? 'Paused' : playbackState === 'loading' ? 'Loading' : playbackState === 'ended' ? 'Ended' : playbackState === 'error' ? 'Playback error' : playbackState === 'ready' ? 'Ready' : null
  const stateId = `beat-state-${beat.id}`
  const stateDescription = <span id={stateId} className="sr-only">{[selected ? 'Open in details' : null, batchSelected ? 'Selected for batch actions' : null, playbackLabel].filter(Boolean).join('. ')}</span>
  const playbackMark = playbackLabel ? <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-accent"><AudioLines aria-hidden="true" className="size-3" />{playbackLabel}</span> : null
  const selectionControl = onToggleSelection ? <label className="relative grid size-4 shrink-0 cursor-pointer place-items-center" onClick={event => event.stopPropagation()}>
    <input type="checkbox" checked={batchSelected} aria-checked={batchSelected} aria-label={`Select ${beat.title}`} onChange={onToggleSelection}
      className="peer absolute inset-0 size-full cursor-pointer opacity-0" />
    <span aria-hidden className={cn('pointer-events-none grid size-4 place-items-center rounded-[4px] border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
      batchSelected ? 'border-accent bg-accent text-[var(--sonic-accent-fg)]' : 'border-line-strong bg-transparent text-transparent')}><Check className="size-3" strokeWidth={2.5} /></span>
  </label> : null

  if (layout === 'list') {
    return <div data-beat-id={beat.id} data-inspected={selected} data-batch-selected={batchSelected} data-playback-state={playbackState} onContextMenu={onContextMenu} className={cn(
      'group relative flex h-[52px] w-full items-center gap-3 rounded-[5px] px-2',
      'transition-colors duration-[var(--duration-quick)]',
      batchSelected ? 'bg-accent-soft' : selected ? 'bg-surface-2/80' : 'hover:bg-surface-2/50'
    )}>
      {stateDescription}
      {selected ? <span aria-hidden="true" className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-fg-muted" /> : null}
      {selectionControl}
      <span className="relative size-9 shrink-0 overflow-hidden rounded-[5px]">
        <TrackArtwork thumbnail={beat.thumbnail} sourceUrl={beat.sourceUrl} title={beat.title} className="size-full" iconClassName="size-4" />
        {onPlay ? <button type="button" aria-label={`Play ${beat.title}`} disabled={unavailable}
          onClick={event => { event.stopPropagation(); onPlay() }}
          className="absolute inset-0 grid place-items-center bg-surface-3/95 text-fg opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-accent disabled:pointer-events-none">
          <Play className="size-3.5 fill-current" />
        </button> : null}
      </span>
      <button type="button" aria-label={`Preview ${beat.title}`} aria-describedby={stateId} aria-pressed={selected} onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:rounded-[6px] focus-visible:outline-2 focus-visible:outline-accent">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5"><span title={beat.title} className={cn('truncate text-[13px] font-medium', beat.missing ? 'text-fg-muted' : 'text-fg')}>{beat.title}</span>{selected ? <PanelRightOpen aria-hidden="true" className="size-3 shrink-0 text-fg-muted" /> : null}</span>
          <span className="mt-0.5 flex items-center gap-2"><span className="truncate text-[11.5px] text-fg-subtle">{credit}</span>{playbackMark}</span>
        </span>
        <span className="hidden w-14 shrink-0 text-right text-[12px] text-fg-muted nums @min-[440px]:block">{beat.bpm != null ? formatBpm(beat.bpm) : '—'}</span>
        <span className="hidden w-14 shrink-0 text-right text-[11.5px] text-fg-muted @min-[480px]:block">{beat.camelot ?? '—'}</span>
        <span className="w-11 shrink-0 text-right text-[11.5px] text-fg-subtle nums">{formatDuration(beat.durationSec)}</span>
        <span className="hidden w-12 shrink-0 text-right text-[10px] font-medium tracking-wide text-fg-subtle uppercase @min-[620px]:block">{beat.format}</span>
        {unavailable ? <span role="img" aria-label={unavailableLabel} title={unavailableLabel}><TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning" /></span> : null}
      </button>
    </div>
  }

  return <div data-beat-id={beat.id} data-inspected={selected} data-batch-selected={batchSelected} data-playback-state={playbackState} onContextMenu={onContextMenu} className={cn(
    'group relative rounded-[6px] transition-colors duration-[var(--duration-quick)]',
    batchSelected ? 'bg-accent-soft' : selected ? 'bg-surface-2' : 'hover:bg-surface-2/60'
  )}>
    {stateDescription}
    {selected ? <span aria-hidden="true" className="absolute inset-y-4 left-0 w-0.5 rounded-full bg-fg-muted" /> : null}
    <button type="button" aria-label={`Preview ${beat.title}`} aria-describedby={stateId} aria-pressed={selected} onClick={onSelect}
      className="flex h-28 w-full items-center gap-3.5 rounded-[6px] px-3 py-4 text-left focus-visible:outline-2 focus-visible:outline-accent">
      <TrackArtwork thumbnail={beat.thumbnail} sourceUrl={beat.sourceUrl} title={beat.title} className="size-16 rounded-[5px]" iconClassName="size-5" />
      <span className="min-w-0 flex-1 pr-4">
        <span className="flex items-center gap-1.5"><span className="truncate text-[13px] font-medium text-fg" title={beat.title}>{beat.title}</span>{selected ? <PanelRightOpen aria-hidden="true" className="size-3 shrink-0 text-fg-muted" /> : null}</span>
        <span className="mt-1 flex items-center gap-2"><span className="truncate text-[11.5px] text-fg-muted" title={credit}>{credit}</span>{playbackMark}</span>
        <span className="mt-2.5 flex items-center gap-2 text-[10.5px] text-fg-subtle">
          <span className="nums">{beat.bpm != null ? `${formatBpm(beat.bpm)} BPM` : 'No BPM'}</span>
          {beat.camelot ? <><span>·</span><span>{beat.camelot}</span></> : null}
          <span className="ml-auto nums">{formatDuration(beat.durationSec)}</span>
          {unavailable ? <span role="img" aria-label={unavailableLabel} title={unavailableLabel}><TriangleAlert aria-hidden="true" className="size-3 text-warning" /></span> : null}
        </span>
      </span>
    </button>
    {selectionControl ? <span className="absolute top-3 right-3 z-10">{selectionControl}</span> : null}
    {onPlay ? <button type="button" aria-label={`Play ${beat.title}`} disabled={unavailable}
      onClick={event => { event.stopPropagation(); onPlay() }}
      className="absolute top-6 left-3 grid size-16 place-items-center rounded-[5px] bg-surface-3/95 text-fg opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none">
      <Play className="size-3.5 translate-x-px fill-current" />
    </button> : null}
  </div>
}
