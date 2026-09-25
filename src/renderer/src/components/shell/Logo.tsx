import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * A compact level-meter mark, drawn with the active theme's accent.
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }): ReactNode {
  const bars = [
    { x: 6, h: 6 },
    { x: 9.5, h: 11 },
    { x: 13, h: 16 },
    { x: 16.5, h: 10 },
    { x: 20, h: 5 }
  ]
  const centre = 14

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <rect x="0.5" y="0.5" width="27" height="27" rx="8" fill="var(--sonic-accent-softer)" stroke="var(--sonic-accent-line)" />
      {bars.map((bar, index) => (
        <rect
          key={index}
          x={bar.x}
          y={centre - bar.h / 2}
          width="2"
          height={bar.h}
          rx="1"
          fill="var(--sonic-accent)"
        />
      ))}
    </svg>
  )
}

/** Logo plus wordmark, used in the title bar. */
export function Wordmark({ className }: { className?: string }): ReactNode {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <Logo size={25} />
      <span className="text-[15px] font-semibold tracking-[-0.045em] text-fg">
        Sonic
      </span>
      <span className="rounded border border-line px-1 py-px text-[9px] font-semibold leading-none tracking-[0.03em] text-fg-subtle">V2</span>
    </span>
  )
}
