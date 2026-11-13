import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Square } from 'lucide-react'
import { api, type KubeForward } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'

export const useForwards = () => useQuery({ queryKey: ['kube', 'forwards'], queryFn: () => api.kube.forwards(), refetchInterval: 5000 })

/** The ports forwarded right now, each with Open and Stop. Shown above the lists. */
export function ForwardsBar({ labelOf }: { labelOf: (context: string) => string }) {
  const forwards = useForwards()
  const qc = useQueryClient()
  const toast = useToast()
  if (!forwards.data?.length) return null
  return (
    <ul aria-label="Port forwards" className="flex shrink-0 flex-wrap gap-2 border-b border-line px-5 py-2">
      {forwards.data.map((f) => (
        <li key={f.id} className="flex items-center gap-1 rounded-md border border-line bg-surface py-0.5 pr-1 pl-2.5 text-sm">
          <span className="font-mono text-xs text-fg">localhost:{f.localPort}</span>
          <span className="text-muted">
            → {f.kind === 'service' ? 'service ' : ''}
            {f.name}:{f.port}
            {` (${labelOf(f.context)} / ${f.namespace})`}
          </span>
          <Button size="sm" variant="ghost" iconOnly icon={<ExternalLink />} aria-label={`Open localhost:${f.localPort} in the browser`} onClick={() => void api.kube.openForward(f.id).catch((e: Error) => toast({ kind: 'error', title: e.message }))} />
          <Button size="sm" variant="ghost" iconOnly icon={<Square />} aria-label={`Stop forwarding localhost:${f.localPort}`} onClick={() => void api.kube.stopForward(f.id).then(() => qc.invalidateQueries({ queryKey: ['kube', 'forwards'] }))} />
        </li>
      ))}
    </ul>
  )
}

export interface ForwardTarget {
  kind: 'pod' | 'service'
  namespace: string
  name: string
  ports: number[]
}

/** Pick the pod or service port and the port on this computer. */
export function ForwardDialog({ context, clusterName, target, onClose }: { context: string; clusterName: string; target: ForwardTarget; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [port, setPort] = useState(String(target.ports[0] ?? ''))
  // Same number locally when it is free to use without admin rights; otherwise 8000 + port.
  const suggest = (p: number) => (p >= 1024 ? p : 8000 + p)
  const [local, setLocal] = useState(target.ports[0] ? String(suggest(target.ports[0])) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remote = Number(port)
  const localNum = Number(local)
  const remoteError = !Number.isInteger(remote) || remote < 1 || remote > 65535 ? 'A port from 1 to 65535.' : undefined
  const localError = local !== '' && (!Number.isInteger(localNum) || localNum < 0 || localNum > 65535) ? 'A port from 1 to 65535, or empty for any free port.' : undefined

  const start = async () => {
    if (remoteError || localError) return
    setBusy(true)
    setError(null)
    try {
      const f: KubeForward = await api.kube.startForward(context, { kind: target.kind, namespace: target.namespace, name: target.name, port: remote }, local === '' ? 0 : localNum)
      void qc.invalidateQueries({ queryKey: ['kube', 'forwards'] })
      toast({ kind: 'success', title: `localhost:${f.localPort} now reaches ${target.name}:${f.port}` })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Forward a port to ${target.name}`}
      description={`Opens a port on this computer (127.0.0.1 only) that reaches the ${target.kind} in ${clusterName} / ${target.namespace}, like kubectl port-forward. It starts again each time Tender opens, until you stop it.`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!!remoteError || !!localError} onClick={() => void start()}>
            Start forwarding
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void start())}>
        {target.ports.length > 1 ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-fg">{target.kind === 'service' ? 'Service port' : 'Pod port'}</span>
            <Select
              label={target.kind === 'service' ? 'Service port' : 'Pod port'}
              value={port}
              onValueChange={(v) => (setPort(v), setLocal(String(suggest(Number(v)))))}
              options={target.ports.map((p) => ({ value: String(p), label: String(p) }))}
            />
          </div>
        ) : (
          <Input label={target.kind === 'service' ? 'Service port' : 'Pod port'} type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} error={port ? remoteError : undefined} hint={target.ports.length ? undefined : 'This pod declares no ports; type the one its app listens on.'} />
        )}
        <Input label="Port on this computer" type="number" min={0} max={65535} value={local} onChange={(e) => setLocal(e.target.value)} error={localError} hint="Leave empty to use any free port." />
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      </form>
    </Modal>
  )
}
