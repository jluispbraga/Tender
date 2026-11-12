import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, Loader2, Pencil, RefreshCw, RotateCw, Scale, Ship, Trash2, X } from 'lucide-react'
import { api, type KubeAction, type KubeOverview } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Modal } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { ActionsMenu } from '@/components/ui/menu'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'
import { ago } from '@/lib/format'
import { cn } from '@/lib/cn'
import { setSetting, useSettings } from '@/lib/queries'
import { href } from '@/lib/router'
import { ClusterLabelDialog, EnvBadge, clusterLabel, optionText } from './ClusterLabel'

type Pod = KubeOverview['pods'][number]
type Deployment = KubeOverview['deployments'][number]
type Kind = 'pod' | 'deployment' | 'service'

/** The clusters in the kubeconfig: pods, deployments, services, pod logs, and restart, scale, delete. */
export function KubernetesPage() {
  const toast = useToast()
  const [pendingDelete, setPendingDelete] = useState<{ kind: Kind; namespace: string; name: string } | null>(null)
  const [scaling, setScaling] = useState<Deployment | null>(null)
  // Re-read every few seconds so a kubeconfig dropped into an added folder (or edited) shows up on its own.
  const contexts = useQuery({ queryKey: ['kube', 'contexts'], queryFn: () => api.kube.contexts(), refetchInterval: 10_000 })
  const problem = useQuery({ queryKey: ['kube', 'problem'], queryFn: () => api.kube.configProblem(), enabled: contexts.data?.length === 0 })
  const [ctx, setCtx] = useState<string | null>(null)
  const [ns, setNs] = useState<string>('*')
  const [tab, setTab] = useState<'pods' | 'deployments' | 'services'>('pods')
  const [logsOf, setLogsOf] = useState<{ pod: Pod; container: string } | null>(null)
  const context = ctx ?? contexts.data?.find((c) => c.current)?.name ?? contexts.data?.[0]?.name ?? null
  const current = contexts.data?.find((c) => c.name === context)
  const settings = useSettings()
  const labels = settings.data?.kube_labels
  const here = clusterLabel(current, labels)
  const prod = here.env === 'prod'
  const [naming, setNaming] = useState(false)
  const [pendingRestart, setPendingRestart] = useState<Deployment | null>(null)

  const namespaces = useQuery({ queryKey: ['kube', 'ns', context], queryFn: () => api.kube.namespaces(context!), enabled: !!context, retry: false })
  const overview = useQuery({ queryKey: ['kube', 'overview', context, ns], queryFn: () => api.kube.overview(context!, ns), enabled: !!context, refetchInterval: 5000, retry: false })

  const act = async (a: KubeAction) => {
    try {
      toast({ kind: 'success', title: await api.kube.act(context!, a) })
      if (a.kind === 'delete-pod' && logsOf?.pod.name === a.name) setLogsOf(null)
    } catch (e) {
      toast({ kind: 'error', title: 'Kubernetes refused that', body: (e as Error).message })
    }
    void overview.refetch()
  }

  if (contexts.data && !contexts.data.length) {
    const p = problem.data
    return (
      <>
        <PageHeader title="Kubernetes">
          <a href={href('settings', 'general')} className="text-sm text-accent hover:underline">
            Kubeconfig files
          </a>
          <Button icon={<RotateCw />} loading={contexts.isFetching} onClick={() => (void contexts.refetch(), void problem.refetch())}>
            Refresh
          </Button>
        </PageHeader>
        {p ? (
          <div className="p-6">
            <section aria-labelledby="kube-problem" className="flex max-w-2xl flex-col gap-3 rounded-lg border border-line p-4">
              <h2 id="kube-problem" className="text-md text-fg">
                Your kubeconfig has no usable context
              </h2>
              <p className="text-sm text-fg">{p.problem}</p>
              <p className="text-sm text-muted">{p.hint}</p>
              <p className="text-xs break-all text-muted">{p.path}</p>
            </section>
          </div>
        ) : (
          <EmptyState icon={<Ship />} title="No Kubernetes clusters" body="Tender reads ~/.kube/config (or KUBECONFIG) and any kubeconfig file or folder you add under Settings › Kubernetes. Create a cluster with kind, k3d or minikube, or add the file you got for an existing one." />
        )}
      </>
    )
  }

  const data = overview.data
  const counts = { pods: data?.pods.length, deployments: data?.deployments.length, services: data?.services.length }

  return (
    <>
      <PageHeader title="Kubernetes">
        <div className="w-80">
          <Select
            label="Context"
            value={context ?? ''}
            onValueChange={(v) => {
              setCtx(v)
              setNs('*')
              setLogsOf(null)
            }}
            options={(contexts.data ?? []).map((c) => ({ value: c.name, label: optionText(c, clusterLabel(c, labels)) }))}
          />
        </div>
        <EnvBadge env={here.env} />
        {current && <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} aria-label="Name this cluster" onClick={() => setNaming(true)} />}
        <div className="w-44">
          <Select label="Namespace" value={ns} onValueChange={(v) => (setNs(v), setLogsOf(null))} options={[{ value: '*', label: 'All namespaces' }, ...(namespaces.data ?? []).map((n) => ({ value: n, label: n }))]} />
        </div>
        <a href={href('settings', 'general')} className="text-sm text-accent hover:underline">
          Kubeconfig files
        </a>
        <Button icon={<RotateCw />} loading={overview.isFetching || contexts.isFetching} onClick={() => (void contexts.refetch(), void namespaces.refetch(), void overview.refetch())}>
          Refresh
        </Button>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <p className={cn('shrink-0 border-b px-5 py-2 text-sm', prod ? 'border-danger bg-danger-bg text-danger' : 'border-line text-muted')}>
          {prod ? 'Production cluster: restart, scale and delete change ' : 'Restart, scale and delete act on '}
          <span className={cn('font-medium', prod ? 'text-danger' : 'text-fg')}>{here.label}</span>
          {here.label !== current?.context && ` (context ${current?.context})`}
          {current?.server && ` at ${current.server}`}. {prod ? 'Every change asks first; deleting needs the name typed.' : 'Deleting always asks first.'}
          {current?.file && <span className="block truncate text-xs">From {current.file}</span>}
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
                  head={['Name', 'Namespace', 'Status', 'Ready', 'Restarts', 'Age', '', '']}
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
                    <ActionsMenu label={`Actions for ${p.name}`} entries={[{ label: 'Delete pod', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete({ kind: 'pod', namespace: p.namespace, name: p.name }) }]} />,
                  ])}
                />
              )}
              {tab === 'deployments' && (
                <Table
                  label="Deployments"
                  head={['Name', 'Namespace', 'Ready', 'Up to date', 'Images', '']}
                  rows={data.deployments.map((d) => [
                    <span className="font-medium">{d.name}</span>,
                    d.namespace,
                    d.ready,
                    d.upToDate,
                    <span className="font-mono text-xs">{d.images.join(', ')}</span>,
                    <ActionsMenu
                      label={`Actions for ${d.name}`}
                      entries={[
                        { label: 'Restart', icon: <RefreshCw />, onSelect: () => (prod ? setPendingRestart(d) : void act({ kind: 'restart-deployment', namespace: d.namespace, name: d.name })) },
                        { label: 'Scale…', icon: <Scale />, onSelect: () => setScaling(d) },
                        { kind: 'separator' },
                        { label: 'Delete deployment', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete({ kind: 'deployment', namespace: d.namespace, name: d.name }) },
                      ]}
                    />,
                  ])}
                />
              )}
              {tab === 'services' && (
                <Table
                  label="Services"
                  head={['Name', 'Namespace', 'Type', 'Cluster IP', 'Ports', '']}
                  rows={data.services.map((s) => [
                    <span className="font-medium">{s.name}</span>,
                    s.namespace,
                    s.type,
                    <span className="font-mono text-xs">{s.clusterIP}</span>,
                    s.ports.join(', '),
                    <ActionsMenu label={`Actions for ${s.name}`} entries={[{ label: 'Delete service', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete({ kind: 'service', namespace: s.namespace, name: s.name }) }]} />,
                  ])}
                />
              )}
            </div>
            {logsOf && context && <PodLogs key={`${logsOf.pod.namespace}/${logsOf.pod.name}/${logsOf.container}`} context={context} pod={logsOf.pod} container={logsOf.container} onContainer={(k) => setLogsOf({ pod: logsOf.pod, container: k })} onClose={() => setLogsOf(null)} />}
          </>
        )}
      </div>
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.kind} ${pendingDelete?.name}?`}
        items={pendingDelete ? [`${here.label} / ${pendingDelete.namespace} / ${pendingDelete.name}`] : []}
        typeToConfirm={prod ? pendingDelete?.name : undefined}
        impact={
          pendingDelete?.kind === 'pod'
            ? 'If a deployment owns it, Kubernetes starts a new pod in its place.'
            : pendingDelete?.kind === 'deployment'
              ? 'Its pods stop and are removed too.'
              : 'Pods behind it keep running, but nothing reaches them through this service.'
        }
        confirmLabel={`Delete ${pendingDelete?.kind}`}
        onConfirm={async () => {
          const p = pendingDelete!
          await act({ kind: `delete-${p.kind}`, namespace: p.namespace, name: p.name })
          setPendingDelete(null)
        }}
      />
      {pendingRestart && (
        <Modal
          open
          onOpenChange={(o) => !o && setPendingRestart(null)}
          title={`Restart ${pendingRestart.name} in production?`}
          description={`New pods replace the old ones one by one in ${here.label} / ${pendingRestart.namespace}.`}
          size="sm"
          footer={
            <>
              <Button onClick={() => setPendingRestart(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const d = pendingRestart
                  setPendingRestart(null)
                  void act({ kind: 'restart-deployment', namespace: d.namespace, name: d.name })
                }}
              >
                Restart
              </Button>
            </>
          }
        />
      )}
      {naming && current && (
        <ClusterLabelDialog
          context={current}
          current={here}
          onClose={() => setNaming(false)}
          onSave={async (v) => {
            const next = { ...(labels ?? {}) }
            if (v.name || v.env) next[current.key] = v
            else delete next[current.key]
            await setSetting('kube_labels', next)
            void settings.refetch()
          }}
        />
      )}
      {scaling && <ScaleDialog prod={prod} clusterName={here.label} deployment={scaling} onClose={() => setScaling(null)} onScale={(replicas) => act({ kind: 'scale-deployment', namespace: scaling.namespace, name: scaling.name, replicas })} />}
    </>
  )
}

function ScaleDialog({ deployment, prod, clusterName, onClose, onScale }: { deployment: Deployment; prod: boolean; clusterName: string; onClose: () => void; onScale: (replicas: number) => Promise<void> }) {
  const [value, setValue] = useState(String(deployment.replicas))
  const [busy, setBusy] = useState(false)
  const n = Number(value)
  const error = value === '' || !Number.isInteger(n) || n < 0 || n > 100 ? 'A whole number from 0 to 100.' : undefined
  const submit = async () => {
    if (error) return
    setBusy(true)
    await onScale(n)
    onClose()
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={prod ? `Scale ${deployment.name} in production` : `Scale ${deployment.name}`}
      description={`${clusterName} / ${deployment.namespace}. Ready now: ${deployment.ready}. 0 stops every pod and keeps the deployment.`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={prod ? 'danger' : 'primary'} loading={busy} disabled={!!error} onClick={() => void submit()}>
            Scale
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Input label="Pods" type="number" min={0} max={100} value={value} onChange={(e) => setValue(e.target.value)} error={error} autoFocus />
      </form>
    </Modal>
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
  // A crashing pod's current log is usually empty; why it crashed is in the run before.
  const crashing = pod.restarts > 0 && !/^Running$|^Completed$|^Succeeded$/.test(pod.status)
  const [previous, setPrevious] = useState(crashing)
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => {
    setLines([])
    setError(null)
    return api.kube.logs(context, pod.namespace, pod.name, container, (e) => (e.type === 'lines' ? setLines((ls) => [...ls, ...e.lines].slice(-2000)) : setError(e.message)), { previous })
  }, [context, pod.namespace, pod.name, container, previous])
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
        {pod.restarts > 0 && (
          <div role="radiogroup" aria-label="Which run" className="inline-flex rounded-md border border-line p-0.5">
            {([false, true] as const).map((p) => (
              <button
                key={String(p)}
                role="radio"
                aria-checked={previous === p}
                onClick={() => setPrevious(p)}
                className={cn('rounded px-2 py-0.5 text-xs', previous === p ? 'bg-selected font-medium text-fg' : 'text-muted hover:text-fg')}
              >
                {p ? 'Before the last restart' : 'Current run'}
              </button>
            ))}
          </div>
        )}
        <span className="text-muted">{previous ? `last 500 lines before restart ${pod.restarts}` : 'following the last 500 lines'}</span>
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
