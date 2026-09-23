import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

const button = cva(
  [
    'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium',
    'no-drag disabled:pointer-events-none disabled:opacity-40',
    'active:scale-[0.985]',
    'transition-[background-color,border-color,color,box-shadow,transform,opacity]',
    'duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]'
  ],
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg shadow-accent hover:bg-[var(--sonic-accent-hover)]',
        secondary:
          'border border-line bg-surface-2 text-fg hover:border-line-strong hover:bg-surface-3',
        outline: 'border border-line-strong text-fg hover:bg-surface-2',
        ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
        danger: 'border border-danger/35 bg-danger/12 text-danger hover:bg-danger/20',
        quiet: 'bg-accent-soft text-accent hover:bg-[var(--sonic-accent-line)]'
      },
      size: {
        xs: 'h-7 rounded-[7px] px-2.5 text-[11.5px]',
        sm: 'h-8 rounded-[9px] px-3 text-[13px]',
        md: 'h-9.5 rounded-[10px] px-4 text-[13.5px]',
        lg: 'h-11 rounded-[12px] px-5 text-[15px]',
        icon: 'h-9 w-9 rounded-[10px]',
        'icon-sm': 'h-8 w-8 rounded-[8px]',
        'icon-xs': 'h-6.5 w-6.5 rounded-[6px]'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  leading?: ReactNode
  trailing?: ReactNode
  /** Renders a shimmering label while an action is in flight. */
  busy?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, leading, trailing, busy, disabled, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      className={cn(button({ variant, size }), className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {leading ? <span className="shrink-0 [&>svg]:size-4">{leading}</span> : null}
      <span className="truncate">{children}</span>
      {trailing ? <span className="shrink-0 [&>svg]:size-4">{trailing}</span> : null}
    </button>
  )
})

/** Square icon-only button with an accessible label. */
export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'leading' | 'trailing'> {
  label: string
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, variant = 'ghost', size = 'icon', className, ...props },
  ref
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      className={cn('px-0', className)}
      {...props}
    >
      <span className="grid place-items-center [&>svg]:size-4">{children}</span>
    </Button>
  )
})
