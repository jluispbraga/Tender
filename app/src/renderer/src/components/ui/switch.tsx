import { useId } from 'react'
import * as RSwitch from '@radix-ui/react-switch'
import { cn } from '@/lib/cn'

export interface SwitchProps {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

export function Switch({ label, checked, onCheckedChange, disabled, className }: SwitchProps) {
  const id = useId()
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <RSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-pill border border-line-strong bg-neutral-bg transition-colors duration-100',
          'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <RSwitch.Thumb
          className={cn(
            'block size-3.5 translate-x-0.5 rounded-pill bg-muted transition-transform duration-100 ease-standard',
            'data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-on-accent',
          )}
        />
      </RSwitch.Root>
      <label htmlFor={id} className={cn('text-sm text-fg select-none', disabled && 'text-disabled')}>
        {label}
      </label>
    </div>
  )
}
