import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type Status =
  | 'running'
  | 'paused'
  | 'restarting'
  | 'created'
  | 'exited'
  | 'error'
  | 'in-use'
  | 'unused'
  | 'dangling'

const look: Record<Status, { label: string; tone: string; dot: string }> = {
  running: { label: 'Running', tone: 'bg-success-bg text-success', dot: 'bg-success' },
  paused: { label: 'Paused', tone: 'bg-warning-bg text-warning', dot: 'bg-warning' },
  restarting: { label: 'Restarting', tone: 'bg-warning-bg text-warning', dot: 'bg-warning animate-pulse' },
  created: { label: 'Created', tone: 'bg-neutral-bg text-muted', dot: 'bg-muted' },
  exited: { label: 'Exited', tone: 'bg-neutral-bg text-muted', dot: 'bg-muted' },
  error: { label: 'Failed', tone: 'bg-danger-bg text-danger', dot: 'bg-danger' },
  'in-use': { label: 'In use', tone: 'bg-success-bg text-success', dot: 'bg-success' },
  unused: { label: 'Unused', tone: 'bg-neutral-bg text-muted', dot: 'bg-muted' },
  dangling: { label: 'Untagged', tone: 'bg-warning-bg text-warning', dot: 'bg-warning' },
}

/** Status is carried by the text label, never by colour alone. */
export function StatusChip({ status, detail, className }: { status: Status; detail?: string; className?: string }) {
  const s = look[status]
  return (
    <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-pill px-2 text-xs whitespace-nowrap', s.tone, className)}>
      <span aria-hidden className={cn('size-1.5 rounded-pill', s.dot)} />
      {s.label}
      {detail && <span className="font-normal">({detail})</span>}
    </span>
  )
}

/** Small neutral tag, e.g. an image architecture running under emulation. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-sm border border-line px-1.5 font-mono text-xs text-muted">
      {children}
    </span>
  )
}
