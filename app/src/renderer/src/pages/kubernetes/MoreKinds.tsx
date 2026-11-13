import { useQuery } from '@tanstack/react-query'
import { Eye, KeyRound, Loader2, Pause, Play, RefreshCw, Rocket, Scale, Trash2 } from 'lucide-react'
import { api, type KubeAction, type KubeItem, type KubeKind } from '@/api'
import { Modal } from '@/components/ui/dialog'
import { ActionsMenu, type MenuEntry } from '@/components/ui/menu'
import { ago } from '@/lib/format'
import { Table } from './Table'

export const kindLabel: Record<KubeKind, string> = { statefulsets: 'StatefulSets', jobs: 'Jobs', cronjobs: 'CronJobs', ingresses: 'Ingresses', configmaps: 'ConfigMaps', secrets: 'Secrets' }
const one: Record<KubeKind, string> = { statefulsets: 'StatefulSet', jobs: 'job', cronjobs: 'CronJob', ingresses: 'ingress', configmaps: 'ConfigMap', secrets: 'secret' }

const deleteImpact: Record<KubeKind, string> = {
  statefulsets: 'Its pods stop and are removed. Their volumes (PersistentVolumeClaims) stay, with the data.',
  jobs: 'Its pods are removed too, and their logs with them.',
  cronjobs: 'No more scheduled runs. The jobs it already made are removed too.',
  ingresses: 'Traffic from outside the cluster stops reaching the services behind it.',
  configmaps: 'Running pods keep what they read. Pods that start later and need it will not start.',
  secrets: 'Running pods keep what they read. Pods that start later and need it will not start.',
}

/** What the page needs to ask before a change: deletes always, every other change in production. */
export type DeleteRequest = { what: string; namespace: string; name: string; impact: string; action: KubeAction }
export type ChangeRequest = { title: string; description: string; label: string; action: KubeAction }
export type ScaleRequest = { what: string; name: string; namespace: string; ready: string; replicas: number; to: (n: number) => KubeAction }

type Col = { head: string; cell: (i: KubeItem) => React.ReactNode }
const name: Col = { head: 'Name', cell: (i) => <span className="font-medium">{i.name}</span> }
const nsCol: Col = { head: 'Namespace', cell: (i) => i.namespace }
const age: Col = { head: 'Age', cell: (i) => ago(i.createdAt) }
const f = (head: string, key: string, mono = false): Col => ({ head, cell: (i) => (mono ? <span className="font-mono text-xs">{i.fields[key]}</span> : i.fields[key]) })
const statusTone = (s: string) => (s === 'Complete' ? 'text-success' : s === 'Failed' ? 'text-danger' : 'text-muted')

const columns: Record<KubeKind, Col[]> = {
  statefulsets: [name, nsCol, f('Ready', 'ready'), f('Images', 'images', true), age],
  jobs: [name, nsCol, { head: 'Status', cell: (i) => <span className={statusTone(i.fields.status)}>{i.fields.status}</span> }, f('Completions', 'completions'), f('Duration', 'duration'), f('From', 'owner'), age],
  cronjobs: [
    name,
    nsCol,
    { head: 'Schedule', cell: (i) => <span className="font-mono text-xs">{i.fields.schedule}{i.fields.timeZone && ` (${i.fields.timeZone})`}</span> },
    { head: 'State', cell: (i) => (i.suspended ? <span className="text-danger">Paused</span> : <span className="text-success">Active</span>) },
    f('Running', 'active'),
    { head: 'Last run', cell: (i) => (i.fields.lastSchedule ? ago(i.fields.lastSchedule) : 'never') },
  ],
  ingresses: [name, nsCol, f('Class', 'class'), f('Hosts', 'hosts', true), f('Address', 'address', true), f('Ports', 'ports'), age],
  configmaps: [name, nsCol, { head: 'Keys', cell: (i) => <KeyList item={i} /> }, age],
  secrets: [name, nsCol, f('Type', 'type', true), { head: 'Keys', cell: (i) => <KeyList item={i} /> }, age],
}

function KeyList({ item }: { item: KubeItem }) {
  return (
    <span className="block max-w-md truncate" title={item.fields.keys}>
      <span className="tabular-nums">{item.fields.count}</span>
      {item.fields.keys && <span className="text-muted"> · {item.fields.keys}</span>}
    </span>
  )
}

