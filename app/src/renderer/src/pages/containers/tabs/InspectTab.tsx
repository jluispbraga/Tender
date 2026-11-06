import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { ErrorState } from '@/components/ui/error-state'
import { JsonTree } from '@/components/ui/json-tree'
import { keys } from '@/lib/queries'

/** S05: the engine's full description of the container, as a tree or raw JSON. */
export function InspectTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: keys.container(id), queryFn: () => api.containers.inspect(id), staleTime: 0 })
  const [raw, setRaw] = useState(false)

  if (q.isError) return <ErrorState what="the container details" error={q.error} onRetry={() => void q.refetch()} />
  if (q.isPending) return <p role="status" className="p-5 text-base text-muted">Loading details…</p>

  const text = JSON.stringify(q.data, null, 2)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <div role="group" aria-label="View as" className="inline-flex rounded-md border border-line p-0.5">
          <Button size="sm" variant={raw ? 'ghost' : 'secondary'} aria-pressed={!raw} onClick={() => setRaw(false)} className="h-6">
            Tree
          </Button>
          <Button size="sm" variant={raw ? 'secondary' : 'ghost'} aria-pressed={raw} onClick={() => setRaw(true)} className="h-6">
            Raw JSON
          </Button>
        </div>
        <div className="flex-1" />
        <CopyButton label="Copy JSON" value={text} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {raw ? <pre className="font-mono text-mono whitespace-pre-wrap text-fg">{text}</pre> : <JsonTree value={q.data} label="Container details" />}
      </div>
    </div>
  )
}
