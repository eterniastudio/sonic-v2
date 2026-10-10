import { useCallback, type ReactNode } from 'react'
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
  const selectJob = useCallback((id: string): void => {
    setSelectedJob(useApp.getState().selectedJobId === id ? null : id)
  }, [setSelectedJob])
  const readyCount = jobs.filter((job) => job.stage === 'ready').length
  const activeCount = jobs.filter((job) => !TERMINAL.has(job.stage)).length
  const finishedCount = jobs.filter((job) => job.stage === 'complete' || job.stage === 'cancelled').length

  return (
    <section className="flex min-h-[180px] flex-1 flex-col overflow-hidden" aria-labelledby="queue-heading">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line py-2">
        <h2 id="queue-heading" className="text-[13px] font-medium text-fg">Queue</h2>
        <span className="text-[11.5px] text-fg-subtle nums">{jobs.length}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="xs" leading={<ListChecks />} disabled={finishedCount === 0} onClick={() => void clearFinished()} className="h-6 px-1.5 text-[11.5px]">Clear done</Button>
        <Button variant="primary" size="xs" leading={<Download />} disabled={readyCount === 0} onClick={() => void startJobs(null)} className="h-6 rounded-[4px] px-2 text-[11.5px] shadow-none">
          Download all{readyCount > 0 ? ` (${readyCount})` : ''}
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-1.5">
        <div className="text-[11.5px] text-fg-subtle">
          {paused ? 'Paused' : activeCount > 0 ? `${activeCount} active` : 'Idle'}
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] text-fg-subtle">Parallel</span>
          <Segmented size="sm" value={String(concurrency)} onChange={(next) => void setConcurrency(Number(next))} ariaLabel="Concurrent downloads" options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
        </div>
        <Button variant="ghost" size="xs" onClick={() => void setPaused(!paused)} leading={paused ? <Play /> : <Pause />} className="h-6 px-1.5 text-[11.5px]">
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {jobs.length === 0 ? (
          <QueueEmptyState>Paste a link above to prepare your first download.</QueueEmptyState>
        ) : (
          <div className="divide-y divide-line">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} selected={selectedJobId === job.id} onSelect={selectJob} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
