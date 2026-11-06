import type { ReactNode } from 'react'
import * as RMenu from '@radix-ui/react-dropdown-menu'
import { MoreVertical } from 'lucide-react'
import { cn } from '@/lib/cn'

export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; disabledReason?: string; shortcut?: string }
  | { kind: 'separator' }

/** Row actions menu (kebab). Arrow keys, type-ahead, Escape (Radix). */
export function ActionsMenu({ label, entries, trigger }: { label: string; entries: MenuEntry[]; trigger?: ReactNode }) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={label}
            onClick={(e) => e.stopPropagation()}
            className="grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
          >
            <MoreVertical aria-hidden className="size-4" />
          </button>
        )}
      </RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content
          align="end"
          sideOffset={4}
          onClick={(e) => e.stopPropagation()}
          className="z-50 min-w-48 rounded-md border border-line bg-raised p-1 shadow-pop"
        >
          {entries.map((e, i) =>
            e.kind === 'separator' ? (
              <RMenu.Separator key={i} className="my-1 h-px bg-line" />
            ) : (
              <RMenu.Item
                key={e.label}
                disabled={e.disabled}
                onSelect={e.onSelect}
                title={e.disabled ? e.disabledReason : undefined}
                className={cn(
                  'flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-none select-none [&>svg]:size-4',
                  'data-[highlighted]:bg-hover data-[disabled]:text-disabled',
                  e.danger ? 'text-danger' : 'text-fg',
                )}
              >
                {e.icon}
                <span className="flex-1">{e.label}</span>
                {e.shortcut && <kbd className="font-sans text-xs text-muted">{e.shortcut}</kbd>}
              </RMenu.Item>
            ),
          )}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  )
}
