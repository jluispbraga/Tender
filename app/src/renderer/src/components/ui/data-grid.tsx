import { Fragment, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import * as RPopover from '@radix-ui/react-popover'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronRight, Columns3, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './button'
import { Checkbox } from './checkbox'

export interface GridGroup<T> {
  id: string
  label: ReactNode
  rows: T[]
}

export interface DataGridProps<T> {
  /** Accessible name of the table. */
  label: string
  columns: ColumnDef<T, any>[]
  /** Flat rows, or groups (Compose projects) rendered as collapsible header rows. */
  data: T[] | { groups: GridGroup<T>[]; ungrouped: T[] }
  getRowId: (row: T) => string
  getRowLabel: (row: T) => string
  rowSelection: RowSelectionState
  /** A state setter: functional updates must compose (several rows can change in one tick). */
  onRowSelectionChange: Dispatch<SetStateAction<RowSelectionState>>
  columnVisibility: VisibilityState
  onColumnVisibilityChange: (v: VisibilityState) => void
  onRowOpen?: (row: T) => void
  isRowBusy?: (row: T) => boolean
  rowActions?: (row: T) => ReactNode
  groupActions?: (group: GridGroup<T>) => ReactNode
  loading?: boolean
  empty?: ReactNode
}

/**
 * The list grid behind S03, S11 and S15. A real <table>: header sort buttons
 * expose aria-sort, rows open with Enter or click, checkboxes never open a row.
 * Virtualisation (TanStack Virtual) is added in replica-build when wired to
 * live data; the markup here stays the same.
 */
export function DataGrid<T>(p: DataGridProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const grouped = !Array.isArray(p.data)
  const flat = useMemo(
    () => (Array.isArray(p.data) ? p.data : [...p.data.groups.flatMap((g) => g.rows), ...p.data.ungrouped]),
    [p.data],
  )
  const groupOf = useMemo(() => {
    const m = new Map<string, string>()
    if (!Array.isArray(p.data)) for (const g of p.data.groups) for (const r of g.rows) m.set(p.getRowId(r), g.id)
    return m
  }, [p.data, p.getRowId])

  const table = useReactTable({
    data: flat,
    columns: p.columns,
    getRowId: (r) => p.getRowId(r),
    // size 0 = no fixed width; that column takes the remaining space.
    defaultColumn: { size: 0 },
    state: { sorting, rowSelection: p.rowSelection, columnVisibility: p.columnVisibility },
    onSortingChange: setSorting,
    onRowSelectionChange: (u) => p.onRowSelectionChange(u),
    onColumnVisibilityChange: (u) => p.onColumnVisibilityChange(typeof u === 'function' ? u(p.columnVisibility) : u),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
  })

  const rows = table.getRowModel().rows
  const visibleCols = table.getVisibleLeafColumns().length + 2
  const allSelected = table.getIsAllRowsSelected()
  const someSelected = table.getIsSomeRowsSelected()

  const renderRow = (row: (typeof rows)[number], indent = false) => {
    const busy = p.isRowBusy?.(row.original)
    return (
      <tr
        key={row.id}
        tabIndex={0}
        aria-selected={row.getIsSelected()}
        aria-busy={busy || undefined}
        onClick={() => p.onRowOpen?.(row.original)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) p.onRowOpen?.(row.original)
        }}
        className={cn(
          'group h-9 cursor-default border-b border-line text-sm focus-visible:outline-offset-[-2px]',
          row.getIsSelected() ? 'bg-selected' : 'hover:bg-hover',
        )}
      >
        <td className="w-10 pl-4">
          <Checkbox label={`Select ${p.getRowLabel(row.original)}`} checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(v)} />
        </td>
        {row.getVisibleCells().map((c, i) => (
          <td key={c.id} className={cn('max-w-0 truncate px-3 text-fg', indent && i === 0 && 'pl-8')}>
            {flexRender(c.column.columnDef.cell, c.getContext())}
          </td>
        ))}
        <td className="w-24 pr-3 text-right">
          <div className="flex items-center justify-end gap-1">
            {busy && <Loader2 aria-label="Working" className="size-4 animate-spin text-muted" />}
            {p.rowActions?.(row.original)}
          </div>
        </td>
      </tr>
    )
  }

  if (p.loading) {
    return (
      <div aria-busy className="flex flex-col">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex h-9 items-center gap-4 border-b border-line px-4">
            <span className="h-3 w-4 animate-pulse rounded-sm bg-neutral-bg" />
            <span className="h-3 animate-pulse rounded-sm bg-neutral-bg" style={{ width: `${30 + ((i * 17) % 40)}%` }} />
          </div>
        ))}
        <span className="sr-only">Loading</span>
      </div>
    )
  }

  if (!flat.length) return <>{p.empty}</>

  return (
    // `relative`: absolutely positioned bits inside rows (sr-only live regions,
    // Radix's hidden inputs) must be laid out against the table, not the page.
    // Otherwise every row below the fold makes the whole window scroll too.
    <table aria-label={p.label} className="relative w-full table-fixed border-collapse">
      <thead className="sticky top-0 z-10 bg-surface">
        <tr className="h-8 border-b border-line text-left">
          <th className="w-10 pl-4">
            <Checkbox
              label={allSelected ? 'Deselect all' : 'Select all'}
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={(v) => table.toggleAllRowsSelected(v)}
            />
          </th>
          {table.getFlatHeaders().map((h) => {
            const dir = h.column.getIsSorted()
            return (
              <th
                key={h.id}
                aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                style={h.column.columnDef.size ? { width: h.column.columnDef.size } : undefined}
                className="px-3 text-xs font-medium text-muted"
              >
                {h.column.getCanSort() ? (
                  <button type="button" onClick={h.column.getToggleSortingHandler()} className="inline-flex items-center gap-1 rounded-sm hover:text-fg">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {dir === 'asc' ? <ArrowUp aria-hidden className="size-3" /> : dir === 'desc' ? <ArrowDown aria-hidden className="size-3" /> : null}
                  </button>
                ) : (
                  flexRender(h.column.columnDef.header, h.getContext())
                )}
              </th>
            )
          })}
          <th className="w-24 pr-3">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {grouped
          ? (p.data as { groups: GridGroup<T>[]; ungrouped: T[] }).groups.map((g) => {
              const groupRows = rows.filter((r) => groupOf.get(r.id) === g.id)
              const isCollapsed = collapsed[g.id]
              const sel = groupRows.filter((r) => r.getIsSelected()).length
              return (
                <Fragment key={g.id}>
                  <tr className="h-9 border-b border-line bg-surface text-sm">
                    <td className="w-10 pl-4">
                      <Checkbox
                        label={`Select all in ${g.id}`}
                        checked={sel === groupRows.length && sel > 0 ? true : sel ? 'indeterminate' : false}
                        onCheckedChange={(v) =>
                          p.onRowSelectionChange((prev) => {
                            const next = { ...prev }
                            for (const r of groupRows) {
                              if (v) next[r.id] = true
                              else delete next[r.id]
                            }
                            return next
                          })
                        }
                      />
                    </td>
                    <td colSpan={visibleCols - 2} className="px-3">
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !isCollapsed }))}
                        className="inline-flex items-center gap-1.5 rounded-sm font-medium text-fg"
                      >
                        <ChevronRight aria-hidden className={cn('size-4 text-muted transition-transform duration-100', !isCollapsed && 'rotate-90')} />
                        {g.label}
                      </button>
                    </td>
                    <td className="w-24 pr-3 text-right">
                      <div className="flex items-center justify-end gap-1">{p.groupActions?.(g)}</div>
                    </td>
                  </tr>
                  {!isCollapsed && groupRows.map((r) => renderRow(r, true))}
                </Fragment>
              )
            })
          : null}
        {rows.filter((r) => !groupOf.has(r.id)).map((r) => renderRow(r))}
      </tbody>
    </table>
  )
}

