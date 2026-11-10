import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, Loader2, RotateCw, Ship, X } from 'lucide-react'
import { api, type KubeOverview } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Select } from '@/components/ui/select'
import { ago } from '@/lib/format'
import { cn } from '@/lib/cn'

type Pod = KubeOverview['pods'][number]

/** A read-only view of the clusters in the kubeconfig: pods, deployments, services, pod logs. */
export function KubernetesPage() {
  const contexts = useQuery({ queryKey: ['kube', 'contexts'], queryFn: () => api.kube.contexts() })
  const [ctx, setCtx] = useState<string | null>(null)
  const [ns, setNs] = useState<string>('*')
  const [tab, setTab] = useState<'pods' | 'deployments' | 'services'>('pods')
  const [logsOf, setLogsOf] = useState<{ pod: Pod; container: string } | null>(null)
  const context = ctx ?? contexts.data?.find((c) => c.current)?.name ?? contexts.data?.[0]?.name ?? null

  const namespaces = useQuery({ queryKey: ['kube', 'ns', context], queryFn: () => api.kube.namespaces(context!), enabled: !!context, retry: false })
  const overview = useQuery({ queryKey: ['kube', 'overview', context, ns], queryFn: () => api.kube.overview(context!, ns), enabled: !!context, refetchInterval: 5000, retry: false })

  if (contexts.data && !contexts.data.length) {
    return (
      <>
        <PageHeader title="Kubernetes" />
        <EmptyState icon={<Ship />} title="No Kubernetes clusters" body="Tender shows the clusters in your kubeconfig (~/.kube/config, or KUBECONFIG). Create one with kind, k3d or minikube and it appears here." />
      </>
    )
  }

  const data = overview.data
  const counts = { pods: data?.pods.length, deployments: data?.deployments.length, services: data?.services.length }

  return (
    <>
      <PageHeader title="Kubernetes">
        <div className="w-52">
          <Select
            label="Context"
            value={context ?? ''}
            onValueChange={(v) => {
              setCtx(v)
              setNs('*')
              setLogsOf(null)
            }}
            options={(contexts.data ?? []).map((c) => ({ value: c.name, label: c.name }))}
          />
        </div>
        <div className="w-44">
          <Select label="Namespace" value={ns} onValueChange={(v) => (setNs(v), setLogsOf(null))} options={[{ value: '*', label: 'All namespaces' }, ...(namespaces.data ?? []).map((n) => ({ value: n, label: n }))]} />
        </div>
        <Button icon={<RotateCw />} loading={overview.isFetching} onClick={() => void overview.refetch()}>
          Refresh
        </Button>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 border-b border-line px-5 py-2 text-sm text-muted">
          Read-only: Tender lists and shows logs, and never changes anything in a cluster.
          {contexts.data?.find((c) => c.name === context)?.server && ` · ${contexts.data.find((c) => c.name === context)!.server}`}
        </p>
        {overview.isError ? (
          <div className="p-6">
            <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(overview.error as Error).message}</p>
          </div>
        ) : !data ? (
          <p role="status" className="inline-flex items-center gap-2 p-6 text-sm text-muted">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Asking {context}…
          </p>
        ) : (
          <>
            <div role="tablist" aria-label="Kind" className="flex shrink-0 gap-1 border-b border-line px-4">
              {(['pods', 'deployments', 'services'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm capitalize', tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
                  {t} <span className="text-muted tabular-nums">{counts[t]}</span>
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {tab === 'pods' && (
                <Table
                  label="Pods"
                  head={['Name', 'Namespace', 'Status', 'Ready', 'Restarts', 'Age', '']}
                  rows={data.pods.map((p) => [
                    <span className="font-medium">{p.name}</span>,
                    p.namespace,
                    <span className={/Running|Completed|Succeeded/.test(p.status) ? 'text-success' : /Pending|ContainerCreating|Terminating/.test(p.status) ? 'text-muted' : 'text-danger'}>{p.status}</span>,
                    p.ready,
                    p.restarts,
                    ago(p.createdAt),
                    <Button size="sm" variant="ghost" icon={<Eye />} aria-label={`Logs of ${p.name}`} onClick={() => setLogsOf({ pod: p, container: p.containers[0] })}>
                      Logs
                    </Button>,
                  ])}
                />
              )}
              {tab === 'deployments' && <Table label="Deployments" head={['Name', 'Namespace', 'Ready', 'Up to date', 'Images']} rows={data.deployments.map((d) => [<span className="font-medium">{d.name}</span>, d.namespace, d.ready, d.upToDate, <span className="font-mono text-xs">{d.images.join(', ')}</span>])} />}
              {tab === 'services' && <Table label="Services" head={['Name', 'Namespace', 'Type', 'Cluster IP', 'Ports']} rows={data.services.map((s) => [<span className="font-medium">{s.name}</span>, s.namespace, s.type, <span className="font-mono text-xs">{s.clusterIP}</span>, s.ports.join(', ')])} />}
            </div>
            {logsOf && context && <PodLogs key={`${logsOf.pod.namespace}/${logsOf.pod.name}/${logsOf.container}`} context={context} pod={logsOf.pod} container={logsOf.container} onContainer={(k) => setLogsOf({ pod: logsOf.pod, container: k })} onClose={() => setLogsOf(null)} />}
          </>
        )}
      </div>
    </>
  )
}

function Table({ label, head, rows }: { label: string; head: string[]; rows: React.ReactNode[][] }) {
  if (!rows.length) return <p className="p-6 text-sm text-muted">No {label.toLowerCase()} here.</p>
  return (
    <table aria-label={label} className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          {head.map((h, i) => (
            <th key={i} scope="col" className="px-4 py-2 font-medium">
              {h || <span className="sr-only">Actions</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line">
            {r.map((cell, j) => (
              <td key={j} className="px-4 py-1.5 text-fg">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PodLogs({ context, pod, container, onContainer, onClose }: { context: string; pod: Pod; container: string; onContainer: (c: string) => void; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => api.kube.logs(context, pod.namespace, pod.name, container, (e) => (e.type === 'lines' ? setLines((ls) => [...ls, ...e.lines].slice(-2000)) : setError(e.message))), [context, pod.namespace, pod.name, container])
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines])
  return (
    <section aria-label={`Logs of ${pod.name}`} className="flex h-72 shrink-0 flex-col border-t border-line">
      <div className="flex shrink-0 items-center gap-3 px-4 py-2 text-sm">
        <span className="font-medium text-fg">{pod.name}</span>
        {pod.containers.length > 1 && (
          <div className="w-40">
            <Select label="Container" value={container} onValueChange={onContainer} options={pod.containers.map((k) => ({ value: k, label: k }))} />
          </div>
        )}
        <span className="text-muted">following the last 500 lines</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" iconOnly aria-label="Close logs" icon={<X />} onClick={onClose} />
      </div>
      {error && <p className="mx-4 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <pre ref={box} tabIndex={0} aria-label="Log lines" className="min-h-0 flex-1 overflow-auto bg-term-bg px-4 py-2 font-mono text-xs whitespace-pre-wrap text-term-text">
        {lines.join('\n')}
      </pre>
    </section>
  )
}
