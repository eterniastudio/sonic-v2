import { useState, type ReactNode } from 'react'
import {
  CircleAlert,
  ExternalLink,
  FolderOpen,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import type { Job, JobStage, PresetId } from '@shared/domain'
import { formatBpm, formatDuration } from '@shared/format'
import { PRESETS } from '@shared/presets'
import { coverArtFor } from '@shared/url'
import { cn } from '@/lib/cn'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/Button'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { ProgressBar } from '@/components/ui/Progress'
import { ConfirmDialog } from '@/components/ui/Modal'
import { Tooltip, TextSwap } from '@/components/ui/Tooltip'
import { CardSpotlight } from '@/components/aceternity/AmbientBackground'
import { StepPipeline } from '@/components/aceternity/MultiStepLoader'

const PIPELINE = ['Fetch', 'Analyze', 'Convert', 'Tag', 'Publish']

const PIPELINE_INDEX: Partial<Record<JobStage, number>> = {
  downloading: 0,
  analyzing: 1,
  converting: 2,
  tagging: 3,
  publishing: 4
}

const STAGE_LABEL: Record<JobStage, string> = {
  probing: 'Reading metadata',
  ready: 'Ready to download',
  queued: 'Waiting for a worker',
  downloading: 'Downloading',
  analyzing: 'Analyzing audio',
  converting: 'Converting',
  tagging: 'Verifying tags',
  publishing: 'Publishing',
  complete: 'Exported',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

// ---------------------------------------------------------------- analysis UI

/** Marks a value that came from the audio rather than from text or tags. */
function AudioMark(): ReactNode {
  return (
    <span
      title="Audio estimate"
      className="ml-0.5 inline-flex items-center rounded-[3px] bg-[var(--sonic-accent-line)] px-1 text-[9px] font-semibold tracking-wide text-fg uppercase"
    >
      audio
    </span>
  )
}

/** True when this field's effective value is the analysed one. */
function analysisSourceFor(job: Job, field: 'bpm' | 'key'): boolean {
  if (!job.metadata.analysis) return false
  if (job.metadata.overrides.includes(field)) return false
  const declared = job.metadata.declared[field]
  const embedded = job.metadata.embedded[field]
  if (declared != null || embedded != null) return false
  return job.metadata.analyzed[field] != null
}

const ANALYSIS_TONE: Record<string, { tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; label: string }> = {
  'not-analyzed': { tone: 'neutral', label: 'not analyzed' },
  queued: { tone: 'neutral', label: 'analysis queued' },
  analyzing: { tone: 'accent', label: 'analyzing' },
  estimated: { tone: 'success', label: 'analyzed' },
  partial: { tone: 'accent', label: 'partly analyzed' },
  inconclusive: { tone: 'warning', label: 'inconclusive' },
  failed: { tone: 'danger', label: 'analysis failed' },
  cancelled: { tone: 'neutral', label: 'analysis cancelled' }
}

/** Compact analysis state, with a disagreement flag when it matters. */
function AnalysisBadge({ job }: { job: Job }): ReactNode {
  const status = job.metadata.analysis?.tempo || job.metadata.analysis?.key
    ? job.metadata.analysis.tempo.status === 'estimated' && job.metadata.analysis.key.status === 'estimated'
      ? 'estimated'
      : job.metadata.analysis.tempo.status === 'estimated' || job.metadata.analysis.key.status === 'estimated'
        ? 'partial'
        : 'inconclusive'
    : 'not-analyzed'

  const tone = ANALYSIS_TONE[status] ?? ANALYSIS_TONE['not-analyzed']
  const mismatches = job.metadata.verification?.summary.mismatch ?? 0

  return (
    <>
      <Badge size="sm" tone={mismatches > 0 ? 'warning' : tone.tone}>
        {tone.label}
      </Badge>
      {mismatches > 0 ? (
        <Badge size="sm" tone="warning" icon={<CircleAlert />}>
          source disagrees
        </Badge>
      ) : null}
    </>
  )
}

export function JobRow({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }): ReactNode {
  const [confirmRemove, setConfirmRemove] = useState(false)

  const startJobs = useApp((state) => state.startJobs)
  const cancelJob = useApp((state) => state.cancelJob)
  const retryJob = useApp((state) => state.retryJob)
  const removeJob = useApp((state) => state.removeJob)
  const setJobPreset = useApp((state) => state.setJobPreset)

  const cover = job.thumbnail ?? coverArtFor(job.url)
  const pipelineIndex = PIPELINE_INDEX[job.stage] ?? -1
  const running = pipelineIndex >= 0
  const metadata = job.metadata.final
  const preset = PRESETS.find((entry) => entry.id === job.presetId) ?? PRESETS[0]

  return (
    <>
      <CardSpotlight
      className={cn(
        'group rounded-[12px] border transition-[border-color,background-color] duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
        selected ? 'border-[var(--sonic-accent-line)] bg-accent-softer' : 'border-line bg-surface hover:border-line-strong',
        job.stage === 'failed' && 'border-danger/30'
      )}
    >
      <div className="flex gap-3.5 p-3.5" onClick={onSelect}>
        {/* Cover art doubles as the selection affordance. */}
        <div className="relative h-[62px] w-[110px] shrink-0 overflow-hidden rounded-[9px] bg-surface-3">
          {cover ? (
            <img
              src={cover}
              alt=""
              loading="lazy"
              className="size-full object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none'
              }}
            />
          ) : (
            <div className="grid size-full place-items-center text-fg-subtle">
              <StatusDot tone="neutral" />
            </div>
          )}

          {job.stage === 'complete' ? (
            <span className="absolute right-1.5 bottom-1.5 rounded-[4px] bg-success px-1 py-0.5 text-[9.5px] font-semibold text-white">
              DONE
            </span>
          ) : null}
          {running ? (
            <span className="absolute inset-0 bg-black/45" aria-hidden>
              <span className="absolute inset-x-0 bottom-0">
                <ProgressBar value={job.progress} className="h-1 rounded-none bg-white/20" />
              </span>
            </span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[13.5px] font-medium text-fg">
                {metadata.title || job.sourceTitle || 'Untitled'}
              </h3>
              <p className="mt-0.5 truncate text-[11.5px] text-fg-muted">
                {metadata.producer || job.uploader || 'Unknown producer'}
              </p>
            </div>

            <div onClick={event => event.stopPropagation()} className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 focus-within:opacity-100">
              {job.stage === 'ready' || job.stage === 'failed' || job.stage === 'cancelled' ? (
                <Tooltip label={job.stage === 'ready' ? 'Download' : 'Retry'}>
                  <IconButton
                    label={job.stage === 'ready' ? 'Download' : 'Retry'}
                    size="icon-sm"
                    variant="quiet"
                    onClick={() => void (job.stage === 'ready' ? startJobs([job.id]) : retryJob(job.id))}
                  >
                    {job.stage === 'ready' ? <Play /> : <RefreshCw />}
                  </IconButton>
                </Tooltip>
              ) : null}

              {running || job.stage === 'queued' || job.stage === 'probing' ? (
                <Tooltip label="Cancel">
                  <IconButton label="Cancel" size="icon-sm" variant="ghost" onClick={() => void cancelJob(job.id)}>
                    {job.stage === 'queued' ? <X /> : <Pause />}
                  </IconButton>
                </Tooltip>
              ) : null}

              {job.stage === 'complete' && job.outputPath ? (
                <>
                  <Tooltip label="Reveal in folder">
                    <IconButton
                      label="Reveal in folder"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => void ipc.invoke('app:revealPath', job.outputPath as string)}
                    >
                      <FolderOpen />
                    </IconButton>
                  </Tooltip>
                  <Tooltip label="Play in default app">
                    <IconButton
                      label="Play in default app"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => void ipc.invoke('app:openPath', job.outputPath as string)}
                    >
                      <ExternalLink />
                    </IconButton>
                  </Tooltip>
                </>
              ) : null}

              <Tooltip label="Remove from queue">
                <IconButton
                  label="Remove from queue"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setConfirmRemove(true)}
                >
                  <Trash2 />
                </IconButton>
              </Tooltip>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {metadata.bpm != null ? (
              <Badge size="sm">
                {formatBpm(metadata.bpm)} BPM
                {analysisSourceFor(job, 'bpm') ? <AudioMark /> : null}
              </Badge>
            ) : null}
            {metadata.camelot ? (
              <Badge size="sm" tone="accent">
                {metadata.camelot}
                {analysisSourceFor(job, 'key') ? <AudioMark /> : null}
              </Badge>
            ) : null}
            {metadata.key ? <Badge size="sm">{metadata.key}</Badge> : null}
            {job.durationSec ? <Badge size="sm">{formatDuration(job.durationSec)}</Badge> : null}

            <AnalysisBadge job={job} />

            <Dropdown
              disabled={running || job.stage === 'complete' || job.stage === 'probing'}
              align="end"
              side="bottom"
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    toggle()
                  }}
                  className="rounded-full border border-line bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-fg-muted transition-colors duration-[var(--duration-quick)] hover:border-line-strong hover:text-fg"
                >
                  {preset.short}
                </button>
              )}
            >
              {(close) => (
                <>
                  <DropdownLabel>Export format</DropdownLabel>
                  {PRESETS.map((entry) => (
                    <DropdownItem
                      key={entry.id}
                      selected={entry.id === job.presetId}
                      hint={entry.short}
                      onSelect={async () => {
                      await setJobPreset(job.id, entry.id as PresetId)
                      close()
                      }}
                    >
                      {entry.label}
                    </DropdownItem>
                  ))}
                </>
              )}
            </Dropdown>
          </div>

          <div className="mt-2.5">
            {running || job.stage === 'queued' || job.stage === 'probing' ? (
              <div className="space-y-1.5">
                <StepPipeline steps={PIPELINE} currentIndex={Math.max(0, pipelineIndex)} />
                <div className="flex items-center gap-2 text-[11px] text-fg-subtle nums">
                  <TextSwap value={STAGE_LABEL[job.stage]} className="text-fg-muted" />
                  {job.stage === 'downloading' ? (
                    <>
                      <span>·</span>
                      <span>{Math.round(job.progress * 100)}%</span>
                      {job.speed ? (
                        <>
                          <span>·</span>
                          <span>{job.speed}</span>
                        </>
                      ) : null}
                      {job.eta ? (
                        <>
                          <span>·</span>
                          <span>{job.eta} left</span>
                        </>
                      ) : null}
                    </>
                  ) : job.stage === 'converting' ? (
                    <>
                      <span>·</span>
                      <span>{Math.round(job.progress * 100)}%</span>
                    </>
                  ) : job.stage === 'analyzing' ? (
                    <span className="truncate">{job.message ?? 'Analyzing audio…'}</span>
                  ) : null}
                </div>
              </div>
            ) : job.stage === 'failed' ? (
              <div className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-danger">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0">{job.error ?? 'Something went wrong.'}</span>
              </div>
            ) : (
              <span className="text-[11.5px] text-fg-subtle">
                {job.stage === 'complete' && job.message ? (
                  <span className="truncate font-mono text-[10.5px]">{job.message}</span>
                ) : (
                  STAGE_LABEL[job.stage]
                )}
              </span>
            )}
          </div>
        </div>
      </div>
      </CardSpotlight>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove “${metadata.title || job.sourceTitle || 'job'}” from the queue?`}
        description={
          job.stage === 'complete'
            ? 'The exported file and its library entry are kept — this only clears the queue row.'
            : 'The job and any partially downloaded data for it are discarded.'
        }
        confirmLabel="Remove"
        tone="danger"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          await removeJob(job.id)
          setConfirmRemove(false)
        }}
      />
    </>
  )
}

/** Empty-state shown before anything has been queued. */
export function QueueEmptyState({ children }: { children: ReactNode }): ReactNode {
  return <div className="px-3 py-10 text-center text-[12.5px] text-fg-subtle">{children}</div>
}
