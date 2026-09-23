import { useState, type ReactNode } from 'react'
import { FolderOpen, ShieldCheck, Trash2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toaster'

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
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
    <div className="space-y-7">
      <section>
        <h3 className="mb-2 text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Library upkeep
        </h3>

        <div className="divide-y divide-[var(--sonic-border)]">
          <Row label="Beats in library" value={String(library.length)} />
          <Row label="Records with missing files" value={String(missingCount)} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
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
          className="mt-4"
        >
          <Input
            type="number"
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
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Where Sonic keeps your data
        </h3>

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
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Privacy
        </h3>
        <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-surface-2 p-3.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="space-y-1 text-[11.5px] leading-relaxed text-fg-muted">
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
      </section>
    </div>
  )
}
