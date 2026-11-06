import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, PlugZap, RotateCw, Unplug } from 'lucide-react'
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

  return (
    <div className="grid flex-1 place-items-center p-8">
      <section aria-labelledby="engine-title" className="flex max-w-md flex-col items-center gap-4 text-center">
        <div aria-hidden className="grid size-14 place-items-center rounded-lg bg-surface text-muted [&>svg]:size-7">
          {starting ? <Loader2 className="animate-spin" /> : s?.state === 'stopped' ? <PlugZap /> : <Unplug />}
        </div>
        <h1 id="engine-title" className="text-xl text-fg">
          {starting ? 'Connecting to the engine…' : s?.state === 'stopped' ? 'The Docker engine is stopped' : 'Harbor can’t reach the Docker engine'}
        </h1>
        <p role="status" className="text-base text-muted">
          {starting
            ? 'This usually takes a few seconds after the engine starts.'
            : s?.state === 'stopped'
              ? 'Start Docker Engine (for example in WSL 2, or Docker Desktop if you have it), then retry.'
              : `Tried ${s?.endpoint ?? 'the default pipe'}. Make sure an engine is running and that this Windows user may use it.`}
        </p>
        {s?.error && !starting && <p className="rounded-md bg-danger-bg px-3 py-2 font-mono text-sm text-danger">{s.error}</p>}
        <div className="flex gap-2">
          <Button variant="primary" icon={<RotateCw />} loading={starting} onClick={retry}>
            {starting ? 'Connecting' : 'Retry'}
          </Button>
          <a href={href('troubleshoot')} className="inline-flex h-8 items-center rounded-md border border-line bg-raised px-3 text-base font-medium text-fg hover:bg-hover">
            Troubleshoot
          </a>
        </div>
      </section>
    </div>
  )
}
