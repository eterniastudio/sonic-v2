import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface SettingsPanelProps {
  title: string
  description?: string
  accessory?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}

/** Consistent, readable preference groups with room for labels and controls. */
export function SettingsPanel({
  title,
  description,
  accessory,
  children,
  className,
  bodyClassName
}: SettingsPanelProps): ReactNode {
  return (
    <section className={cn('studio-panel overflow-hidden', className)}>
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-fg">{title}</h3>
          {description ? (
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{description}</p>
          ) : null}
        </div>
        {accessory ? <div className="shrink-0 pt-0.5">{accessory}</div> : null}
      </div>
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </section>
  )
}
