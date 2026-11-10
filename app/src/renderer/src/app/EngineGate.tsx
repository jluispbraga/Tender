import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, PlugZap, RotateCw, Unplug, Wrench } from 'lucide-react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { keys, useEngine } from '@/lib/queries'
import { href } from '@/lib/router'

/**
 * S01. Wraps every engine-backed page. While the engine is reachable it
 * renders the page; otherwise it explains what was tried and offers a retry.
 */
export function EngineGate({ children }: { children: ReactNode }) {
  const engine = useEngine()
  const qc = useQueryClient()
  const [retrying, setRetrying] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)

  if (engine.isPending) {
    return (
      <div role="status" className="grid flex-1 place-items-center text-base text-muted">
        <span className="inline-flex items-center gap-2">
          <Loader2 aria-hidden className="size-4 animate-spin" /> Looking for the Docker engine…
        </span>
      </div>
    )
  }

  const s = engine.data
  if (s?.state === 'running') return <>{children}</>

  const starting = s?.state === 'starting' || retrying
  const retry = async () => {
    setRetrying(true)
    try {
      const next = await api.engine.reconnect()
      qc.setQueryData(keys.engine, next)
    } catch {
      await qc.invalidateQueries({ queryKey: keys.engine })
    } finally {
      setRetrying(false)
    }
  }

  // Windows: Docker inside WSL runs but lost its socket (Docker Desktop removed it).
  const repair = !starting ? s?.repair : undefined
  const doRepair = async () => {
    setRepairing(true)
    setRepairError(null)
    try {
      qc.setQueryData(keys.engine, await api.engine.repairWsl(repair!))
    } catch (e) {
      setRepairError((e as Error).message)
    } finally {
      setRepairing(false)
    }
  }

  return (
    <div className="grid flex-1 place-items-center p-8">
      <section aria-labelledby="engine-title" className="flex max-w-md flex-col items-center gap-4 text-center">
        <div aria-hidden className="grid size-14 place-items-center rounded-lg bg-surface text-muted [&>svg]:size-7">
          {starting ? <Loader2 className="animate-spin" /> : s?.state === 'stopped' ? <PlugZap /> : <Unplug />}
        </div>
        <h1 id="engine-title" className="text-xl text-fg">
          {repair ? `Docker in ${repair} lost its socket` : starting ? 'Connecting to the engine…' : s?.state === 'stopped' ? 'The Docker engine is stopped' : 'Tender can’t reach the Docker engine'}
        </h1>
        <p role="status" className="text-base text-muted">
          {repair
            ? `Its engine is running, but Docker Desktop removed /var/run/docker.sock when it quit, so nothing can reach it. Repairing restarts Docker in ${repair}: containers running there stop, and those with a restart policy come back.`
            : starting
            ? 'This usually takes a few seconds after the engine starts.'
            : s?.state === 'stopped'
              ? `Start your Docker engine wherever you run it (${api.platform === 'win32' ? 'WSL 2, a VM' : api.platform === 'linux' ? 'systemd, rootless' : 'a VM'}, another machine), then retry. Tender does not start it for you.`
              : `Tried ${s?.endpoint ?? 'the default endpoint'}. Make sure an engine is running and that your user may use it.`}
        </p>
        {s?.error && !starting && <p className="rounded-md bg-danger-bg px-3 py-2 font-mono text-sm text-danger">{s.error}</p>}
        {repairError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{repairError}</p>}
        <div className="flex gap-2">
          {repair && (
            <Button variant="primary" icon={<Wrench />} loading={repairing} onClick={() => void doRepair()}>
              Repair Docker in {repair}
            </Button>
          )}
          <Button variant={repair ? 'secondary' : 'primary'} icon={<RotateCw />} loading={starting} onClick={retry}>
            {starting ? 'Connecting' : 'Retry'}
          </Button>
          <a href={href('troubleshoot')} className="inline-flex h-8 items-center rounded-md border border-line bg-raised px-3 text-base font-medium text-fg hover:bg-hover">
            Troubleshoot
          </a>
        </div>
        {api.platform === 'win32' && !starting && (
          <p className="text-sm text-muted">
            No Docker in WSL yet?{' '}
            <a href={href('setup')} className="text-link underline underline-offset-2">
              Set it up
            </a>
            . Were your containers in Docker Desktop?{' '}
            <a href={href('migrate')} className="text-link underline underline-offset-2">
              Move them to WSL
            </a>
          </p>
        )}
      </section>
    </div>
  )
}
