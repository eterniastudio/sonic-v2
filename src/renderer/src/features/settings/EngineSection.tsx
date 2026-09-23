import { useState, type ReactNode } from 'react'
import { CheckCircle2, CircleDashed, FolderOpen, RefreshCw, Wand2 } from 'lucide-react'
import type { Settings } from '@shared/domain'
import { formatBytes } from '@shared/format'
import { cn } from '@/lib/cn'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { Field, Input } from '@/components/ui/Input'
import { ProgressBar } from '@/components/ui/Progress'
import { MultiStepLoader } from '@/components/aceternity/MultiStepLoader'

const BROWSERS: { value: Settings['cookiesFromBrowser']; label: string }[] = [
  { value: 'none', label: 'Do not use cookies' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'brave', label: 'Brave' },
  { value: 'opera', label: 'Opera' },
  { value: 'vivaldi', label: 'Vivaldi' }
]

const SETUP_STEPS = [
  { label: 'Checking installed tools', description: 'A managed engine is preferred, then your PATH.' },
  { label: 'Downloading yt-dlp', description: 'Fetched from GitHub and verified against its SHA-256 manifest.' },
  { label: 'Verifying FFmpeg', description: 'Used for conversion, tagging and media probing.' },
  { label: 'Ready', description: 'Sonic can now download and convert.' }
]

/** Media engine status, setup and per-tool overrides. */
export function EngineSection(): ReactNode {
  const engine = useApp((state) => state.engine)
  const progress = useApp((state) => state.engineProgress)
  const setupEngine = useApp((state) => state.setupEngine)
  const pickTool = useApp((state) => state.pickTool)
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)
  const [durationDraft, setDurationDraft] = useState(String(Math.round(settings.maxDurationSec / 60)))

  const running = engine?.setupRunning ?? false
  const currentStep =
    progress?.phase === 'downloading' ? 1 : progress?.phase === 'verifying' ? 2 : running ? 1 : 0

  const browserLabel =
    BROWSERS.find((entry) => entry.value === settings.cookiesFromBrowser)?.label ?? 'Do not use cookies'

  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
            Media engine
          </h3>
          <span className="flex-1" />
          {engine?.ready ? (
            <Badge tone="success" size="sm" icon={<CheckCircle2 />}>
              Ready
            </Badge>
          ) : (
            <Badge tone="warning" size="sm" icon={<CircleDashed />}>
              Incomplete
            </Badge>
          )}
        </div>

        <p className="text-[12px] leading-relaxed text-fg-muted">
          Sonic downloads yt-dlp into its own folder and verifies it against the publisher&apos;s
          checksum manifest. FFmpeg is used from the managed folder or your PATH — nothing is
          installed system-wide.
        </p>

        {progress && progress.phase !== 'idle' && progress.phase !== 'done' ? (
          <div className="space-y-2 rounded-[10px] border border-line bg-surface-2 p-3">
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

        <div className="space-y-1.5">
          {(engine?.components ?? []).map((component) => (
            <div
              key={component.name}
              className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2.5"
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  component.available ? 'bg-success' : 'bg-danger'
                )}
              />
              <span className="w-16 shrink-0 font-mono text-[11.5px] text-fg">{component.name}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-fg-subtle" title={component.path ?? ''}>
                {component.version ? `v${component.version}` : 'not found'}
                {component.origin ? ` · ${component.origin}` : ''}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void pickTool(component.name)}
                title="Use a specific executable"
              >
                Browse
              </Button>
            </div>
          ))}
        </div>

        {running ? (
          <div className="rounded-[10px] border border-line bg-surface p-3.5">
            <MultiStepLoader
              steps={SETUP_STEPS}
              currentIndex={currentStep}
              loading={running}
              error={engine?.lastError}
            />
          </div>
        ) : null}

        {engine?.lastError ? (
          <p className="text-[11.5px] leading-relaxed text-danger">{engine.lastError}</p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            leading={<Wand2 />}
            busy={running}
            onClick={() => void setupEngine()}
          >
            {running ? 'Setting up…' : 'Set up / repair engine'}
          </Button>
          <Button
            variant="ghost"
            leading={<FolderOpen />}
            onClick={() => void ipc.invoke('app:openDirectory', 'engine')}
          >
            Open engine folder
          </Button>
          {engine?.engineDir ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-subtle">
              {engine.engineDir}
            </span>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Acquisition
        </h3>

        <Field
          label="Use cookies from a browser"
          hint="Only when a source needs a signed-in session"
          note="Sonic reads the browser's own cookie store through yt-dlp. Leave this off unless a specific link fails with a sign-in prompt."
        >
          <Dropdown
            width="trigger"
            className="w-full"
            trigger={({ toggle }) => (
              <Button variant="secondary" className="w-full justify-between" onClick={toggle}>
                {browserLabel}
              </Button>
            )}
          >
            {(close) => (
              <>
                <DropdownLabel>Cookie source</DropdownLabel>
                {BROWSERS.map((entry) => (
                  <DropdownItem
                    key={entry.value}
                    selected={entry.value === settings.cookiesFromBrowser}
                    onSelect={async () => {
                      await patchSettings({ cookiesFromBrowser: entry.value })
                      close()
                    }}
                  >
                    {entry.label}
                  </DropdownItem>
                ))}
              </>
            )}
          </Dropdown>
        </Field>

        <Field
          label="Maximum source length"
          hint="minutes · 0 disables the limit"
          note="A guard against accidentally queueing an hour-long upload."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={1440}
              value={durationDraft}
              onChange={(event) => setDurationDraft(event.target.value)}
              onBlur={() => {
                const minutes = Math.max(0, Math.min(1440, Number(durationDraft) || 0))
                setDurationDraft(String(minutes))
                void patchSettings({ maxDurationSec: minutes * 60 })
              }}
              className="w-28 nums"
            />
            <IconButton
              label="Re-check the engine"
              variant="secondary"
              onClick={() => void ipc.invoke('engine:status').then((status) => useApp.setState({ engine: status }))}
            >
              <RefreshCw />
            </IconButton>
          </div>
        </Field>
      </section>
    </div>
  )
}
