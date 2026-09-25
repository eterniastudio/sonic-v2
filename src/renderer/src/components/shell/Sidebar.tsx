import { useMemo, type ReactNode } from 'react'
import { ArrowUpRight, Download, HardDrive, Library, Settings as SettingsIcon } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { cn } from '@/lib/cn'
import { useApp, type ViewId } from '@/store/app'
import { StatusDot } from '@/components/ui/Badge'

interface NavItemProps {
  icon: ReactNode
  label: string
  active: boolean
  count?: number
  onClick: () => void
  /** Pulses the badge while work is in flight. */
  busy?: boolean
}

function NavItem({ icon, label, active, count, onClick, busy }: NavItemProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-11 w-full items-center gap-3 rounded-[9px] border px-3 text-left',
        'transition-[background-color,border-color,color] duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
        active ? 'border-accent-line bg-accent-softer text-fg' : 'border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg'
      )}
    >
      <span aria-hidden="true" className={cn('shrink-0 [&>svg]:size-[17px] [&>svg]:stroke-[1.7]', active ? 'text-accent' : 'text-fg-subtle group-hover:text-fg-muted')}>
        {icon}
      </span>
      <span className="flex-1 truncate text-[12.5px] font-medium">{label}</span>
      {count != null && count > 0 ? (
        <span
          className={cn(
            'grid min-w-5 shrink-0 place-items-center rounded-[5px] px-1.5 py-0.5 text-[10px] font-semibold nums',
            active ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-fg-muted'
          )}
        >
          {count}
        </span>
      ) : busy ? (
        <StatusDot tone="accent" pulse />
      ) : null}
    </button>
  )
}

const TERMINAL = new Set(['complete', 'failed', 'cancelled'])

/** Workspace navigation with a live summary of the local audio library. */
export function Sidebar(): ReactNode {
  const view = useApp((state) => state.view)
  const setView = useApp((state) => state.setView)
  const jobs = useApp((state) => state.queue.jobs)
  const library = useApp((state) => state.library)
  const engine = useApp((state) => state.engine)

  const activeJobs = jobs.filter((job) => !TERMINAL.has(job.stage)).length
  const engineReady = engine?.ready ?? false
  const librarySummary = useMemo(() => library.reduce((total, beat) => ({
    bytes: total.bytes + (Number.isFinite(beat.sizeBytes) ? beat.sizeBytes : 0),
    duration: total.duration + (Number.isFinite(beat.durationSec) ? beat.durationSec : 0)
  }), { bytes: 0, duration: 0 }), [library])
  const audioTime = librarySummary.duration >= 3600
    ? `${(librarySummary.duration / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`
    : librarySummary.duration >= 60
      ? `${Math.floor(librarySummary.duration / 60)}m`
      : `${Math.floor(librarySummary.duration)}s`

  const go = (next: ViewId): void => setView(next)

  return (
    <nav aria-label="Main navigation" className="flex w-[212px] shrink-0 flex-col overflow-y-auto bg-surface px-3 pt-5 pb-3 xl:w-[228px]">
      <p className="section-label mb-3 px-3">Workspace</p>
      <div className="space-y-1.5">
        <NavItem
          icon={<Download />}
          label="Download"
          active={view === 'download'}
          count={activeJobs || undefined}
          busy={activeJobs > 0}
          onClick={() => go('download')}
        />
        <NavItem
          icon={<Library />}
          label="Library"
          active={view === 'library'}
          count={library.length || undefined}
          onClick={() => go('library')}
        />
      </div>

      <div className="mx-3 mt-8 border-t border-line pt-5">
        <p className="section-label mb-4">Your collection</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[22px] font-medium leading-none tracking-[-0.06em] text-fg nums">{library.length.toLocaleString()}</p>
            <p className="mt-2 text-[10.5px] text-fg-subtle">Tracks</p>
          </div>
          <div>
            <p className="text-[22px] font-medium leading-none tracking-[-0.06em] text-fg nums">{audioTime}</p>
            <p className="mt-2 text-[10.5px] text-fg-subtle">Audio time</p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-1.5 text-[10.5px] text-fg-subtle">
          <HardDrive aria-hidden="true" className="size-3" />
          <span>{formatBytes(librarySummary.bytes)} in your library</span>
        </div>
      </div>

      <div className="min-h-8 flex-1" />

      <div className="mb-4">
        <p className="section-label mb-2 px-3">Preferences</p>
        <NavItem
          icon={<SettingsIcon />}
          label="Settings"
          active={view === 'settings'}
          onClick={() => go('settings')}
        />
      </div>

      <button
        type="button"
        aria-label="Media engine status. Open settings"
        onClick={() => go('settings')}
        className={cn(
          'group flex shrink-0 items-center gap-2.5 rounded-[10px] border border-line bg-surface-2/60 px-3 py-3 text-left',
          'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)] hover:border-line-strong hover:bg-surface-2'
        )}
        title={engine?.lastError ?? (engineReady ? 'Media engine ready' : 'Media engine setup required')}
      >
        <StatusDot tone={engineReady ? 'success' : 'warning'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium text-fg">
            {engineReady ? 'Engine ready' : 'Setup required'}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-fg-subtle">
            {engineReady ? 'Ready for downloads' : 'Finish setup in Settings'}
          </span>
        </span>
        <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle transition-colors group-hover:text-fg" />
      </button>
    </nav>
  )
}
