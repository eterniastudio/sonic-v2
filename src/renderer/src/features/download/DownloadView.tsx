import { useEffect, type ReactNode } from 'react'
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

  // Auto-focus the newest job so its metadata is reviewable straight after a paste.
  useEffect(() => {
    if (selectedJobId) return
    const candidate = jobs.find((job) => job.stage === 'ready' || job.stage === 'probing')
    if (candidate) setSelectedJob(candidate.id)
  }, [jobs, selectedJobId, setSelectedJob])

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        <EngineBanner />
        <IntakePanel />
        <QueueList />
      </div>

      {selectedJob ? <MetadataInspector job={selectedJob} /> : null}
    </div>
  )
}
