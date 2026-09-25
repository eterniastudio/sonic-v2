import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { AudioLines, Check, Play, TriangleAlert } from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import { formatBpm, formatDuration } from '@shared/format'
import { coverArtFor } from '@shared/url'
import { cn } from '@/lib/cn'

/** A quiet, deterministic artwork palette for files without cover art. */
function artworkColor(seed: string): string {
  const tones = ['var(--sonic-artwork-teal)', 'var(--sonic-artwork-brown)', 'var(--sonic-artwork-slate)', 'var(--sonic-artwork-olive)', 'var(--sonic-artwork-green)']
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  return tones[hash % tones.length]
}

function Artwork({ beat, compact = false }: { beat: LibraryBeat; compact?: boolean }): ReactNode {
  const cover = coverArtFor(beat.sourceUrl)
  return <span className="relative block size-full overflow-hidden" style={{ backgroundColor: artworkColor(beat.id) }}>
    {cover ? <img src={cover} alt="" loading="lazy" className="size-full scale-[1.34] object-cover" onError={event => { event.currentTarget.style.display = 'none' }} />
      : <span aria-hidden="true" className="absolute inset-0 grid place-items-center overflow-hidden">
        {!compact ? <>
          <span className="absolute -right-7 -bottom-12 size-48 rounded-full border border-white/10" />
          <span className="absolute -right-1 -bottom-6 size-36 rounded-full border border-white/10" />
          <span className="absolute right-5 bottom-0 size-24 rounded-full border border-white/10" />
        </> : null}
        <AudioLines className={cn('relative text-white/55', compact ? 'size-4' : 'size-8')} strokeWidth={1.2} />
      </span>}
  </span>
}

export interface BeatCardProps {
  beat: LibraryBeat
  layout: 'grid' | 'list'
  selected: boolean
  batchSelected?: boolean
  onSelect: (event: MouseEvent | KeyboardEvent) => void
  onPlay?: () => void
  onToggleSelection?: () => void
  onContextMenu?: (event: MouseEvent) => void
}

