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
  const artist = beat?.producer || beat?.sourceChannel || (beat?.sourceKind === 'local' ? 'Local audio' : 'Unknown channel')
  const queueLabel = queueContext ? `${queueContext.label} · ${queueContext.index} of ${queueContext.count}` : null
  const statusLabel = playing
    ? 'Now playing'
    : status === 'loading'
      ? 'Loading audio'
      : status === 'paused'
        ? 'Paused'
        : status === 'ended'
          ? 'Finished'
          : status === 'error'
            ? 'Could not play'
            : hasTrack ? 'Ready to play' : 'Player'

  return (
    <section
      aria-label="Audition player"
      data-playback-dock
      data-playback-state={status}
      data-playback-beat-id={beatId ?? ''}
      aria-busy={closing && !saveError}
      className="relative z-10 shrink-0 border-t border-line bg-bg px-5 py-2"
    >
      <div className="grid min-w-0 grid-cols-[minmax(160px,0.95fr)_100px_minmax(180px,1.3fr)_auto] items-center gap-x-5">
        <div className="min-w-0">
          <span className="sr-only" role="status">{statusLabel}</span>
          <p className="truncate text-[12px] font-medium text-fg" title={beat?.title}>
            {beat?.title ?? 'Choose a beat to audition'}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-fg-subtle" title={beat ? [artist, queueLabel].filter(Boolean).join(' · ') : undefined}>
            {beat ? artist : 'Select a track from your Library'}
            {queueLabel ? <><span aria-hidden="true"> · </span><span>{queueLabel}</span></> : null}
          </p>
        </div>

        <div className="flex items-center justify-center gap-0.5">
          <IconButton label="Previous track" size="icon-sm" disabled={closing || !hasTrack} onClick={previous}>
            <SkipBack />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? 'Pause audition' : 'Play audition'}
            disabled={closing || !hasTrack}
            onClick={toggle}
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-full bg-[var(--sonic-primary)] text-[var(--sonic-primary-fg)]',
              'transition-[background-color,transform] duration-[var(--duration-fast)] active:scale-95',
              'hover:bg-[var(--sonic-primary-hover)] disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle'
            )}
          >
            {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 translate-x-px fill-current" />}
          </button>
          <IconButton label="Next track" size="icon-sm" disabled={closing || !hasTrack} onClick={next}>
            <SkipForward />
          </IconButton>
        </div>

        <div className="min-w-0">
          <div className="relative h-[25px] overflow-hidden opacity-65">
            {!hasTrack ? <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-line" /> : null}
            <div className="h-[25px]" data-waveform ref={attachWaveform} />
          </div>
          <div className="flex min-w-0 items-center gap-2 text-[10px] text-fg-subtle nums">
            <span className="w-8 shrink-0">{formatDuration(elapsed)}</span>
            <input
              aria-label="Seek preview"
              type="range"
              className="h-6 min-w-0 flex-1 cursor-pointer disabled:cursor-default"
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
            <span className="w-8 shrink-0 text-right">{formatDuration(length)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="mr-2 flex items-center gap-2">
            <Volume2 aria-hidden="true" className="size-3.5 text-fg-subtle" />
            <input aria-label="Preview volume" type="range" min="0" max="1" step="0.05" value={volume} disabled={closing}
              onChange={event => setVolume(Number(event.target.value))} className="h-6 w-14 cursor-pointer disabled:cursor-default" />
          </div>
          <IconButton label="Repeat track" size="icon-sm" aria-pressed={repeat} className={repeat ? 'text-accent' : undefined}
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
