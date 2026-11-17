import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Square, Trash2 } from 'lucide-react'
import { api, type LocalCluster, type LocalClusterTool, type LogLine } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { LogViewer } from '@/components/ui/log-viewer'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'

const INSTALL: Record<LocalClusterTool, string> = { kind: 'winget install Kubernetes.kind', k3d: 'winget install k3d.k3d', minikube: 'winget install Kubernetes.minikube' }

/** kind, k3d and minikube clusters on this engine: list, create, delete. */
export function LocalClustersDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['kube', 'local-clusters'], queryFn: api.kube.localClusters, staleTime: 0 })
  const [tool, setTool] = useState<LocalClusterTool | ''>('')
  const [name, setName] = useState('dev')
  const [error, setError] = useState<string | null>(null)
  const [lines, setLines] = useState<LogLine[]>([])
  const [running, setRunning] = useState<{ id: string; what: string } | null>(null)
  const [deleting, setDeleting] = useState<LocalCluster | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => void (alive.current = false)
  }, [])
  useEffect(() => {
    if (!tool && q.data?.tools[0]) setTool(q.data.tools[0])
  }, [q.data, tool])

  const run = (t: LocalClusterTool, action: 'create' | 'remove', n: string) => {
    setError(null)
    const ts = () => new Date().toISOString()
    setLines([{ ts: ts(), stream: 'stdout', text: `$ ${t} ${action === 'create' ? 'create' : 'delete'} ${n}` }])
    const h = api.kube.localCluster(t, action, n, (ls) => alive.current && setLines((x) => [...x, ...ls.map((text) => ({ ts: ts(), stream: 'stdout' as const, text }))].slice(-3000)))
    setRunning({ id: h.runId, what: action === 'create' ? `Creating ${n}…` : `Deleting ${n}…` })
    h.done
      .then(() => {
        toast({ kind: 'success', title: action === 'create' ? `Created ${n}` : `Deleted ${n}`, body: action === 'create' ? `Its context is in your kubeconfig. Pick it above to use it.` : undefined })
        void qc.invalidateQueries({ queryKey: ['kube'] })
      })
      .catch((e: Error & { status?: number }) => e.status !== 499 && alive.current && setError(e.message))
      .finally(() => alive.current && (setRunning(null), setDeleting(null)))
  }

  const create = () => {
    if (!tool) return
    if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) return setError('Use lower-case letters, digits and dashes, up to 32 characters.')
    if (q.data?.clusters.some((c) => c.tool === tool && c.name === name)) return setError(`A ${tool} cluster called ${name} already exists.`)
    run(tool, 'create', name)
  }

  const tools = q.data?.tools ?? []
  return (
    <Modal open onOpenChange={(o) => !o && !running && onClose()} title="Local clusters" description="Kubernetes clusters that run as containers on your engine, made with kind, k3d or minikube." size="lg">
      <div className="flex flex-col gap-4">
        {q.isError && <p className="text-sm text-danger">{(q.error as Error).message}</p>}
        {q.data && !tools.length && (
          <div className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-sm">
            <span className="text-fg">None of kind, k3d or minikube is installed. Install one, then open this again:</span>
            {Object.values(INSTALL).map((c) => (
              <code key={c} className="font-mono text-xs text-muted">
                {c}
              </code>
            ))}
          </div>
        )}
        {q.data && q.data.clusters.length > 0 && (
          <ul aria-label="Clusters" className="flex flex-col divide-y divide-line rounded-md border border-line">
            {q.data.clusters.map((c) => (
              <li key={`${c.tool}/${c.name}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="w-20 shrink-0 text-xs text-muted">{c.tool}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{c.name}</span>
                {c.running !== undefined && <span className={c.running ? 'text-success' : 'text-muted'}>{c.running ? 'running' : 'stopped'}</span>}
                <span className="truncate font-mono text-xs text-muted">{c.context}</span>
                {deleting === c ? (
                  <span role="group" aria-label={`Confirm deleting ${c.name}`} className="flex items-center gap-2">
                    <Button size="sm" disabled={!!running} onClick={() => setDeleting(null)}>
                      Keep
                    </Button>
                    <Button size="sm" variant="danger" loading={!!running} onClick={() => run(c.tool, 'remove', c.name)}>
                      Delete
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" iconOnly aria-label={`Delete ${c.name}`} icon={<Trash2 />} disabled={!!running} onClick={() => setDeleting(c)} />
                )}
              </li>
            ))}
          </ul>
        )}
        {q.data && tools.length > 0 && q.data.clusters.length === 0 && <p className="text-sm text-muted">No local clusters yet.</p>}
        {tools.length > 0 && (
          <form
            aria-label="New cluster"
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              create()
            }}
          >
            <Select label="Tool" value={tool} onValueChange={(v) => setTool(v as LocalClusterTool)} options={tools.map((t) => ({ value: t, label: t }))} className="w-36" />
            <div className="w-48">
              <Input label="Name" value={name} onChange={(e) => (setName(e.target.value), setError(null))} autoComplete="off" spellCheck={false} />
            </div>
            {running ? (
              <Button variant="danger" icon={<Square />} onClick={() => void api.kube.cancelLocalCluster(running.id)}>
                Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary" icon={<Plus />}>
                Create cluster
              </Button>
            )}
          </form>
        )}
        {running && (
          <p role="status" className="text-sm text-muted">
            {running.what} The first one takes a few minutes: it downloads the node image.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {lines.length > 0 && (
          <div className="flex h-56 flex-col overflow-hidden rounded-md border border-line">
            <LogViewer label="Cluster output" lines={lines} />
          </div>
        )}
      </div>
    </Modal>
  )
}
