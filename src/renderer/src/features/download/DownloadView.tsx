import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { useApp, selectSelectedJob } from '@/store/app'
import { EngineBanner } from './EngineBanner'
import { IntakePanel } from './IntakePanel'
import { QueueList } from './QueueList'
import { MetadataInspector } from './MetadataInspector'

/** Download workspace: intake, queue, and the metadata inspector. */
export function DownloadView(): ReactNode {
  const selectedJob = useApp(selectSelectedJob)
  const jobs = useApp((state) => state.queue.jobs)
  const selectedJobId = useApp((state) => state.selectedJobId)
  const setSelectedJob = useApp((state) => state.setSelectedJob)
  const lastCandidateId = useRef<string | undefined>(undefined)
  const completedCount = jobs.filter((job) => job.stage === 'complete').length

  // Auto-focus the newest job so its metadata is reviewable straight after a paste.
  useEffect(() => {
    const candidate = jobs.find((job) => job.stage === 'ready' || job.stage === 'probing')
    // A dismissed inspector stays closed until a different job becomes available.
    if (candidate?.id === lastCandidateId.current) return
    lastCandidateId.current = candidate?.id
    if (candidate && !selectedJobId) setSelectedJob(candidate.id)
  }, [jobs, selectedJobId, setSelectedJob])

  return (
    <div className="workspace-page flex h-full min-h-0 flex-col">
      <header className="page-header shrink-0 pb-4">
        <div className="min-w-0">
          <h1 className="page-title">Downloads</h1>
          <p className="page-description">Add source links, review metadata, and export your audio.</p>
        </div>
        {completedCount > 0 ? (
          <div className="hidden items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-fg-muted sm:flex">
            <ArrowDownToLine className="size-3.5 text-success" />
            <span><span className="font-medium text-fg nums">{completedCount}</span> exported</span>
          </div>
        ) : null}
      </header>
      <div className="relative flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pb-0.5">
          <EngineBanner />
          <IntakePanel />
          <QueueList />
        </div>
        {selectedJob ? <MetadataInspector key={selectedJob.id} job={selectedJob} /> : null}
      </div>
    </div>
  )
}
