import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api } from '@/api'
import { ago } from '@/lib/format'
import { cn } from '@/lib/cn'
import { Table } from './Table'

/** What happened in the namespace, newest first; with "only problems", the warnings. */
export function EventsTab({ context, namespace, filter, problemsOnly, onOpenPod }: { context: string; namespace: string; filter: string; problemsOnly: boolean; onOpenPod: (namespace: string, name: string) => void }) {
  const q = useQuery({ queryKey: ['kube', 'events', context, namespace], queryFn: () => api.kube.events(context, namespace), refetchInterval: 5000, retry: false })
  if (q.isError) return <p className="m-6 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(q.error as Error).message}</p>
  if (!q.data)
    return (
      <p role="status" className="inline-flex items-center gap-2 p-6 text-sm text-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Reading events…
      </p>
    )
  const f = filter.toLowerCase()
  const shown = q.data.filter((e) => (!problemsOnly || e.type === 'Warning') && (!f || e.name.toLowerCase().includes(f) || e.reason.toLowerCase().includes(f)))
  if (!q.data.length) return <p className="p-6 text-sm text-muted">No events. Kubernetes keeps them for about an hour.</p>
  if (!shown.length && problemsOnly && !f) return <p className="p-6 text-sm text-muted">No warnings in the last hour or so. Everything here is running.</p>
  return (
    <Table
      label="Events"
      filter={filter}
      head={['Type', 'Reason', 'Object', 'Namespace', 'Message', 'Count', 'Last seen']}
      rows={shown.map((e) => [
        <span className={cn('font-medium', e.type === 'Warning' ? 'text-danger' : 'text-muted')}>{e.type}</span>,
        <span className="font-medium">{e.reason}</span>,
        e.kind === 'Pod' ? (
          <button className="text-left text-accent hover:underline" onClick={() => onOpenPod(e.namespace, e.name)}>
            {e.kind}/{e.name}
          </button>
        ) : (
          <span>
            {e.kind}/{e.name}
          </span>
        ),
        e.namespace,
        <span className="block max-w-xl text-xs break-words">{e.message}</span>,
        <span className="tabular-nums">{e.count}</span>,
        <span className="whitespace-nowrap">{e.lastSeen ? ago(e.lastSeen) : ''}</span>,
      ])}
    />
  )
}
