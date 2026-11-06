import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface NavItem {
  key: string
  label: string
  icon: ReactNode
  count?: number
}

/** Sidebar nav (S02). A <nav> landmark; the current item has aria-current="page". */
export function SidebarNav({
  items,
  current,
  onSelect,
  collapsed,
}: {
  items: NavItem[]
  current: string
  onSelect: (key: string) => void
  collapsed?: boolean
}) {
  return (
    <nav aria-label="Main" className={cn('flex flex-col gap-0.5 p-2', collapsed ? 'w-14' : 'w-[220px]')}>
      {items.map((i) => {
        const active = i.key === current
        return (
          <a
            key={i.key}
            href={`#/${i.key}`}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? i.label : undefined}
            onClick={(e) => {
              e.preventDefault()
              onSelect(i.key)
            }}
            className={cn(
              'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-base text-muted [&>svg]:size-4 [&>svg]:shrink-0',
              'hover:bg-hover hover:text-fg',
              active && 'bg-selected font-medium text-fg hover:bg-selected',
              collapsed && 'justify-center px-0',
            )}
          >
            {i.icon}
            {!collapsed && <span className="flex-1 truncate">{i.label}</span>}
            {!collapsed && i.count !== undefined && <span className="text-xs text-muted tabular-nums">{i.count}</span>}
          </a>
        )
      })}
    </nav>
  )
}

export type EngineState = 'running' | 'starting' | 'stopped' | 'error'

const engineLook: Record<EngineState, { label: string; dot: string }> = {
  running: { label: 'Engine running', dot: 'bg-success' },
  starting: { label: 'Engine starting', dot: 'bg-warning animate-pulse' },
  stopped: { label: 'Engine stopped', dot: 'bg-muted' },
  error: { label: 'Engine unreachable', dot: 'bg-danger' },
}

/** Footer status pill. Changes are announced (role="status"). */
export function EnginePill({ state, detail }: { state: EngineState; detail?: string }) {
  const s = engineLook[state]
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-xs text-fg">
      <span aria-hidden className={cn('size-2 rounded-pill', s.dot)} />
      {s.label}
      {detail && <span className="font-normal text-muted">· {detail}</span>}
    </span>
  )
}

/** Footer CPU / RAM meter. Value is in text; the bar is decorative. */
export function ResourceMeter({ label, value, max, format }: { label: string; value: number; max: number; format: (v: number) => string }) {
  const pct = Math.min(100, Math.round((value / max) * 100))
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      {label}
      <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-pill bg-neutral-bg">
        <span className={cn('block h-full rounded-pill', pct > 85 ? 'bg-danger' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-fg tabular-nums">{format(value)}</span>
    </span>
  )
}
