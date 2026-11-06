import type { ReactNode } from 'react'
import * as RTabs from '@radix-ui/react-tabs'
import { cn } from '@/lib/cn'

export interface TabItem {
  value: string
  label: string
  /** Disabled tabs stay focusable-skipped; give the reason as `disabledReason`. */
  disabled?: boolean
  disabledReason?: string
  content: ReactNode
}

/** Underline tabs. Arrow keys move between tabs (Radix roving focus). */
export function Tabs({ items, value, onValueChange, label }: { items: TabItem[]; value: string; onValueChange: (v: string) => void; label: string }) {
  return (
    <RTabs.Root value={value} onValueChange={onValueChange} className="flex min-h-0 flex-1 flex-col">
      <RTabs.List aria-label={label} className="flex shrink-0 gap-1 border-b border-line px-4">
        {items.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            disabled={t.disabled}
            title={t.disabled ? t.disabledReason : undefined}
            className={cn(
              '-mb-px h-9 border-b-2 border-transparent px-2.5 text-sm font-medium text-muted',
              'hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg',
              'disabled:cursor-not-allowed disabled:text-disabled',
            )}
          >
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map((t) => (
        <RTabs.Content key={t.value} value={t.value} className="min-h-0 flex-1 focus-visible:outline-offset-[-2px]">
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  )
}
