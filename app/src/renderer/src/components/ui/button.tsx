import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'bg-raised text-fg border border-line hover:bg-hover',
  ghost: 'bg-transparent text-fg hover:bg-hover',
  danger: 'bg-danger-solid text-on-danger hover:bg-danger-solid-hover',
}

const sizes: Record<Size, string> = {
  sm: 'h-7 text-sm gap-1.5',
  md: 'h-8 text-base gap-2',
  lg: 'h-10 text-base gap-2',
}

// Padding is chosen per mode so two px-* classes never compete.
const padding: Record<Size, string> = { sm: 'px-2.5', md: 'px-3', lg: 'px-4' }
const iconSizes: Record<Size, string> = { sm: 'w-7', md: 'w-8', lg: 'w-10' }

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
  /** Icon-only button: children are dropped, `aria-label` is required. */
  iconOnly?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconOnly, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap select-none',
        'transition-colors duration-100 ease-standard [&>svg]:size-4',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        iconOnly ? iconSizes[size] : padding[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="animate-spin" /> : icon}
      {!iconOnly && children}
    </button>
  )
})
