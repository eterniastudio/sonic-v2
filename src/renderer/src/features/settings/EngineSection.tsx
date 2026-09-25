import { useState, type ReactNode } from 'react'
import { CheckCircle2, ChevronDown, CircleDashed, Cpu, FolderOpen, RefreshCw, Wand2 } from 'lucide-react'
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
import { SettingsPanel } from './SettingsPanel'

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
    <div className="space-y-5">
      <SettingsPanel
        title="Media engine"
        description="The tools that download, convert, and prepare your audio."
        bodyClassName="space-y-5"
        accessory={engine?.ready ? (
            <Badge tone="success" size="sm" icon={<CheckCircle2 />}>
              Ready
            </Badge>
          ) : (
            <Badge tone="warning" size="sm" icon={<CircleDashed />}>
              Incomplete
            </Badge>
          )}
      >
        <div className="flex items-start gap-4 rounded-xl border border-line bg-bg/50 p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-surface text-fg-muted">
            <Cpu className="size-5" />
          </span>
          <div>
            <p className="text-[13px] font-medium text-fg">{engine?.ready ? 'Ready for your next download' : 'Prepare your media engine'}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              Sonic keeps its media tools in a dedicated folder and verifies downloaded tools.
              Your system&apos;s FFmpeg can also be used.
            </p>
          </div>
        </div>

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

        <div className="overflow-hidden rounded-xl border border-line divide-y divide-[var(--sonic-border)]">
          {(engine?.components ?? []).map((component) => (
            <div
              key={component.name}
              className="flex items-center gap-3 bg-surface px-4 py-3.5"
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  component.available ? 'bg-success' : 'bg-danger'
                )}
              />
              <span className="w-20 shrink-0 font-mono text-[12px] font-medium text-fg">{component.name}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-fg-subtle" title={component.path ?? ''}>
                {component.version ? `v${component.version}` : 'not found'}
                {component.origin ? ` · ${component.origin}` : ''}
              </span>
              <Button
                variant="secondary"
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

        <div className="flex flex-wrap items-center gap-2">
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
            <span className="mt-1 block w-full truncate font-mono text-[10.5px] text-fg-subtle">
              {engine.engineDir}
            </span>
          ) : null}
        </div>
      </SettingsPanel>

      <SettingsPanel title="Acquisition" description="Adjust access and limits for the sources you download." bodyClassName="space-y-6">
        <Field
          label="Use cookies from a browser"
          hint="Only when a source needs a signed-in session"
          note="Sonic reads the browser's own cookie store through yt-dlp. Leave this off unless a specific link fails with a sign-in prompt."
        >
          <Dropdown
            width="trigger"
            className="w-full"
            trigger={({ toggle }) => (
              <Button variant="secondary" className="w-full justify-between" trailing={<ChevronDown />} onClick={toggle}>
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
          htmlFor="settings-source-length"
          hint="minutes · 0 disables the limit"
          note="A guard against accidentally queueing an hour-long upload."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              id="settings-source-length"
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
      </SettingsPanel>
    </div>
  )
}