export function MoreKinds({
  context,
  namespace,
  kind,
  clusterName,
  onDelete,
  onChange,
  onScale,
  onView,
}: {
  context: string
  namespace: string
  kind: KubeKind
  clusterName: string
  onDelete: (r: DeleteRequest) => void
  /** A change that is not a delete: the page runs it, asking first in production. */
  onChange: (r: ChangeRequest) => void
  onScale: (r: ScaleRequest) => void
  onView: (i: KubeItem) => void
}) {
  const q = useQuery({ queryKey: ['kube', 'list', context, namespace, kind], queryFn: () => api.kube.list(context, namespace, kind), refetchInterval: 5000, retry: false })
  if (q.isError) return <p className="m-6 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(q.error as Error).message}</p>
  if (!q.data)
    return (
      <p role="status" className="inline-flex items-center gap-2 p-6 text-sm text-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Reading {kindLabel[kind].toLowerCase()}…
      </p>
    )
  const cols = columns[kind]
  const entries = (i: KubeItem): MenuEntry[] => {
    const at = { namespace: i.namespace, name: i.name }
    const where = `${clusterName} / ${i.namespace}`
    const own: MenuEntry[] =
      kind === 'statefulsets'
        ? [
            { label: 'Restart', icon: <RefreshCw />, onSelect: () => onChange({ title: `Restart ${i.name} in production?`, description: `Its pods are replaced one at a time in ${where}.`, label: 'Restart', action: { kind: 'restart-statefulset', ...at } }) },
            { label: 'Scale…', icon: <Scale />, onSelect: () => onScale({ what: 'StatefulSet', ...at, ready: i.fields.ready, replicas: i.replicas ?? 0, to: (n) => ({ kind: 'scale-statefulset', ...at, replicas: n }) }) },
          ]
        : kind === 'cronjobs'
          ? [
              { label: 'Run now', icon: <Rocket />, onSelect: () => onChange({ title: `Run ${i.name} now in production?`, description: `Starts a job from ${i.name} in ${where}, outside its schedule.`, label: 'Run now', action: { kind: 'run-cronjob', ...at } }) },
              i.suspended
                ? { label: 'Resume schedule', icon: <Play />, onSelect: () => onChange({ title: `Resume ${i.name} in production?`, description: `It runs on its schedule (${i.fields.schedule}) again in ${where}.`, label: 'Resume', action: { kind: 'suspend-cronjob', ...at, suspend: false } }) }
                : { label: 'Pause schedule', icon: <Pause />, onSelect: () => onChange({ title: `Pause ${i.name} in production?`, description: `No new runs in ${where} until you resume it. A run in progress finishes.`, label: 'Pause', action: { kind: 'suspend-cronjob', ...at, suspend: true } }) },
            ]
          : kind === 'configmaps'
            ? [{ label: 'View data', icon: <Eye />, onSelect: () => onView(i) }]
            : kind === 'secrets'
              ? [{ label: 'Show keys', icon: <KeyRound />, onSelect: () => onView(i) }]
              : []
    return [...own, ...(own.length ? [{ kind: 'separator' as const }] : []), { label: `Delete ${one[kind]}`, icon: <Trash2 />, danger: true, onSelect: () => onDelete({ what: one[kind], ...at, impact: deleteImpact[kind], action: { kind: 'delete', resource: kind, ...at } }) }]
  }
  return <Table label={kindLabel[kind]} head={[...cols.map((c) => c.head), '']} rows={q.data.map((i) => [...cols.map((c) => c.cell(i)), <ActionsMenu label={`Actions for ${i.name}`} entries={entries(i)} />])} />
}

/** A ConfigMap's keys and values, or a Secret's keys and sizes. */
export function DataDialog({ context, kind, item, onClose }: { context: string; kind: 'configmaps' | 'secrets'; item: KubeItem; onClose: () => void }) {
  const d = useQuery({ queryKey: ['kube', 'data', context, item.namespace, kind, item.name], queryFn: () => api.kube.data(context, item.namespace, kind, item.name), retry: false })
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${kind === 'secrets' ? 'Secret' : 'ConfigMap'} ${item.name}`}
      description={kind === 'secrets' ? `${item.namespace}. ${d.data?.type ?? ''} Values stay hidden: Tender never reads them out of the cluster.` : item.namespace}
      size="md"
    >
      {d.isError ? (
        <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(d.error as Error).message}</p>
      ) : !d.data ? (
        <p className="text-sm text-muted">Reading…</p>
      ) : !d.data.entries.length ? (
        <p className="text-sm text-muted">No keys.</p>
      ) : (
        <dl className="flex max-h-[60vh] flex-col gap-3 overflow-auto">
          {d.data.entries.map((e) => (
            <div key={e.key}>
              <dt className="flex gap-2 text-sm">
                <span className="font-mono font-medium text-fg">{e.key}</span>
                <span className="text-muted">{e.bytes.toLocaleString()} bytes</span>
              </dt>
              <dd>{e.value !== undefined ? <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-term-bg px-3 py-2 font-mono text-xs whitespace-pre-wrap text-term-text">{e.value}</pre> : kind === 'secrets' ? <span className="text-sm text-muted">••••••••</span> : <span className="text-sm text-muted">Binary data</span>}</dd>
            </div>
          ))}
        </dl>
      )}
    </Modal>
  )
}
