import type { ReactNode } from 'react'
import { Download, ListChecks, Pause, Play } from 'lucide-react'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { JobRow, QueueEmptyState } from './JobRow'

const TERMINAL = new Set(['complete', 'failed', 'cancelled'])

/** A dedicated queue with task controls separated from its transport settings. */
export function QueueList(): ReactNode {
  const jobs = useApp((state) => state.queue.jobs)
  const paused = useApp((state) => state.queue.paused)
  const concurrency = useApp((state) => state.queue.concurrency)
  const selectedJobId = useApp((state) => state.selectedJobId)
  const setSelectedJob = useApp((state) => state.setSelectedJob)
  const startJobs = useApp((state) => state.startJobs)
  const setPaused = useApp((state) => state.setPaused)
  const setConcurrency = useApp((state) => state.setConcurrency)
  const clearFinished = useApp((state) => state.clearFinished)
  const readyCount = jobs.filter((job) => job.stage === 'ready').length
  const activeCount = jobs.filter((job) => !TERMINAL.has(job.stage)).length
  const finishedCount = jobs.filter((job) => job.stage === 'complete' || job.stage === 'cancelled').length

  return (
    <section className="studio-panel flex min-h-[260px] flex-1 flex-col overflow-hidden" aria-labelledby="queue-heading">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 px-5 py-4">
        <h2 id="queue-heading" className="text-[15px] font-semibold tracking-tight text-fg">Queue</h2>
        <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium text-fg-muted nums">{jobs.length}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" leading={<ListChecks />} disabled={finishedCount === 0} onClick={() => void clearFinished()} className="text-[12px]">Clear done</Button>
        <Button variant="primary" size="sm" leading={<Download />} disabled={readyCount === 0} onClick={() => void startJobs(null)} className="text-[12px] shadow-none">
          Download all{readyCount > 0 ? ` (${readyCount})` : ''}
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-y border-line bg-surface-2/45 px-5 py-2">
        <div className="flex items-center gap-2 text-[11.5px] text-fg-subtle">
          <span className={paused ? 'size-1.5 rounded-full bg-warning' : activeCount > 0 ? 'size-1.5 rounded-full bg-accent' : 'size-1.5 rounded-full bg-fg-subtle/50'} aria-hidden />
          {paused ? 'Queue paused' : activeCount > 0 ? `${activeCount} in progress` : 'All caught up'}
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-fg-subtle">Parallel</span>
          <Segmented size="sm" value={String(concurrency)} onChange={(next) => void setConcurrency(Number(next))} ariaLabel="Concurrent downloads" options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
        </div>
        <Button variant="ghost" size="sm" onClick={() => void setPaused(!paused)} leading={paused ? <Play /> : <Pause />} className="h-7 px-2 text-[11.5px]">
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {jobs.length === 0 ? (
          <QueueEmptyState>Paste a link above to prepare your first download.</QueueEmptyState>
        ) : (
          <div className="divide-y divide-line">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} selected={selectedJobId === job.id} onSelect={() => setSelectedJob(selectedJobId === job.id ? null : job.id)} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
