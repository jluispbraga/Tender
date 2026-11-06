import { RotateCw, TriangleAlert } from 'lucide-react'
import { Button } from './button'

/** A query that failed. Says what failed, shows the engine's message, offers a retry. */
export function ErrorState({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div aria-hidden className="grid size-12 place-items-center rounded-lg bg-danger-bg text-danger [&>svg]:size-6">
        <TriangleAlert />
      </div>
      <h3 className="text-md text-fg">Couldn’t load {what}</h3>
      <p className="max-w-md font-mono text-sm text-muted">{(error as Error)?.message ?? String(error)}</p>
      <Button icon={<RotateCw />} onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
