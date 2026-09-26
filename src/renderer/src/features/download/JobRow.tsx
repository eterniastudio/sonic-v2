import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, CircleAlert, ExternalLink, FolderOpen, Music2, Pause, Play, RefreshCw, Trash2, X } from 'lucide-react'
import type { Job, JobStage, PresetId } from '@shared/domain'
import { formatBpm, formatDuration } from '@shared/format'
import { PRESETS } from '@shared/presets'
import { coverArtFor } from '@shared/url'
import { cn } from '@/lib/cn'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { IconButton } from '@/components/ui/Button'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { ProgressBar } from '@/components/ui/Progress'
import { ConfirmDialog } from '@/components/ui/Modal'
import { Tooltip } from '@/components/ui/Tooltip'

const RUNNING = new Set<JobStage>(['downloading', 'analyzing', 'converting', 'tagging', 'publishing'])

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

/** True when this field's effective value is the analysed one. */
function analysisSourceFor(job: Job, field: 'bpm' | 'key'): boolean {
  if (!job.metadata.analysis || job.metadata.overrides.includes(field)) return false
  if (job.metadata.declared[field] != null || job.metadata.embedded[field] != null) return false
  return job.metadata.analyzed[field] != null
}

export function JobRow({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }): ReactNode {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const startJobs = useApp((state) => state.startJobs)
  const cancelJob = useApp((state) => state.cancelJob)
  const retryJob = useApp((state) => state.retryJob)
  const removeJob = useApp((state) => state.removeJob)
  const setJobPreset = useApp((state) => state.setJobPreset)
  const cover = job.thumbnail ?? coverArtFor(job.url)
  const running = RUNNING.has(job.stage)
  const metadata = job.metadata.final
  const preset = PRESETS.find((entry) => entry.id === job.presetId) ?? PRESETS[0]
  const mismatches = job.metadata.verification?.summary.mismatch ?? 0
  const showPercent = job.stage === 'downloading' || job.stage === 'converting'
  const detail = [
    metadata.producer || job.uploader || 'Unknown producer',
    metadata.bpm != null ? `${formatBpm(metadata.bpm)} BPM${analysisSourceFor(job, 'bpm') ? ' (audio)' : ''}` : null,
    metadata.key ? `${metadata.key}${analysisSourceFor(job, 'key') ? ' (audio)' : ''}` : null,
    metadata.camelot,
    job.durationSec ? formatDuration(job.durationSec) : null
  ].filter(Boolean).join(' · ')
  const statusDetail = job.stage === 'failed'
    ? job.error ?? 'Something went wrong.'
    : [
        STAGE_LABEL[job.stage],
        showPercent ? `${Math.round(job.progress * 100)}%` : null,
        job.stage === 'downloading' ? job.speed : null,
        job.stage === 'downloading' && job.eta ? `${job.eta} left` : null,
        job.message
      ].filter(Boolean).join(' · ')

  return (
    <>
      <div data-job-id={job.id} className={cn('group relative transition-colors duration-[var(--duration-quick)]', selected ? 'bg-surface-3/65' : 'hover:bg-surface-2')}>
        <div className="flex min-h-[68px] items-center gap-3.5 px-2 py-2" onClick={onSelect}>
          <div className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-[3px] bg-surface-2 text-fg-subtle">
            <Music2 className="size-3.5" />
            {cover ? <img src={cover} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : null}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                <button type="button" className="block w-full truncate text-left focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-fg-muted" onClick={(event) => { event.stopPropagation(); onSelect() }} aria-pressed={selected} title="Inspect metadata">
                  {metadata.title || job.sourceTitle || 'Untitled'}
                </button>
              </h3>
              <Tooltip label={statusDetail}>
                <span className={cn('flex max-w-[120px] shrink-0 items-center gap-1 text-[11.5px]', job.stage === 'failed' ? 'text-danger' : 'text-fg-subtle')}>
                  {job.stage === 'failed' ? <CircleAlert className="size-3 shrink-0" /> : job.stage === 'complete' ? <Check className="size-3 shrink-0" /> : null}
                  <span className="truncate">{STAGE_LABEL[job.stage]}</span>
                  {showPercent ? <span className="shrink-0 nums">{Math.round(job.progress * 100)}%</span> : null}
                  {job.stage === 'failed' && job.error ? <span className="sr-only">{job.error}</span> : null}
                </span>
              </Tooltip>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px] text-fg-subtle">
              <span className="min-w-0 flex-1 truncate" title={detail}>{detail}</span>
              {mismatches > 0 ? <Tooltip label="Source disagrees with audio"><CircleAlert className="size-3 shrink-0 text-warning" aria-label="Source disagrees with audio" /></Tooltip> : null}
              <Dropdown
                disabled={running || job.stage === 'complete' || job.stage === 'probing'}
                align="end"
                side="bottom"
                trigger={({ toggle }) => (
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); toggle() }}
                    className="flex h-5 shrink-0 items-center gap-0.5 rounded-[3px] px-1 text-[11px] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
                  >
                    {preset.short}<ChevronDown className="size-2.5" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <DropdownLabel>Export format</DropdownLabel>
                    {PRESETS.map((entry) => (
                      <DropdownItem key={entry.id} selected={entry.id === job.presetId} hint={entry.short} onSelect={async () => { await setJobPreset(job.id, entry.id as PresetId); close() }}>
                        {entry.label}
                      </DropdownItem>
                    ))}
                  </>
                )}
              </Dropdown>
            </div>
          </div>

          <div onClick={(event) => event.stopPropagation()} className="flex shrink-0 items-center">
            {job.stage === 'ready' || job.stage === 'failed' || job.stage === 'cancelled' ? (
              <Tooltip label={job.stage === 'ready' ? 'Download' : 'Retry'}>
                <IconButton label={job.stage === 'ready' ? 'Download' : 'Retry'} size="icon-xs" variant="ghost" onClick={() => void (job.stage === 'ready' ? startJobs([job.id]) : retryJob(job.id))}>
                  {job.stage === 'ready' ? <Play /> : <RefreshCw />}
                </IconButton>
              </Tooltip>
            ) : null}
            {running || job.stage === 'queued' || job.stage === 'probing' ? (
              <Tooltip label="Cancel">
                <IconButton label="Cancel" size="icon-xs" variant="ghost" onClick={() => void cancelJob(job.id)}>
                  {job.stage === 'queued' ? <X /> : <Pause />}
                </IconButton>
              </Tooltip>
            ) : null}
            {job.stage === 'complete' && job.outputPath ? (
              <>
                <Tooltip label="Reveal in folder">
                  <IconButton label="Reveal in folder" size="icon-xs" variant="ghost" onClick={() => void ipc.invoke('queue:revealOutput', job.id)}><FolderOpen /></IconButton>
                </Tooltip>
                <Tooltip label="Play in default app">
                  <IconButton label="Play in default app" size="icon-xs" variant="ghost" onClick={() => void ipc.invoke('queue:openOutput', job.id)}><ExternalLink /></IconButton>
                </Tooltip>
              </>
            ) : null}
            <Tooltip label="Remove from queue">
              <IconButton label="Remove from queue" size="icon-xs" variant="ghost" onClick={() => setConfirmRemove(true)}><Trash2 /></IconButton>
            </Tooltip>
          </div>
        </div>
        {running ? <ProgressBar value={job.progress} className="absolute inset-x-0 bottom-0 h-px rounded-none bg-transparent [&>span]:rounded-none" /> : null}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove “${metadata.title || job.sourceTitle || 'job'}” from the queue?`}
        description={job.stage === 'complete'
          ? 'The exported file and its library entry are kept — this only clears the queue row.'
          : 'The job and any partially downloaded data for it are discarded.'}
        confirmLabel="Remove"
        tone="danger"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => { await removeJob(job.id); setConfirmRemove(false) }}
      />
    </>
  )
}

export function QueueEmptyState({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-2 py-8 text-center">
      <p className="text-[13px] text-fg-muted">Nothing queued</p>
      <p className="mt-1 text-[11.5px] text-fg-subtle">{children}</p>
    </div>
  )
}
