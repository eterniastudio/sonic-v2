import { useRef, type ReactNode } from 'react'
import { ListChecks, Pause, Play } from 'lucide-react'
import { useApp } from '@/store/app'
import { ArrowFillButton } from '@/components/obsidian/ArrowFillButton'
import { GlowingScrollIndicator } from '@/components/obsidian/GlowingScrollIndicator'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { JobRow, QueueEmptyState } from './JobRow'

const TERMINAL = new Set(['complete', 'failed', 'cancelled'])

/** Queue surface: bulk controls plus the per-job rows. */
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
  const scrollRef = useRef<HTMLDivElement | null>(null)

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">Queue</h2>
        <span className="text-[11.5px] text-fg-subtle nums">
          {activeCount > 0 ? `${activeCount} active` : 'idle'}
        </span>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => void setPaused(!paused)}
          className="flex h-8 items-center gap-1.5 rounded-[9px] border border-line bg-surface-2 px-2.5 text-[12px] text-fg-muted transition-colors duration-[var(--duration-quick)] hover:border-line-strong hover:text-fg"
        >
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          {paused ? 'Resume' : 'Pause'}
        </button>

        <Segmented
          size="sm"
          value={String(concurrency)}
          onChange={(next) => void setConcurrency(Number(next))}
          ariaLabel="Concurrent downloads"
          options={[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '3', label: '3' }
          ]}
        />

        <Button
          variant="ghost"
          size="sm"
          leading={<ListChecks />}
          disabled={finishedCount === 0}
          onClick={() => void clearFinished()}
        >
          Clear done
        </Button>

        <ArrowFillButton
          disabled={readyCount === 0}
          onClick={() => void startJobs(null)}
          className="h-8 px-3 text-[12.5px]"
        >
          Download all{readyCount > 0 ? ` (${readyCount})` : ''}
        </ArrowFillButton>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full space-y-2 overflow-y-auto p-3">
          {jobs.length === 0 ? (
            <QueueEmptyState>
              Nothing queued yet. Paste a link above to get started.
            </QueueEmptyState>
          ) : (
            jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                selected={selectedJobId === job.id}
                onSelect={() => setSelectedJob(selectedJobId === job.id ? null : job.id)}
              />
            ))
          )}
        </div>
        <GlowingScrollIndicator scrollRef={scrollRef} />
      </div>
    </section>
  )
}
