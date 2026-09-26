import { useMemo, type ReactNode } from 'react'
import { Pause, Play, Repeat, SkipBack, SkipForward, Volume2, X } from 'lucide-react'
import { analyzedValuesFrom } from '@shared/analysis'
import { formatBpm, formatDuration } from '@shared/format'
import { decideMetadataField, type FieldOrigin } from '@shared/metadata'
import { cn } from '@/lib/cn'
import { TrackArtwork } from '@/components/audio/TrackArtwork'
import { IconButton } from '@/components/ui/Button'
import { usePlayback } from './playbackSession'

const ORIGINS: Record<FieldOrigin, { label: string; description: string }> = {
  manual: { label: 'manual', description: 'Set manually' },
  title: { label: 'title', description: 'From the source title' },
  description: { label: 'description', description: 'From the source description' },
  filename: { label: 'filename', description: 'From the audio filename' },
  embedded: { label: 'tag', description: 'From embedded audio tags' },
  audio: { label: 'audio', description: 'Measured from the audio' },
  legacy: { label: 'source unknown', description: 'Origin was not recorded for this value' },
  none: { label: 'source unknown', description: 'No source is recorded for this value' }
}

function TrackValue({ value, unknown, origin }: { value: string | null; unknown: string; origin: FieldOrigin }): ReactNode {
  return (
    <span className="flex min-w-0 items-baseline gap-1" title={value ? `${value} · ${ORIGINS[origin].description}` : unknown}>
      <span className={cn('shrink-0 whitespace-nowrap nums', value ? 'font-medium text-fg-muted' : 'text-fg-subtle')}>{value ?? unknown}</span>
      {value ? <span className="truncate text-[10px] text-fg-subtle">{ORIGINS[origin].label}</span> : null}
    </span>
  )
}

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
  const provenance = useMemo(() => {
    if (!beat) return null
    const evidence = {
      current: beat,
      overrides: beat.overrides,
      sources: beat.sources,
      embedded: beat.embedded,
      analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {}
    }
    return {
      bpm: decideMetadataField('bpm', evidence).origin,
      key: decideMetadataField(beat.key ? 'key' : 'camelot', evidence).origin
    }
  }, [beat])
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
      className="relative z-10 shrink-0 border-t border-line-strong bg-[var(--sonic-transport)] px-5 py-3"
    >
      <div className="grid min-w-0 grid-cols-[minmax(260px,1.1fr)_112px_minmax(180px,1.15fr)_auto] items-center gap-x-4">
        <div className="flex min-w-0 items-center gap-3">
          <TrackArtwork sourceUrl={beat?.sourceUrl} title={beat?.title ?? 'No track selected'}
            className="size-[52px] shrink-0 rounded-[8px] border border-line" iconClassName="size-5" />
          <div className="min-w-0 flex-1">
            <span className="sr-only" role="status">{statusLabel}</span>
            <p className="truncate text-[13px] leading-[18px] font-semibold tracking-[-0.015em] text-fg" title={beat?.title}>
              {beat?.title ?? 'Choose a beat to audition'}
            </p>
            <p className="truncate text-[11px] leading-4 text-fg-muted" title={beat ? [artist, queueLabel].filter(Boolean).join(' · ') : undefined}>
              {beat ? artist : 'Select a track from your Library'}
              {queueLabel ? <><span aria-hidden="true"> · </span><span>{queueLabel}</span></> : null}
            </p>
            {beat && provenance ? <div role="group" aria-label="Track metadata" className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px] leading-[16px]">
              <TrackValue value={beat.bpm != null ? `${formatBpm(beat.bpm)} BPM` : null} unknown="BPM unknown" origin={provenance.bpm} />
              <span aria-hidden="true" className="text-fg-subtle/60">·</span>
              <TrackValue value={beat.key || beat.camelot || null} unknown="Key unknown" origin={provenance.key} />
            </div> : null}
          </div>
        </div>

        <div className="flex items-center justify-center gap-1">
          <IconButton label="Previous track" size="icon-sm" disabled={closing || !hasTrack} onClick={previous}>
            <SkipBack />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? 'Pause audition' : 'Play audition'}
            disabled={closing || !hasTrack}
            onClick={toggle}
            className={cn(
              'grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-fg',
              'transition-[background-color,transform] duration-[var(--duration-fast)] active:scale-95',
              'hover:bg-[var(--sonic-accent-hover)] disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle'
            )}
          >
            {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 translate-x-px fill-current" />}
          </button>
          <IconButton label="Next track" size="icon-sm" disabled={closing || !hasTrack} onClick={next}>
            <SkipForward />
          </IconButton>
        </div>

        <div className="min-w-0">
          <div className="relative h-[25px] overflow-hidden">
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
