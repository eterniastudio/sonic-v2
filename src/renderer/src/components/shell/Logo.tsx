import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Sonic's mark: a burst of level bars inside a rounded square.
 * Drawn rather than shipped as an asset so it inherits the accent colour.
 */
export function Logo({ size = 22, className }: { size?: number; className?: string }): ReactNode {
  const bars = [
    { x: 3.2, h: 7 },
    { x: 6.4, h: 12 },
    { x: 9.6, h: 5.5 },
    { x: 12.8, h: 14 },
    { x: 16, h: 9 },
    { x: 19.2, h: 6 }
  ]
  const centre = 10

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22.4 20"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id="sonic-mark" x1="0" y1="0" x2="22.4" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--sonic-accent)" />
          <stop offset="100%" stopColor="color-mix(in oklab, var(--sonic-accent) 45%, var(--sonic-cyan))" />
        </linearGradient>
      </defs>
      {bars.map((bar, index) => (
        <rect
          key={index}
          x={bar.x}
          y={centre - bar.h / 2}
          width="2"
          height={bar.h}
          rx="1"
          fill="url(#sonic-mark)"
        />
      ))}
    </svg>
  )
}

/** Logo plus wordmark, used in the title bar. */
export function Wordmark({ className }: { className?: string }): ReactNode {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Logo size={19} />
      <span className="text-[13px] font-semibold tracking-tight text-fg">
        Sonic <span className="text-fg-subtle">V2</span>
      </span>
    </span>
  )
}
