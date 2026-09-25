import { useState, type ReactNode } from 'react'
import { FolderOpen, Library, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toaster'
import { SettingsPanel } from './SettingsPanel'

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <span className="shrink-0 text-[12px] text-fg-muted">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[11.5px] text-fg ${mono ? 'font-mono text-[10.5px]' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

/** Diagnostics, library upkeep and where Sonic keeps its data. */
export function AdvancedSection(): ReactNode {
  const info = useApp((state) => state.info)
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)
  const rescanLibrary = useApp((state) => state.rescanLibrary)
  const library = useApp((state) => state.library)

  const [intervalDraft, setIntervalDraft] = useState(String(Math.round(settings.rescanIntervalMs / 1000)))
  const missingCount = library.filter((beat) => beat.missing).length

  return (
    <div className="space-y-5">
      <SettingsPanel title="Library upkeep" description="Keep your collection connected to the files on your device.">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-line bg-bg/50 p-4">
            <div className="flex items-center justify-between gap-3 text-[12px] text-fg-muted">
              Beats in library
              <Library className="size-4 text-fg-subtle" />
            </div>
            <p className="mt-3 text-[28px] leading-none font-semibold tracking-[-0.04em] text-fg nums">{library.length}</p>
          </div>
          <div className="rounded-xl border border-line bg-bg/50 p-4">
            <div className="flex items-center justify-between gap-3 text-[12px] text-fg-muted">
              Records with missing files
              <span className={`size-1.5 shrink-0 rounded-full ${missingCount ? 'bg-warning' : 'bg-success'}`} />
            </div>
            <p className={`mt-3 text-[28px] leading-none font-semibold tracking-[-0.04em] nums ${missingCount ? 'text-warning' : 'text-fg'}`}>{missingCount}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            leading={<RefreshCw />}
            onClick={() => {
              void rescanLibrary()
              toast({ kind: 'info', title: 'Library rescan started' })
            }}
          >
            Rescan now
          </Button>

          <Button
            variant="danger"
            leading={<Trash2 />}
            disabled={missingCount === 0}
            onClick={() => {
              // Filtering for missing files lives in the Library; send them there.
              useApp.setState({ view: 'library' })
              toast({
                kind: 'info',
                title: `${missingCount} record${missingCount === 1 ? '' : 's'} with missing files`,
                description: 'Enable Filters → Hide missing to see the rest, or use the warning badge.'
              })
            }}
          >
            Review missing ({missingCount})
          </Button>
        </div>

        <Field
          label="Background rescan interval"
          hint="seconds · 0 disables it"
          note="Sonic periodically checks that every recorded file still exists, so a deleted export shows up as missing instead of silently failing to play."
          htmlFor="settings-rescan-interval"
          className="mt-5 border-t border-line pt-5"
        >
          <Input
            type="number"
            id="settings-rescan-interval"
            min={0}
            max={3600}
            value={intervalDraft}
            onChange={(event) => setIntervalDraft(event.target.value)}
            onBlur={() => {
              const seconds = Math.max(0, Math.min(3600, Number(intervalDraft) || 0))
              setIntervalDraft(String(seconds))
              void patchSettings({ rescanIntervalMs: seconds * 1000 })
            }}
            className="w-28 nums"
          />
        </Field>
      </SettingsPanel>

      <SettingsPanel title="Where Sonic keeps your data" description="App details and local storage locations." bodyClassName="pt-2">
        <div className="divide-y divide-[var(--sonic-border)]">
          <Row label="Version" value={info ? `${info.name} ${info.version}` : '—'} />
          <Row label="Electron" value={info?.electron ?? '—'} />
          <Row label="Chromium" value={info?.chrome ?? '—'} />
          <Row label="Node" value={info?.node ?? '—'} />
          <Row label="Platform" value={info?.platform ?? '—'} />
          <Row label="App data" value={info?.userDataDir ?? '—'} mono />
          <Row label="Exports" value={settings.downloadDir || '—'} mono />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            leading={<FolderOpen />}
            onClick={() => void ipc.invoke('app:openDirectory', 'userData')}
          >
            Open app data folder
          </Button>
          <Button
            variant="ghost"
            leading={<FolderOpen />}
            onClick={() => void ipc.invoke('app:openDirectory', 'downloads')}
          >
            Open export folder
          </Button>
        </div>
      </SettingsPanel>

      <SettingsPanel title="Privacy" description="A local workspace, with no account required.">
        <div className="flex items-start gap-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-fg-muted"><ShieldCheck className="size-5" /></span>
          <div className="space-y-2 text-[12px] leading-relaxed text-fg-muted">
            <p>
              Sonic has no account, no analytics and no conversion backend. Network access happens
              only when you paste a link, when the media engine is installed, or when a thumbnail is
              fetched.
            </p>
            <p>
              Sidecars record the file <span className="text-fg">name</span> rather than its full
              local path, so they stay safe to share.
            </p>
          </div>
        </div>
      </SettingsPanel>
    </div>
  )
}
