import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Loader2, Undo2 } from 'lucide-react'
import { api, type HelmRelease } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { ActionsMenu } from '@/components/ui/menu'
import { useToast } from '@/components/ui/toast'
import { ago, fullDate } from '@/lib/format'
import { cn } from '@/lib/cn'
import { Table } from './Table'

const tone = (status: string) => (status === 'deployed' ? 'text-success' : /failed/.test(status) ? 'text-danger' : /pending/.test(status) ? 'text-warning' : 'text-muted')

/** Helm releases in the namespace, read from the cluster itself. */
export function HelmTab({ context, namespace, filter, problemsOnly, clusterName, prod }: { context: string; namespace: string; filter: string; problemsOnly: boolean; clusterName: string; prod: boolean }) {
  const q = useQuery({ queryKey: ['kube', 'helm', context, namespace], queryFn: () => api.kube.helmReleases(context, namespace), refetchInterval: 15_000, retry: false })
  const [open, setOpen] = useState<HelmRelease | null>(null)
  if (q.isError) return <p className="m-6 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(q.error as Error).message}</p>
  if (!q.data)
    return (
      <p role="status" className="inline-flex items-center gap-2 p-6 text-sm text-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Reading Helm releases…
      </p>
    )
  const needle = filter.trim().toLowerCase()
  const rows = q.data.filter((r) => (!needle || r.name.toLowerCase().includes(needle)) && (!problemsOnly || r.status !== 'deployed'))
  return (
    <>
      {!q.data.length ? (
        <p className="p-6 text-sm text-muted">No Helm releases here. Charts installed with Helm 3 show up on their own.</p>
      ) : (
        <Table
          label="Helm releases"
          filter={filter}
          problemsOnly={problemsOnly}
          head={['Name', 'Namespace', 'Status', 'Chart', 'App version', 'Revision', 'Updated', '']}
          rows={rows.map((r) => [
            <button type="button" className="font-medium text-fg hover:underline" onClick={() => setOpen(r)}>
              {r.name}
            </button>,
            r.namespace,
            <span className={cn('font-medium', tone(r.status))}>{r.status}</span>,
            <span className="font-mono text-xs">{r.chart}</span>,
            r.appVersion ?? '—',
            r.revision,
            <span title={r.updatedAt && fullDate(r.updatedAt)}>{r.updatedAt ? ago(r.updatedAt) : '—'}</span>,
            <ActionsMenu label={`Actions for ${r.name}`} entries={[{ label: 'History and values…', icon: <History />, onSelect: () => setOpen(r) }]} />,
          ])}
        />
      )}
      {open && <HelmDialog context={context} clusterName={clusterName} prod={prod} release={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function HelmDialog({ context, clusterName, prod, release, onClose }: { context: string; clusterName: string; prod: boolean; release: HelmRelease; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { namespace, name } = release
  const hist = useQuery({ queryKey: ['kube', 'helm-history', context, namespace, name], queryFn: () => api.kube.helmHistory(context, namespace, name), retry: false })
  const [rev, setRev] = useState(release.revision)
  const vals = useQuery({ queryKey: ['kube', 'helm-values', context, namespace, name, rev], queryFn: () => api.kube.helmValues(context, namespace, name, rev), retry: false })
  const [asking, setAsking] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const rollback = async (to: number) => {
    setBusy(true)
    try {
      toast({ kind: 'success', title: await api.kube.helmRollback(context, namespace, name, to) })
      void qc.invalidateQueries({ queryKey: ['kube'] })
      onClose()
    } catch (e) {
      toast({ kind: 'error', title: `Couldn’t roll back ${name}`, body: (e as Error).message })
    } finally {
      setBusy(false)
      setAsking(null)
    }
  }

  return (
    <Modal open onOpenChange={(o) => !o && !busy && onClose()} title={`Helm release ${name}`} description={`${clusterName} / ${namespace}. Values that look like passwords or tokens are hidden.`} size="lg">
      <div className="grid max-h-[65vh] grid-cols-[260px_1fr] gap-4">
        <ol aria-label="Revisions" className="flex flex-col gap-1.5 overflow-auto">
          {hist.isError && <li className="text-sm text-danger">{(hist.error as Error).message}</li>}
          {hist.data?.map((h) => (
            <li key={h.revision}>
              <button
                type="button"
                aria-pressed={rev === h.revision}
                onClick={() => setRev(h.revision)}
                className={cn('flex w-full flex-col rounded-md border px-2.5 py-1.5 text-left text-sm', rev === h.revision ? 'border-accent bg-selected' : 'border-line hover:bg-hover')}
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium text-fg">Revision {h.revision}</span>
                  <span className={cn('text-xs', tone(h.status))}>{h.status}</span>
                </span>
                <span className="truncate font-mono text-xs text-muted">{h.chart}</span>
                <span className="text-xs text-muted">{h.updatedAt ? ago(h.updatedAt) : ''}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="flex min-w-0 flex-col gap-3 overflow-auto">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium text-fg">Values of revision {rev}</h3>
            <div className="flex-1" />
            {rev !== release.revision && asking !== rev && (
              <Button size="sm" icon={<Undo2 />} onClick={() => setAsking(rev)}>
                Roll back to this
              </Button>
            )}
          </div>
          {asking === rev && (
            <div role="group" aria-label={`Confirm rollback to revision ${rev}`} className={cn('flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm', prod ? 'bg-danger-bg text-danger' : 'bg-surface text-fg')}>
              <span className="flex-1">{prod ? 'Production: ' : ''}helm rollback reapplies revision {rev}’s chart and values. It runs with your kubeconfig and needs helm installed.</span>
              <Button size="sm" disabled={busy} onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" loading={busy} onClick={() => void rollback(rev)}>
                Roll back
              </Button>
            </div>
          )}
          {vals.isError ? (
            <p className="text-sm text-danger">{(vals.error as Error).message}</p>
          ) : !vals.data ? (
            <p className="text-sm text-muted">Reading…</p>
          ) : (
            <>
              <pre aria-label="Values" className="overflow-auto rounded-md bg-term-bg p-3 font-mono text-xs text-term-text">
                {Object.keys(vals.data.values ?? {}).length ? JSON.stringify(vals.data.values, null, 2) : '# No values set: the chart’s defaults apply.'}
              </pre>
              {vals.data.notes && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted">Chart notes</summary>
                  <pre className="mt-2 font-mono text-xs whitespace-pre-wrap text-fg">{vals.data.notes}</pre>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
