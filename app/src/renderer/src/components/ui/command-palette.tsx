import type { ReactNode } from 'react'
import { Command } from 'cmdk'
import * as RDialog from '@radix-ui/react-dialog'
import { Search } from 'lucide-react'

export interface PaletteGroup {
  heading: string
  items: { id: string; label: string; hint?: string; icon?: ReactNode; onSelect: () => void }[]
}

/** Quick search (S19), Ctrl+K. Combobox semantics from cmdk; focus trap from Radix Dialog. */
export function CommandPalette({ open, onOpenChange, groups }: { open: boolean; onOpenChange: (o: boolean) => void; groups: PaletteGroup[] }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-overlay/50" />
        <RDialog.Content aria-describedby={undefined} className="fixed top-[15vh] left-1/2 z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-raised shadow-modal">
          <RDialog.Title className="sr-only">Quick search</RDialog.Title>
          <Command label="Quick search" className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search aria-hidden className="size-4 text-muted" />
              <Command.Input placeholder="Find a container, image or volume" className="h-11 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-muted" />
              <kbd className="rounded-sm border border-line px-1.5 text-xs text-muted">Esc</kbd>
            </div>
            <Command.List className="max-h-80 overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted">Nothing matches that.</Command.Empty>
              {groups.map((g) => (
                <Command.Group key={g.heading} heading={g.heading} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted">
                  {g.items.map((i) => (
                    <Command.Item
                      key={i.id}
                      value={`${g.heading} ${i.label}`}
                      onSelect={() => {
                        i.onSelect()
                        onOpenChange(false)
                      }}
                      className="flex h-9 cursor-default items-center gap-2.5 rounded-sm px-2 text-sm text-fg data-[selected=true]:bg-hover [&>svg]:size-4 [&>svg]:text-muted"
                    >
                      {i.icon}
                      <span className="flex-1 truncate">{i.label}</span>
                      {i.hint && <span className="truncate text-xs text-muted">{i.hint}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
