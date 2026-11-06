import * as RSelect from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface SelectOption {
  value: string
  label: string
}

/** Single-select dropdown, used for list filters (S11 In use / Unused / Untagged). */
export function Select({
  label,
  value,
  onValueChange,
  options,
  className,
}: {
  label: string
  value: string
  onValueChange: (v: string) => void
  options: SelectOption[]
  className?: string
}) {
  return (
    <RSelect.Root value={value} onValueChange={onValueChange}>
      <RSelect.Trigger
        aria-label={label}
        className={cn(
          'inline-flex h-8 items-center justify-between gap-2 rounded-md border border-line-strong bg-bg px-2.5 text-base whitespace-nowrap text-fg',
          'data-[placeholder]:text-muted',
          className,
        )}
      >
        <RSelect.Value />
        <RSelect.Icon>
          <ChevronDown aria-hidden className="size-4 text-muted" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content position="popper" sideOffset={4} className="z-50 min-w-[var(--radix-select-trigger-width)] rounded-md border border-line bg-raised p-1 shadow-pop">
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                className="relative flex h-8 cursor-default items-center gap-2 rounded-sm pr-2 pl-7 text-sm text-fg outline-none select-none data-[highlighted]:bg-hover"
              >
                <RSelect.ItemIndicator className="absolute left-2">
                  <Check aria-hidden className="size-4" />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}
