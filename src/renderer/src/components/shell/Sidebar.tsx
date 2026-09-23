import type { ReactNode } from 'react'
import { Download, Library, Settings as SettingsIcon } from 'lucide-react'
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
        'group relative flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left',
        'transition-[background-color,color] duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
        active ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
      )}
    >
      {/* Accent rail marks the active view without shifting the label. */}
      <span
        aria-hidden
        className={cn(
          'absolute top-1/2 -left-2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent',
          'transition-[opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]',
          active ? 'scale-y-100 opacity-100' : 'scale-y-50 opacity-0'
        )}
      />
      <span className={cn('shrink-0 [&>svg]:size-4', active ? 'text-accent' : 'text-fg-subtle')}>
        {icon}
      </span>
      <span className="flex-1 truncate text-[13px] font-medium">{label}</span>
      {count != null && count > 0 ? (
        <span
          className={cn(
            'shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium nums',
            active ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-fg-subtle'
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

/** Left navigation rail with live queue and library counts. */
export function Sidebar(): ReactNode {
  const view = useApp((state) => state.view)
  const setView = useApp((state) => state.setView)
  const jobs = useApp((state) => state.queue.jobs)
  const library = useApp((state) => state.library)
  const engine = useApp((state) => state.engine)

  const activeJobs = jobs.filter((job) => !TERMINAL.has(job.stage)).length
  const engineReady = engine?.ready ?? false

  const go = (next: ViewId): void => setView(next)

  return (
    <nav className="flex w-[218px] shrink-0 flex-col border-r border-line bg-surface/40 px-2.5 py-3">
      <div className="space-y-0.5">
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
        <NavItem
          icon={<SettingsIcon />}
          label="Settings"
          active={view === 'settings'}
          onClick={() => go('settings')}
        />
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => go('settings')}
        className={cn(
          'flex items-center gap-2 rounded-[9px] px-2.5 py-2 text-left',
          'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
          'hover:bg-surface-2'
        )}
        title={engine?.lastError ?? (engineReady ? 'Media engine ready' : 'Media engine setup required')}
      >
        <StatusDot tone={engineReady ? 'success' : 'warning'} pulse={!engineReady} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px] font-medium text-fg-muted">
            {engineReady ? 'Engine ready' : 'Setup required'}
          </span>
          <span className="block truncate text-[10.5px] text-fg-subtle">
            {engine?.components.find((component) => component.name === 'yt-dlp')?.version
              ? `yt-dlp ${engine.components.find((component) => component.name === 'yt-dlp')?.version}`
              : 'yt-dlp not installed'}
          </span>
        </span>
      </button>
    </nav>
  )
}