/** Column picker popover. Choices persist via grid_preferences (replica-build). */
export function ColumnPicker({ columns, visibility, onChange }: { columns: { id: string; label: string }[]; visibility: VisibilityState; onChange: (v: VisibilityState) => void }) {
  return (
    <RPopover.Root>
      <RPopover.Trigger asChild>
        <Button variant="ghost" iconOnly aria-label="Choose columns" icon={<Columns3 />} />
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content align="end" sideOffset={4} className="z-50 flex w-56 flex-col gap-1 rounded-md border border-line bg-raised p-2 shadow-pop">
          <p className="px-1 pb-1 text-xs font-medium text-muted">Columns</p>
          {columns.map((c) => (
            <label key={c.id} className="flex h-7 items-center gap-2 rounded-sm px-1 text-sm text-fg hover:bg-hover">
              <Checkbox label={c.label} checked={visibility[c.id] !== false} onCheckedChange={(v) => onChange({ ...visibility, [c.id]: v })} />
              <span aria-hidden>{c.label}</span>
            </label>
          ))}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

/** Appears when rows are selected. Announces the count. */
export function BulkBar({ count, noun, children, onClear, note }: { count: number; noun: string; children: ReactNode; onClear: () => void; note?: string }) {
  if (!count) return null
  return (
    <div role="region" aria-label="Bulk actions" className="flex h-10 items-center gap-2 border-b border-line bg-selected px-4">
      <span role="status" className="text-sm font-medium text-fg">
        {count} {noun}
        {count === 1 ? '' : 's'} selected
      </span>
      {note && <span className="text-sm text-muted">· {note}</span>}
      <div className="flex-1" />
      {children}
      <Button variant="ghost" size="sm" iconOnly aria-label="Clear selection" icon={<X />} onClick={onClear} />
    </div>
  )
}
