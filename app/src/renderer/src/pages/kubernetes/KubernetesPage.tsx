import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Cable, Eye, Info, Loader2, Pencil, RefreshCw, RotateCw, Scale, Ship, SquareTerminal, Trash2 } from 'lucide-react'
import { api, type KubeAction, type KubeItem, type KubeKind, type KubeOverview } from '@/api'
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
import { ForwardDialog, ForwardsBar, type ForwardTarget } from './Forwards'
import { DataDialog, MoreKinds, kindLabel, type ChangeRequest, type DeleteRequest, type ScaleRequest } from './MoreKinds'
import { PodPanel, type PodTab } from './PodPanel'
import { Table } from './Table'

type Pod = KubeOverview['pods'][number]
type Tab = 'pods' | 'deployments' | 'services' | KubeKind
const tabs: Tab[] = ['pods', 'deployments', 'services', 'statefulsets', 'jobs', 'cronjobs', 'ingresses', 'configmaps', 'secrets']
const tabLabel = (t: Tab) => (t === 'pods' ? 'Pods' : t === 'deployments' ? 'Deployments' : t === 'services' ? 'Services' : kindLabel[t])
const isMore = (t: Tab): t is KubeKind => !['pods', 'deployments', 'services'].includes(t)

/** The clusters in the kubeconfig: pods, deployments, services, pod logs, and restart, scale, delete. */
export function KubernetesPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState<DeleteRequest | null>(null)
  const [scaling, setScaling] = useState<ScaleRequest | null>(null)
  const [viewing, setViewing] = useState<{ kind: 'configmaps' | 'secrets'; item: KubeItem } | null>(null)
  // Re-read every few seconds so a kubeconfig dropped into an added folder (or edited) shows up on its own.
  const contexts = useQuery({ queryKey: ['kube', 'contexts'], queryFn: () => api.kube.contexts(), refetchInterval: 10_000 })
  const problem = useQuery({ queryKey: ['kube', 'problem'], queryFn: () => api.kube.configProblem(), enabled: contexts.data?.length === 0 })
  const [ctx, setCtx] = useState<string | null>(null)
  const [ns, setNs] = useState<string>('*')
  const [tab, setTab] = useState<Tab>('pods')
  const [panel, setPanel] = useState<{ pod: Pod; tab: PodTab } | null>(null)
  const [forwarding, setForwarding] = useState<ForwardTarget | null>(null)
  const context = ctx ?? contexts.data?.find((c) => c.current)?.name ?? contexts.data?.[0]?.name ?? null
  const current = contexts.data?.find((c) => c.name === context)
  const settings = useSettings()
  const labels = settings.data?.kube_labels
  const here = clusterLabel(current, labels)
  const prod = here.env === 'prod'
  const [naming, setNaming] = useState(false)
  const [pendingChange, setPendingChange] = useState<ChangeRequest | null>(null)

  const namespaces = useQuery({ queryKey: ['kube', 'ns', context], queryFn: () => api.kube.namespaces(context!), enabled: !!context, retry: false })
  const overview = useQuery({ queryKey: ['kube', 'overview', context, ns], queryFn: () => api.kube.overview(context!, ns), enabled: !!context, refetchInterval: 5000, retry: false })

  const act = async (a: KubeAction) => {
    try {
      toast({ kind: 'success', title: await api.kube.act(context!, a) })
      if (a.kind === 'delete-pod' && panel?.pod.name === a.name) setPanel(null)
    } catch (e) {
      toast({ kind: 'error', title: 'Kubernetes refused that', body: (e as Error).message })
    }
    void overview.refetch()
    void queryClient.invalidateQueries({ queryKey: ['kube', 'list', context] })
  }
  // In production every change asks first; elsewhere only deletes do.
  const change = (r: ChangeRequest) => (prod ? setPendingChange(r) : void act(r.action))

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
  const counts: Partial<Record<Tab, number>> = { pods: data?.pods.length, deployments: data?.deployments.length, services: data?.services.length }

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
              setPanel(null)
            }}
            options={(contexts.data ?? []).map((c) => ({ value: c.name, label: optionText(c, clusterLabel(c, labels)) }))}
          />
        </div>
        <EnvBadge env={here.env} />
        {current && <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} aria-label="Name this cluster" onClick={() => setNaming(true)} />}
        <div className="w-44">
          <Select label="Namespace" value={ns} onValueChange={(v) => (setNs(v), setPanel(null))} options={[{ value: '*', label: 'All namespaces' }, ...(namespaces.data ?? []).map((n) => ({ value: n, label: n }))]} />
        </div>
        <a href={href('settings', 'general')} className="text-sm text-accent hover:underline">
          Kubeconfig files
        </a>
        <Button icon={<RotateCw />} loading={overview.isFetching || contexts.isFetching} onClick={() => (void contexts.refetch(), void namespaces.refetch(), void overview.refetch(), void queryClient.invalidateQueries({ queryKey: ['kube', 'list'] }))}>
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
        <ForwardsBar labelOf={(c) => clusterLabel(contexts.data?.find((x) => x.name === c), labels).label || c} />
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
            <div role="tablist" aria-label="Kind" className="flex shrink-0 flex-wrap gap-x-1 border-b border-line px-4">
              {tabs.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap', tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
                  {tabLabel(t)} {counts[t] !== undefined && <span className="text-muted tabular-nums">{counts[t]}</span>}
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
                    <Button size="sm" variant="ghost" icon={<Eye />} aria-label={`Logs of ${p.name}`} onClick={() => setPanel({ pod: p, tab: 'logs' })}>
                      Logs
                    </Button>,
                    <ActionsMenu
                      label={`Actions for ${p.name}`}
                      entries={[
                        { label: 'Details and events', icon: <Info />, onSelect: () => setPanel({ pod: p, tab: 'details' }) },
                        { label: 'Open a terminal', icon: <SquareTerminal />, onSelect: () => setPanel({ pod: p, tab: 'terminal' }) },
                        { label: 'Forward a port…', icon: <Cable />, onSelect: () => setForwarding({ kind: 'pod', namespace: p.namespace, name: p.name, ports: p.ports }) },
                        { kind: 'separator' },
                        { label: 'Delete pod', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete({ what: 'pod', namespace: p.namespace, name: p.name, impact: 'If a deployment owns it, Kubernetes starts a new pod in its place.', action: { kind: 'delete-pod', namespace: p.namespace, name: p.name } }) },
                      ]}
                    />,
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
                        { label: 'Restart', icon: <RefreshCw />, onSelect: () => change({ title: `Restart ${d.name} in production?`, description: `New pods replace the old ones one by one in ${here.label} / ${d.namespace}.`, label: 'Restart', action: { kind: 'restart-deployment', namespace: d.namespace, name: d.name } }) },
                        { label: 'Scale…', icon: <Scale />, onSelect: () => setScaling({ what: 'deployment', name: d.name, namespace: d.namespace, ready: d.ready, replicas: d.replicas, to: (n) => ({ kind: 'scale-deployment', namespace: d.namespace, name: d.name, replicas: n }) }) },
                        { kind: 'separator' },
                        { label: 'Delete deployment', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete({ what: 'deployment', namespace: d.namespace, name: d.name, impact: 'Its pods stop and are removed too.', action: { kind: 'delete-deployment', namespace: d.namespace, name: d.name } }) },
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
                    <ActionsMenu
                      label={`Actions for ${s.name}`}
                      entries={[
                        { label: 'Forward a port…', icon: <Cable />, onSelect: () => setForwarding({ kind: 'service', namespace: s.namespace, name: s.name, ports: s.portNumbers }) },
                        { kind: 'separator' },
                        { label: 'Delete service', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete({ what: 'service', namespace: s.namespace, name: s.name, impact: 'Pods behind it keep running, but nothing reaches them through this service.', action: { kind: 'delete-service', namespace: s.namespace, name: s.name } }) },
                      ]}
                    />,
                  ])}
                />
              )}
              {isMore(tab) && context && (
                <MoreKinds
                  context={context}
                  namespace={ns}
                  kind={tab}
                  clusterName={here.label}
                  onDelete={setPendingDelete}
                  onChange={change}
                  onScale={setScaling}
                  onView={(item) => setViewing({ kind: tab === 'secrets' ? 'secrets' : 'configmaps', item })}
                />
              )}
            </div>
            {panel && context && <PodPanel key={`${panel.pod.namespace}/${panel.pod.name}`} context={context} pod={panel.pod} tab={panel.tab} onTab={(t) => setPanel({ pod: panel.pod, tab: t })} onClose={() => setPanel(null)} />}
          </>
        )}
      </div>
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.what} ${pendingDelete?.name}?`}
        items={pendingDelete ? [`${here.label} / ${pendingDelete.namespace} / ${pendingDelete.name}`] : []}
        typeToConfirm={prod ? pendingDelete?.name : undefined}
        impact={pendingDelete?.impact}
        confirmLabel={`Delete ${pendingDelete?.what}`}
        onConfirm={async () => {
          await act(pendingDelete!.action)
          setPendingDelete(null)
        }}
      />
      {forwarding && context && <ForwardDialog context={context} clusterName={here.label} target={forwarding} onClose={() => setForwarding(null)} />}
      {viewing && context && <DataDialog context={context} kind={viewing.kind} item={viewing.item} onClose={() => setViewing(null)} />}
      {pendingChange && (
        <Modal
          open
          onOpenChange={(o) => !o && setPendingChange(null)}
          title={pendingChange.title}
          description={pendingChange.description}
          size="sm"
          footer={
            <>
              <Button onClick={() => setPendingChange(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const r = pendingChange
                  setPendingChange(null)
                  void act(r.action)
                }}
              >
                {pendingChange.label}
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
      {scaling && <ScaleDialog prod={prod} clusterName={here.label} target={scaling} onClose={() => setScaling(null)} onScale={(replicas) => act(scaling.to(replicas))} />}
    </>
  )
}

function ScaleDialog({ target: deployment, prod, clusterName, onClose, onScale }: { target: ScaleRequest; prod: boolean; clusterName: string; onClose: () => void; onScale: (replicas: number) => Promise<void> }) {
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
      description={`${clusterName} / ${deployment.namespace}. Ready now: ${deployment.ready}. 0 stops every pod and keeps the ${deployment.what}.`}
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
