import type { ReactNode } from 'react'
import { Download, RefreshCw, ShieldCheck } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/Progress'
import { MultiStepLoader } from '@/components/aceternity/MultiStepLoader'

const SETUP_STEPS = [
  {
    label: 'Checking installed tools',
    description: 'Sonic looks for a managed engine first, then your PATH.'
  },
  {
    label: 'Downloading yt-dlp',
    description: 'Fetched from the publisher’s GitHub release and checksum-verified.'
  },
  {
    label: 'Verifying FFmpeg',
    description: 'FFmpeg and ffprobe handle conversion, tagging and media probing.'
  },
  {
    label: 'Ready',
    description: 'Nothing else to install — your queue is untouched.'
  }
]

/**
 * Shown when the media engine is incomplete. Bundles the explanation, the live
 * progress and a single repair action into one place, so a first run is never a
 * dead end.
 */
export function EngineBanner(): ReactNode {
  const engine = useApp((state) => state.engine)
  const progress = useApp((state) => state.engineProgress)
  const setupEngine = useApp((state) => state.setupEngine)
  const setupRunning = engine?.setupRunning ?? false

  if (!engine || engine.ready) return null

  const missing = engine.components.filter((component) => !component.available)
  const currentStep =
    progress?.phase === 'downloading' ? 1 : progress?.phase === 'verifying' ? 2 : setupRunning ? 1 : 0

  return (
    <section className="overflow-hidden rounded-[14px] border border-warning/35 bg-warning/[0.06]">
      <div className="flex items-start gap-3 p-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-warning/15 text-warning">
          <Download className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold tracking-tight text-fg">
            {setupRunning ? 'Setting up the media engine' : 'Media engine setup required'}
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
            {setupRunning
              ? 'Sonic is fetching what it needs. This only happens once.'
              : `Sonic needs ${missing.map((component) => component.name).join(' and ')} before it can download anything. Everything is checksum-verified and installed into Sonic's own folder.`}
          </p>

          {progress && progress.phase !== 'idle' && progress.phase !== 'done' ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between text-[11.5px] text-fg-muted">
                <span>{progress.message}</span>
                <span className="nums">
                  {progress.totalBytes
                    ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                    : ''}
                </span>
              </div>
              <ProgressBar value={progress.percent} active />
            </div>
          ) : null}

          {progress?.phase === 'error' || engine.lastError ? (
            <p className="mt-2 text-[11.5px] text-danger">{engine.lastError ?? progress?.message}</p>
          ) : null}

          {setupRunning ? (
            <div className="mt-4">
              <MultiStepLoader
                steps={SETUP_STEPS}
                currentIndex={currentStep}
                loading={setupRunning}
                error={engine.lastError}
              />
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button
            variant="primary"
            size="sm"
            busy={setupRunning}
            leading={<RefreshCw />}
            onClick={() => void setupEngine()}
          >
            {setupRunning ? 'Setting up…' : 'Set up now'}
          </Button>
          <span className="flex items-center gap-1 text-[10.5px] text-fg-subtle">
            <ShieldCheck className="size-3" />
            Verified downloads
          </span>
        </div>
      </div>
    </section>
  )
}
