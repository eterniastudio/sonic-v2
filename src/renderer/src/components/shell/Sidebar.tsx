import type { ReactNode } from 'react'
import { Download, Library, Settings as SettingsIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useApp, type ViewId } from '@/store/app'

interface NavItemProps {
  icon: ReactNode
  label: string
  active: boolean
  onClick: () => void
}

function NavItem({ icon, label, active, onClick }: NavItemProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-[34px] w-full items-center gap-2.5 rounded-[5px] px-3 text-left',
        'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
        active ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg'
      )}
    >
      <span aria-hidden="true" className={cn('shrink-0 [&>svg]:size-4 [&>svg]:stroke-[1.6]', active ? 'text-fg' : 'text-fg-subtle group-hover:text-fg-muted')}>
        {icon}
      </span>
      <span className="truncate text-[13px] font-medium">{label}</span>
    </button>
  )
}

/** The persistent workspace navigation. */
export function Sidebar(): ReactNode {
  const view = useApp((state) => state.view)
  const setView = useApp((state) => state.setView)
  const engine = useApp((state) => state.engine)

  const engineReady = engine?.ready ?? false

  const go = (next: ViewId): void => setView(next)

  return (
    <nav aria-label="Main navigation" className="flex w-[180px] shrink-0 flex-col overflow-y-auto bg-bg-deep px-2.5 py-3">
      <div className="space-y-1">
        <NavItem
          icon={<Download />}
          label="Download"
          active={view === 'download'}
          onClick={() => go('download')}
        />
        <NavItem
          icon={<Library />}
          label="Library"
          active={view === 'library'}
          onClick={() => go('library')}
        />
      </div>

      <div className="min-h-8 flex-1" />

      <NavItem
        icon={<SettingsIcon />}
        label="Settings"
        active={view === 'settings'}
        onClick={() => go('settings')}
      />

      <button
        type="button"
        aria-label="Media engine status. Open settings"
        onClick={() => go('settings')}
        className={cn(
          'mt-2 flex h-8 shrink-0 items-center gap-2 rounded-[5px] px-3 text-left text-[11px] text-fg-subtle',
          'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)] hover:text-fg-muted'
        )}
        title={engine?.lastError ?? (engineReady ? 'Media engine ready' : 'Media engine setup required')}
      >
        <span aria-hidden="true" className={cn('size-1 shrink-0 rounded-full', engineReady ? 'bg-fg-subtle' : 'bg-warning')} />
        <span className="truncate">{engineReady ? 'Engine ready' : 'Setup required'}</span>
      </button>
    </nav>
  )
}
