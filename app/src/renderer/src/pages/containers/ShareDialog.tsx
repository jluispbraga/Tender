import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Globe, TriangleAlert, X } from 'lucide-react'
import { api, type ContainerRow, type Tunnel } from '@/api'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'

export const tunnelKey = ['tunnels'] as const

/** Every tunnel Tender has open. Polls while one is still getting its address. */
export function useTunnels() {
  return useQuery({
    queryKey: tunnelKey,
    queryFn: api.tunnels.list,
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.some((t) => t.state === 'starting') ? 1500 : 30_000),
  })
}

export function TunnelRow({ t, onClosed }: { t: Tunnel; onClosed?: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [closing, setClosing] = useState(false)
  const close = async () => {
    setClosing(true)
    try {
      await api.tunnels.close(t.id)
      toast({ kind: 'success', title: `Closed the link to ${t.containerName}:${t.port}` })
      onClosed?.()
    } finally {
      setClosing(false)
      void qc.invalidateQueries({ queryKey: tunnelKey })
    }
  }
  return (
    <li className="flex items-center gap-2 rounded-md border border-line px-3 py-2">
      <Globe aria-hidden className="size-4 shrink-0 text-success" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-mono text-xs break-all text-fg select-all">{t.url ?? (t.state === 'stopped' ? 'stopped' : 'getting an address…')}</span>
        <span className="text-xs text-muted">
          port {t.port} of {t.containerName}
        </span>
      </span>
      {t.url && (
        <>
          <CopyButton label={`Copy ${t.url}`} value={t.url} />
          <Button size="sm" variant="ghost" iconOnly aria-label="Open in the browser" icon={<ExternalLink />} onClick={() => void api.tunnels.visit(t.url!)} />
        </>
      )}
      <Button size="sm" icon={<X />} loading={closing} onClick={() => void close()}>
        Close link
      </Button>
    </li>
  )
}

/** A temporary public https link to one port of this container, through Cloudflare. */
export function ShareDialog({ c, open, onClose }: { c: ContainerRow; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const tunnels = useTunnels()
  const ports = useMemo(() => [...new Set(c.ports.filter((p) => p.protocol === 'tcp').map((p) => p.privatePort))].sort((a, b) => a - b), [c.ports])
  const [port, setPort] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mine = (tunnels.data ?? []).filter((t) => t.containerId === c.id)

  useEffect(() => {
    if (open) {
      setPort(ports[0] ? String(ports[0]) : '')
      setError(null)
    }
  }, [open, ports])

  const submit = async () => {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) return setError('Enter the port the app listens on inside the container, like 3000.')
    setBusy(true)
    setError(null)
    try {
      await api.tunnels.open(c.id, n)
      void qc.invalidateQueries({ queryKey: tunnelKey })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Share ${c.name}`}
      description="A temporary https link to one port, through a Cloudflare Quick Tunnel. No account needed."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Done
          </Button>
          <Button variant="primary" icon={<Globe />} loading={busy} disabled={c.state !== 'running'} onClick={() => void submit()}>
            {busy ? 'Asking Cloudflare for a link…' : 'Create link'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex gap-2 rounded-md border border-line bg-warning-bg px-3 py-2 text-sm text-fg">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            Anyone with the link can reach this port from the internet, with no password, until you close it or quit Tender. Share it only for testing, a demo or a webhook, and not with real data
            behind it. Traffic goes through Cloudflare under its terms for Quick Tunnels.
          </span>
        </p>
        {c.state !== 'running' && <p className="text-sm text-danger">{c.name} isn’t running. Start it to share it.</p>}
        {ports.length ? (
          <Select label="Port in the container" value={port} onValueChange={(v) => (setPort(v), setError(null))} options={ports.map((p) => ({ value: String(p), label: String(p) }))} className="w-40" />
        ) : (
          <Input label="Port in the container" placeholder="3000" inputMode="numeric" value={port} onChange={(e) => (setPort(e.target.value), setError(null))} hint="The port the app listens on. It doesn’t need to be published." className="w-40" />
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {mine.length > 0 && (
          <ul aria-label={`Links to ${c.name}`} className="flex flex-col gap-2">
            {mine.map((t) => (
              <TunnelRow key={t.id} t={t} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
