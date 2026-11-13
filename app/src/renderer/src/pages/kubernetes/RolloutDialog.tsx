import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Undo2 } from 'lucide-react'
import { api, type KubeAction } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { ago } from '@/lib/format'
import { cn } from '@/lib/cn'

/** kubectl rollout history, with a way back to any earlier revision (asks first, always). */
export function RolloutDialog({ context, clusterName, prod, namespace, name, onRollback, onClose }: { context: string; clusterName: string; prod: boolean; namespace: string; name: string; onRollback: (a: KubeAction) => Promise<void>; onClose: () => void }) {
  const q = useQuery({ queryKey: ['kube', 'rollouts', context, namespace, name], queryFn: () => api.kube.rollouts(context, namespace, name), retry: false })
  const [asking, setAsking] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Modal open onOpenChange={(o) => !o && !busy && onClose()} title={`Rollout history of ${name}`} description={`${clusterName} / ${namespace}. Newest first; Kubernetes keeps the last 10 by default.`} size="lg">
      {q.isError ? (
        <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(q.error as Error).message}</p>
      ) : !q.data ? (
        <p className="text-sm text-muted">Reading…</p>
      ) : (
        <ol aria-label="Revisions" className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
          {q.data.map((r) => (
            <li key={r.revision} className={cn('rounded-md border px-3 py-2 text-sm', r.current ? 'border-accent' : 'border-line')}>
              <div className="flex items-center gap-3">
                <span className="font-medium text-fg">Revision {r.revision}</span>
                {r.current && <span className="rounded-sm bg-selected px-1.5 text-xs text-fg">running now</span>}
                <span className="text-muted">{r.createdAt && ago(r.createdAt)}</span>
                <div className="flex-1" />
                {!r.current && asking !== r.revision && (
                  <Button size="sm" icon={<Undo2 />} onClick={() => setAsking(r.revision)}>
                    Roll back to this
                  </Button>
                )}
              </div>
              <p className="font-mono text-xs break-all text-muted">{r.images.join(', ')}</p>
              {r.changeCause && <p className="text-xs text-muted">{r.changeCause}</p>}
              {asking === r.revision && (
                <div role="group" aria-label={`Confirm rollback to revision ${r.revision}`} className={cn('mt-2 flex flex-wrap items-center gap-2 rounded-md px-3 py-2', prod ? 'bg-danger-bg text-danger' : 'bg-surface text-fg')}>
                  <span className="flex-1">
                    {prod ? 'Production: ' : ''}new pods with {r.images.join(', ')} replace the running ones, one by one.
                  </span>
                  <Button size="sm" disabled={busy} onClick={() => setAsking(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy}
                    onClick={async () => {
                      setBusy(true)
                      await onRollback({ kind: 'rollback-deployment', namespace, name, revision: r.revision })
                      setBusy(false)
                      onClose()
                    }}
                  >
                    Roll back
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  )
}
