import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, RotateCw } from 'lucide-react'
import { api } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { EnginePill } from '@/components/ui/shell'
import { useToast } from '@/components/ui/toast'
import { keys, useEngine } from '@/lib/queries'
import { href } from '@/lib/router'
import { Doctor } from './Doctor'

/** S23: check the connection, reconnect, and copy what support would ask for. */
export function TroubleshootPage() {
  const engine = useEngine()
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const e = engine.data

  const reconnect = async () => {
    setBusy(true)
    try {
      qc.setQueryData(keys.engine, await api.engine.reconnect())
      toast({ kind: 'success', title: 'Reconnected to the engine' })
    } catch (err) {
      toast({ kind: 'error', title: 'Still can’t reach the engine', body: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const summary = [
    `Tender (data layer: ${api.kind})`,
    `Engine endpoint: ${e?.endpoint ?? 'unknown'}`,
    `Engine state: ${e?.state ?? 'unknown'}${e?.error ? ` (${e.error})` : ''}`,
    `Engine version: ${e?.version ?? 'unknown'} / API ${e?.apiVersion ?? 'unknown'}`,
    `Platform: ${api.platform}`,
    `OS: ${navigator.userAgent}`,
  ].join('\n')

  return (
    <>
      <PageHeader title="Troubleshoot" />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="flex max-w-2xl flex-col gap-6">
          {api.kind === 'ipc' || api.platform === 'win32' ? <Doctor /> : null}
          <Card title="Engine connection" action={<Button icon={<RotateCw />} loading={busy} onClick={() => void reconnect()}>Reconnect</Button>}>
            <EnginePill state={e?.state ?? 'starting'} detail={e?.endpoint} />
            {e?.error && <p className="rounded-md bg-danger-bg px-3 py-2 font-mono text-sm text-danger">{e.error}</p>}
            <p className="text-sm text-muted">Reconnecting drops the current connection and looks for the engine again. Containers keep running.</p>
          </Card>
          <Card
            title="Details for a bug report"
            action={
              <Button
                icon={<Copy />}
                onClick={async () => {
                  await navigator.clipboard.writeText(summary)
                  toast({ kind: 'success', title: 'Copied the details' })
                }}
              >
                Copy
              </Button>
            }
          >
            <pre className="rounded-md bg-surface p-3 font-mono text-xs whitespace-pre-wrap text-fg">{summary}</pre>
          </Card>
          <Card title="If the engine won’t start">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {api.platform === 'win32' && (
                <>
                  <li>Check that WSL 2 is installed and the distribution with Docker is running: <code className="font-mono text-xs text-fg">wsl --list --running</code></li>
                  <li>Docker installed straight into WSL needs no setup: Tender finds it in any running distribution, through that distribution’s own <code className="font-mono text-xs text-fg">docker</code> command.</li>
                  <li>
                    Containers made with Docker Desktop stay inside Docker Desktop.{' '}
                    <a href={href('migrate')} className="text-link underline underline-offset-2">
                      Move them to WSL
                    </a>
                  </li>
                </>
              )}
              {api.platform === 'linux' && (
                <>
                  <li>Check that the service is running: <code className="font-mono text-xs text-fg">systemctl status docker</code> (rootless: <code className="font-mono text-xs text-fg">systemctl --user status docker</code>)</li>
                  <li>Check that your user may use it, without sudo: <code className="font-mono text-xs text-fg">groups</code> should list <code className="font-mono text-xs text-fg">docker</code></li>
                </>
              )}
              <li>Check that the engine answers from a terminal: <code className="font-mono text-xs text-fg">docker version</code></li>
              <li>If you use Docker contexts, see which one is active: <code className="font-mono text-xs text-fg">docker context ls</code></li>
            </ul>
          </Card>
          {api.kind === 'fake' && (
            <Card title="Simulate engine states (development only)">
              <p className="text-sm text-muted">The app is running on the built-in fake engine. Use these to check the engine screens.</p>
              <div className="flex gap-2">
                <Button onClick={() => (window as unknown as { __tenderFake: { setEngine: (s: string, e?: string) => void } }).__tenderFake.setEngine('error', 'open //./pipe/docker_engine: The system cannot find the file specified.')}>Unreachable</Button>
                <Button onClick={() => (window as unknown as { __tenderFake: { setEngine: (s: string) => void } }).__tenderFake.setEngine('stopped')}>Stopped</Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-md text-fg">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}
