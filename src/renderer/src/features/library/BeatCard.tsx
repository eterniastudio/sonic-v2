import type { MouseEvent, ReactNode } from 'react'
import { Play, TriangleAlert } from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import { formatBpm, formatDuration } from '@shared/format'
import { coverArtFor } from '@shared/url'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/Badge'
import { TiltCard } from '@/components/ui/TiltCard'

/** Deterministic gradient stand-in when a beat has no artwork. */
function fallbackGradient(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360
  }
  return `linear-gradient(135deg, hsl(${hash} 52% 26%), hsl(${(hash + 48) % 360} 46% 14%))`
}

export interface BeatCardProps {
  beat: LibraryBeat
  layout: 'grid' | 'list'
  selected: boolean
  onSelect: () => void
  onContextMenu?: (event: MouseEvent) => void
}

export function BeatCard({ beat, layout, selected, onSelect, onContextMenu }: BeatCardProps): ReactNode {
  const cover = coverArtFor(beat.sourceUrl)

  if (layout === 'list') {
    return (
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={onContextMenu}
        data-beat-id={beat.id}
        className={cn(
          'flex w-full items-center gap-3 rounded-[10px] border px-2.5 py-2 text-left',
          'transition-[border-color,background-color] duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
          selected
            ? 'border-[var(--sonic-accent-line)] bg-accent-softer'
            : 'border-transparent hover:border-line hover:bg-surface-2',
          beat.missing && 'opacity-55'
        )}
      >
        <span
          className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[7px]"
          style={cover ? undefined : { background: fallbackGradient(beat.id) }}
        >
          {cover ? (
            <img src={cover} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <Play className="size-3.5 text-white/70" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{beat.title}</span>
          <span className="block truncate text-[11.5px] text-fg-muted">
            {beat.producer || beat.sourceChannel || 'Unknown channel'}
          </span>
        </span>

        <span className="hidden w-20 shrink-0 text-right text-[11.5px] text-fg-muted nums sm:block">
          {beat.bpm != null ? `${formatBpm(beat.bpm)}` : '—'}
        </span>
        <span className="hidden w-16 shrink-0 text-right text-[11.5px] text-fg-muted sm:block">
          {beat.camelot ?? '—'}
        </span>
        <span className="w-14 shrink-0 text-right text-[11.5px] text-fg-muted nums">
          {formatDuration(beat.durationSec)}
        </span>
        <span className="w-12 shrink-0 text-right text-[10.5px] font-medium tracking-wide text-fg-subtle uppercase">
          {beat.format}
        </span>

        {beat.missing ? <TriangleAlert className="size-3.5 shrink-0 text-warning" /> : null}
      </button>
    )
  }

  return (
    <TiltCard
      className={cn('rounded-[12px]', beat.missing && 'opacity-55')}
      glare={!beat.missing}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <div
        data-beat-id={beat.id}
        className={cn(
          'group flex h-full flex-col overflow-hidden rounded-[12px] border bg-surface',
          'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
          selected ? 'border-[var(--sonic-accent-line)]' : 'border-line'
        )}
      >
        <div
          className="relative aspect-video w-full overflow-hidden"
          style={cover ? undefined : { background: fallbackGradient(beat.id) }}
        >
          {cover ? (
            <img
              src={cover}
              alt=""
              loading="lazy"
              className="size-full scale-[1.34] object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none'
              }}
            />
          ) : null}

          <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />

          <span className="absolute right-2 bottom-2 flex items-center gap-1">
            <span className="rounded-[5px] bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm">
              {beat.format.toUpperCase()}
            </span>
            <span className="rounded-[5px] bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white/90 nums backdrop-blur-sm">
              {formatDuration(beat.durationSec)}
            </span>
          </span>

          {beat.missing ? (
            <span className="absolute top-2 left-2 flex items-center gap-1 rounded-[5px] bg-warning px-1.5 py-0.5 text-[10px] font-semibold text-black">
              <TriangleAlert className="size-2.5" />
              MISSING
            </span>
          ) : null}

          {/* Play affordance appears on hover and stays put when selected. */}
          <span
            className={cn(
              'absolute top-1/2 left-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full',
              'bg-white/15 text-white backdrop-blur-md transition-[opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]',
              selected ? 'scale-100 opacity-100' : 'scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100'
            )}
          >
            <Play className="size-4 translate-x-px" />
          </span>

          {selected ? (
            <span className="absolute inset-0 ring-2 ring-inset ring-[var(--sonic-accent)]" />
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-2.5">
          <div className="truncate text-[12.5px] font-medium text-fg" title={beat.title}>
            {beat.title}
          </div>
          <div className="truncate text-[11px] text-fg-muted" title={beat.producer || beat.sourceChannel || undefined}>
            {beat.producer || beat.sourceChannel || 'Unknown channel'}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1">
            {beat.bpm != null ? <Badge size="sm">{formatBpm(beat.bpm)} BPM</Badge> : null}
            {beat.camelot ? (
              <Badge size="sm" tone="accent">
                {beat.camelot}
              </Badge>
            ) : null}
            {beat.detune != null && beat.detune !== 0 ? (
              <Badge size="sm">
                {beat.detune > 0 ? '+' : ''}
                {beat.detune}¢
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
    </TiltCard>
  )
}
