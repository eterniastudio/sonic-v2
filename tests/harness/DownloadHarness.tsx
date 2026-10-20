import { useEffect, useState } from 'react'
import type { Job } from '../../src/shared/domain'
import { applyFinalEdit, createDraft } from '../../src/shared/metadata'
import { IntakePanel } from '../../src/renderer/src/features/download/IntakePanel'
import { MetadataInspector } from '../../src/renderer/src/features/download/MetadataInspector'
import { QueueList } from '../../src/renderer/src/features/download/QueueList'
import { Toaster } from '../../src/renderer/src/components/ui/Toaster'
import { useApp } from '../../src/renderer/src/store/app'

function fixture(id = 'download-fixture'): Job {
  return {
    id, url: '', videoId: null, sourceKind: 'unknown', sourceTitle: 'Download fixture',
    sourceDescription: null, uploader: null, thumbnail: null, durationSec: 120,
    stage: 'ready', progress: 0, speed: null, eta: null, message: null, error: null,
    presetId: 'mp3-320', metadata: createDraft({ declared: { title: id, bpm: 120, key: 'A minor', producer: 'Producer' } }),
    outputPath: null, libraryId: null, revision: 0, createdAt: 0, updatedAt: 0
  }
}

export function DownloadHarness() {
  const [job, setJob] = useState(() => fixture())
  useEffect(() => {
    const controls = {
      queued: [] as string[][],
      edits: [] as unknown[],
      queueMode: 'barrier',
      editMode: 'success',
      releaseQueue: () => {},
      releaseEdit: () => {},
      revise: (values: { bpm?: number; key?: string }) => setJob(current => ({ ...current, metadata: { ...current.metadata, final: { ...current.metadata.final, ...values } } })),
      setStage: (stage: Job['stage']) => setJob(current => ({ ...current, stage }))
    }
    ;(window as unknown as { download: typeof controls }).download = controls
    useApp.setState({
      addUrls: async urls => {
        controls.queued.push(urls)
        if (controls.queueMode === 'barrier') await new Promise<void>(resolve => { controls.releaseQueue = resolve })
        if (controls.queueMode === 'failure') throw new Error('Queue write failed')
        useApp.setState(state => ({ queue: { ...state.queue, jobs: [...state.queue.jobs,
          ...urls.map(url => ({ ...fixture(), id: `queued-${state.queue.jobs.length}-${url}`, url }))] } }))
      },
      updateJob: async (_id, patch) => {
        controls.edits.push(patch)
        if (controls.editMode === 'barrier') await new Promise<void>(resolve => { controls.releaseEdit = resolve })
        if (controls.editMode === 'failure') throw new Error('Metadata write failed; retry your edit')
        if (patch.metadataEdit) {
          const { field, value } = patch.metadataEdit
          setJob(current => ({ ...current, metadata: applyFinalEdit(current.metadata, field, value) }))
        }
      }
    })
  }, [])
  return <main className="bg-bg text-fg h-screen p-4"><IntakePanel /><MetadataInspector job={job} /><button>Outside field</button><Toaster /></main>
}

export function QueueHarness() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const controls = { renders: {} as Record<string, number>, progress: () => {}, reset: () => {} }
    const jobs = Array.from({ length: 100 }, (_, index) => {
      const job = fixture(`job-${index}`)
      // Only rendering the row coerces its producer label. Cloned row objects
      // retain this stable nested value so comparison does not increment it.
      job.metadata.final.producer = {
        toJSON: () => 'Producer',
        toString: () => { controls.renders[job.id] = (controls.renders[job.id] ?? 0) + 1; return 'Producer' }
      } as unknown as string
      return job
    })
    useApp.getState().setQueueSnapshot({ jobs, paused: false, concurrency: 2 })
    controls.progress = () => {
      const queue = useApp.getState().queue
      useApp.getState().setQueueSnapshot({ ...queue, jobs: queue.jobs.map((job, index) => ({ ...job, ...(index === 0 ? { stage: 'downloading' as const, progress: 0.42 } : {}) })) })
    }
    controls.reset = () => { controls.renders = {} }
    ;(window as unknown as { queueTest: typeof controls }).queueTest = controls
    setReady(true)
  }, [])
  return <main className="bg-bg text-fg h-screen p-4">{ready ? <QueueList /> : null}</main>
}
