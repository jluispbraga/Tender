import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plug } from 'lucide-react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { keys, useSettings } from '@/lib/queries'
import { cn } from '@/lib/cn'

const ADDRESS = /^(npipe|unix|tcp|ssh):\/\/.+/

/** Which engine Tender uses: automatic, a WSL distribution, a Docker context or an address. */
export function EnginePicker() {
  const qc = useQueryClient()
  const toast = useToast()
  const settings = useSettings()
  const options = useQuery({ queryKey: ['engine', 'options'], queryFn: api.engine.options, staleTime: 0 })
  const current = settings.data?.engine_choice ?? 'auto'
  const [custom, setCustom] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (ADDRESS.test(current)) setCustom(current)
  }, [current])

  const use = async (choice: string) => {
    setBusy(choice)
    setError(null)
    try {
      const s = await api.engine.use(choice)
      qc.setQueryData(keys.engine, s)
      void qc.invalidateQueries({ queryKey: keys.settings })
      void qc.invalidateQueries({ queryKey: ['engine', 'options'] })
      // Everything shown came from the old engine.
      void qc.invalidateQueries({ predicate: (q) => !['engine', 'settings'].includes(String(q.queryKey[0])) })
      toast({ kind: s.state === 'running' ? 'success' : 'error', title: s.state === 'running' ? `Connected to ${s.endpoint}` : `Couldn’t reach ${s.endpoint}`, body: s.state === 'running' ? `Docker ${s.version}` : s.error })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Engines" className="flex flex-col gap-1.5">
        {(options.data ?? []).map((o) => {
          const on = o.choice === current
          return (
            <li key={o.choice}>
              <button
                type="button"
                aria-pressed={on}
                disabled={!!busy}
                onClick={() => !on && void use(o.choice)}
                className={cn('flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left', on ? 'border-accent bg-selected' : 'border-line hover:bg-hover', busy && 'opacity-70')}
              >
                <span aria-hidden className={cn('size-2.5 shrink-0 rounded-pill border', on ? 'border-accent bg-accent' : 'border-line-strong')} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-base font-medium text-fg">{o.label}</span>
                  <span className="truncate font-mono text-xs text-muted" title={o.detail}>
                    {o.detail}
                  </span>
                </span>
                {busy === o.choice && <span className="text-xs text-muted">Connecting…</span>}
              </button>
            </li>
          )
        })}
        {options.isPending && <li className="text-sm text-muted">Looking for engines…</li>}
      </ul>
      <form
        aria-label="Another engine"
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!ADDRESS.test(custom.trim())) return setError('Use an address like tcp://host:2375, ssh://user@host, unix:///path or npipe:////./pipe/name.')
          void use(custom.trim())
        }}
      >
        <div className="flex-1">
          <Input label="Another engine" placeholder="ssh://me@build-box or tcp://192.168.1.20:2375" value={custom} onChange={(e) => (setCustom(e.target.value), setError(null))} error={error ?? undefined} autoComplete="off" spellCheck={false} />
        </div>
        <Button type="submit" icon={<Plug />} loading={!!busy && busy === custom.trim()}>
          Connect
        </Button>
      </form>
      <p className="text-sm text-muted">An engine over plain tcp:// has no password: anyone who can reach that port controls the machine. Prefer ssh://, which uses your SSH keys.</p>
    </div>
  )
}
