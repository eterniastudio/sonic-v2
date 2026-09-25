import type { ReactNode } from 'react'
import { Pause, Play, Repeat, SkipBack, SkipForward, Volume2, X } from 'lucide-react'
import { formatDuration } from '@shared/format'
import { cn } from '@/lib/cn'
import { IconButton } from '@/components/ui/Button'
import { usePlayback } from './playbackSession'

/** Stable shell surface: its waveform node never belongs to a routed view. */
export function PlaybackDock(): ReactNode {
  const playback = usePlayback()
  const {
    beat, beatId, closing, status, current, duration, volume, repeat, queueContext,
    error, saveError, attachWaveform, previous, next, toggle, stop, seek, checkpointNow,
    setVolume, setRepeat, retrySave
  } = playback
  const hasTrack = beatId != null
  const playing = status === 'playing'
  const seekingAllowed = hasTrack && ['ready', 'playing', 'paused', 'ended'].includes(status)
  const elapsed = Math.max(0, Number.isFinite(current) ? current : 0)
  const length = Math.max(0, Number.isFinite(duration) && duration > 0 ? duration : beat?.durationSec ?? 0)

  return (
    <section
      aria-label="Audition player"
      data-playback-dock
      data-playback-state={status}
      data-playback-beat-id={beatId ?? ''}
      aria-busy={closing && !saveError}
      className="relative z-10 shrink-0 border-t border-line bg-surface px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label="Previous track" size="icon-sm" disabled={closing || !hasTrack} onClick={previous}>
            <SkipBack />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? 'Pause audition' : 'Play audition'}
            disabled={closing || !hasTrack}
            onClick={toggle}
            className={cn(
              'grid size-9 place-items-center rounded-full bg-accent text-accent-fg shadow-accent',
              'transition-[background-color,transform] duration-[var(--duration-fast)] active:scale-95',
              'hover:bg-[var(--sonic-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
          </button>
          <IconButton label="Next track" size="icon-sm" disabled={closing || !hasTrack} onClick={next}>
            <SkipForward />
          </IconButton>
        </div>

        <div className="min-w-[150px] flex-1">
          <div className="flex min-w-0 items-baseline gap-2 text-[12px]">
            <span className="truncate font-medium text-fg">{beat?.title ?? 'Choose a beat to audition'}</span>
            {beat ? <span className="hidden truncate text-fg-muted sm:inline">· {beat.producer || beat.sourceChannel || (beat.sourceKind === 'local' ? 'Local audio' : 'Unknown channel')}</span> : null}
          </div>
          <div className="mt-1 h-[25px] overflow-hidden rounded-[4px]" data-waveform ref={attachWaveform} />
          {queueContext ? (
            <div className="mt-0.5 truncate text-[10.5px] text-fg-subtle">
              {queueContext.label} · {queueContext.index} of {queueContext.count}
            </div>
          ) : null}
        </div>

        <div className="flex min-w-[180px] flex-1 items-center gap-2 text-[10.5px] text-fg-muted nums sm:max-w-[270px]">
          <span className="w-9 text-right">{formatDuration(elapsed)}</span>
          <input
            aria-label="Seek preview"
            type="range"
            className="min-w-0 flex-1"
            min="0"
            max={Math.max(1, length)}
            step="0.1"
            value={Math.min(elapsed, Math.max(1, length))}
            disabled={closing || !seekingAllowed}
            onChange={event => seek(Number(event.target.value))}
            onPointerUp={checkpointNow}
            onKeyUp={checkpointNow}
            onBlur={checkpointNow}
          />
          <span className="w-9">{formatDuration(length)}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Volume2 aria-hidden="true" className="size-3.5 text-fg-subtle" />
          <input aria-label="Preview volume" type="range" min="0" max="1" step="0.05" value={volume} disabled={closing}
            onChange={event => setVolume(Number(event.target.value))} className="w-16" />
          <IconButton label="Repeat track" size="icon-sm" aria-pressed={repeat} variant={repeat ? 'quiet' : 'ghost'}
            disabled={closing || !hasTrack} onClick={() => setRepeat(!repeat)}><Repeat /></IconButton>
          <IconButton label="Stop playback" size="icon-sm" disabled={closing || (!hasTrack && status !== 'error')} onClick={stop}><X /></IconButton>
        </div>
      </div>
      {closing && !saveError ? <p role="status" className="mt-1 text-[11px] text-fg-muted">Finishing listening save…</p> : null}
      {error ? <p role="alert" className="mt-1 text-[11px] text-danger">{error}</p> : null}
      {saveError ? <div className="mt-1 flex items-center gap-2 text-[11px] text-warning">
        <span>Listening state was not saved: {saveError}</span>
        <button type="button" onClick={() => { void retrySave().catch(() => undefined) }} className="underline underline-offset-2">Retry save</button>
      </div> : null}
    </section>
  )
}
