import { Check, Loader2, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface LayerProgress {
  id: string
  status: 'waiting' | 'downloading' | 'extracting' | 'done' | 'error'
  current?: number
  total?: number
}

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`)

/** Per-layer pull progress (S14). The overall figure is one live region; rows are not announced. */
export function ProgressList({ layers }: { layers: LayerProgress[] }) {
  const done = layers.filter((l) => l.status === 'done').length
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="text-sm text-muted">
        {done} of {layers.length} layers complete
      </p>
      <ul className="flex flex-col gap-1.5">
        {layers.map((l) => {
          const pct = l.total ? Math.round(((l.current ?? 0) / l.total) * 100) : l.status === 'done' ? 100 : 0
          return (
            <li key={l.id} className="grid grid-cols-[96px_1fr_120px] items-center gap-3 text-sm">
              <span className="truncate font-mono text-xs text-muted">{l.id}</span>
              <span aria-hidden className="h-1.5 overflow-hidden rounded-pill bg-neutral-bg">
                <span
                  className={cn('block h-full rounded-pill transition-[width] duration-150', l.status === 'error' ? 'bg-danger' : l.status === 'done' ? 'bg-success' : 'bg-accent')}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="flex items-center justify-end gap-1.5 text-xs text-muted tabular-nums">
                {l.status === 'done' && <Check aria-hidden className="size-3.5 text-success" />}
                {l.status === 'error' && <XCircle aria-hidden className="size-3.5 text-danger" />}
                {(l.status === 'downloading' || l.status === 'extracting') && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
                {l.status === 'downloading' && l.total ? `${fmt(l.current ?? 0)} / ${fmt(l.total)}` : l.status === 'waiting' ? 'Waiting' : l.status === 'extracting' ? 'Unpacking' : l.status === 'done' ? 'Done' : l.status === 'error' ? 'Failed' : ''}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
