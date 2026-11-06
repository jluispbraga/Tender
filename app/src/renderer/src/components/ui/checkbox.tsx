import * as RCheckbox from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface CheckboxProps {
  /** Accessible name. Grids pass "Select <row name>". */
  label: string
  checked: boolean | 'indeterminate'
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

export function Checkbox({ label, checked, onCheckedChange, disabled, className }: CheckboxProps) {
  return (
    <RCheckbox.Root
      aria-label={label}
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-sm border border-line-strong bg-bg',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-on-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RCheckbox.Indicator>
        {checked === 'indeterminate' ? <Minus aria-hidden className="size-3" /> : <Check aria-hidden className="size-3" />}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  )
}