export function BeatCard({ beat, layout, selected, batchSelected = false, onSelect, onPlay, onToggleSelection, onContextMenu }: BeatCardProps): ReactNode {
  const credit = beat.producer || beat.sourceChannel || (beat.sourceKind === 'local' ? 'Local audio' : 'Unknown channel')
  const selectionControl = onToggleSelection ? <label className="relative grid size-4 shrink-0 cursor-pointer place-items-center" onClick={event => event.stopPropagation()}>
    <input type="checkbox" checked={batchSelected} aria-checked={batchSelected} aria-label={`Select ${beat.title}`} onChange={onToggleSelection}
      className="peer absolute inset-0 size-full cursor-pointer opacity-0" />
    <span aria-hidden className={cn('pointer-events-none grid size-4 place-items-center rounded-[4px] border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
      batchSelected ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface/90 text-transparent')}><Check className="size-3" strokeWidth={2.5} /></span>
  </label> : null

  if (layout === 'list') {
    return <div data-beat-id={beat.id} onContextMenu={onContextMenu} className={cn(
      'group flex w-full items-center gap-3 border-b border-line/70 px-3 py-2.5',
      'transition-colors duration-[var(--duration-quick)]',
      selected ? 'bg-accent-softer shadow-[inset_2px_0_0_var(--sonic-accent)]' : 'hover:bg-surface-2/70',
      beat.missing && 'opacity-55'
    )}>
      {selectionControl}
      <span className="relative size-10 shrink-0 overflow-hidden rounded-[6px]">
        <Artwork beat={beat} compact />
        {onPlay ? <button type="button" aria-label={`Play ${beat.title}`} disabled={beat.missing}
          onClick={event => { event.stopPropagation(); onPlay() }}
          className="absolute inset-0 grid place-items-center bg-black/25 text-white transition-colors hover:bg-black/50 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-accent disabled:opacity-40">
          <Play className="size-3.5 fill-current" />
        </button> : null}
      </span>
      <button type="button" aria-label={`Preview ${beat.title}`} aria-pressed={selected} onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:rounded-[6px] focus-visible:outline-2 focus-visible:outline-accent">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-fg">{beat.title}</span>
          <span className="mt-0.5 block truncate text-[11px] text-fg-subtle">{credit}</span>
        </span>
        <span className="hidden w-14 shrink-0 text-right text-[12px] text-fg-muted nums @min-[440px]:block">{beat.bpm != null ? formatBpm(beat.bpm) : '—'}</span>
        <span className="hidden w-12 shrink-0 text-right text-[11.5px] text-fg-muted @min-[530px]:block">{beat.camelot ?? '—'}</span>
        <span className="w-11 shrink-0 text-right text-[11.5px] text-fg-subtle nums">{formatDuration(beat.durationSec)}</span>
        <span className="hidden w-12 shrink-0 text-right text-[10px] font-medium tracking-wide text-fg-subtle uppercase @min-[620px]:block">{beat.format}</span>
        {beat.missing ? <TriangleAlert className="size-3.5 shrink-0 text-warning" /> : null}
      </button>
    </div>
  }

  return <div data-beat-id={beat.id} onContextMenu={onContextMenu} className={cn(
    'group relative overflow-hidden rounded-[12px] border bg-surface transition-[border-color,box-shadow] duration-[var(--duration-quick)]',
    selected ? 'border-[var(--sonic-accent-line)] ring-1 ring-[var(--sonic-accent-line)]' : 'border-line hover:border-line-strong hover:shadow-sm',
    beat.missing && 'opacity-55'
  )}>
    <button type="button" aria-label={`Preview ${beat.title}`} aria-pressed={selected} onClick={onSelect}
      className="block w-full text-left focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-accent">
      <span className="relative block aspect-[16/9] w-full overflow-hidden">
        <Artwork beat={beat} />
        <span className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/35 to-transparent" />
        <span className="absolute top-3 right-3 rounded bg-black/25 px-1.5 py-0.5 text-[9px] font-medium tracking-[0.09em] text-white/85 uppercase backdrop-blur-sm">{beat.fileOwnership === 'external' ? 'Local' : beat.format}</span>
        <span className="absolute bottom-3 left-3 text-[10px] font-medium text-white/85 nums">{formatDuration(beat.durationSec)}</span>
        {beat.missing ? <span className="absolute top-10 left-3 flex items-center gap-1 rounded bg-warning px-1.5 py-0.5 text-[10px] font-medium text-black"><TriangleAlert className="size-3" />Missing file</span> : null}
      </span>
      <span className="block px-3.5 pt-3 pb-2.5">
        <span className="block truncate text-[13px] font-semibold tracking-[-0.01em] text-fg" title={beat.title}>{beat.title}</span>
        <span className="mt-1 block truncate text-[11.5px] text-fg-muted" title={credit}>{credit}</span>
        <span className="mt-3 flex items-center gap-2 border-t border-line/80 pt-2.5 text-[10.5px] text-fg-subtle">
          <span className="text-fg-muted nums">{beat.bpm != null ? <><span className="font-medium text-fg">{formatBpm(beat.bpm)}</span> BPM</> : 'No BPM'}</span>
          {beat.camelot ? <><span className="size-0.5 rounded-full bg-fg-subtle/60" /><span className="font-medium text-fg-muted">{beat.camelot}</span></> : null}
          {beat.detune != null && beat.detune !== 0 ? <span>{beat.detune > 0 ? '+' : ''}{beat.detune}¢</span> : null}
          <span className="ml-auto text-[9px] uppercase">{beat.format}</span>
        </span>
      </span>
    </button>
    {selectionControl ? <span className="absolute top-3 left-3 z-10">{selectionControl}</span> : null}
    {onPlay ? <button type="button" aria-label={`Play ${beat.title}`} disabled={beat.missing}
      onClick={event => { event.stopPropagation(); onPlay() }}
      className="absolute top-0 right-0 mt-[calc(56.25%-44px)] mr-3 grid size-8 place-items-center rounded-full border border-white/25 bg-black/35 text-white backdrop-blur-sm transition-colors hover:bg-white hover:text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-30">
      <Play className="size-3.5 translate-x-px fill-current" />
    </button> : null}
  </div>
}
