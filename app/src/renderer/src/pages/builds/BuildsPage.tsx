import { useState } from 'react'
import { ArrowLeft, Check, CircleSlash, Hammer, Loader2, Play, RotateCcw, XCircle } from 'lucide-react'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LogViewer } from '@/components/ui/log-viewer'
import { type BuildRun, cancelBuild, startBuild, useBuilds } from '@/lib/builds'
import { ago, fullDate } from '@/lib/format'
import { cn } from '@/lib/cn'
import { href, navigate } from '@/lib/router'
import type { BuildStep } from '@/api'
import { BuildDialog } from './BuildDialog'

const label = (r: BuildRun) => r.spec.tag ?? `${r.spec.context.split(/[\\/]/).filter(Boolean).pop()} (${r.spec.dockerfile})`
const took = (r: BuildRun) => {
  const s = ((r.endedAt ? Date.parse(r.endedAt) : Date.now()) - Date.parse(r.startedAt)) / 1000
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

function StateChip({ state }: { state: BuildRun['state'] }) {
  const map = {
    running: ['Building', 'bg-selected text-link', <Loader2 key="i" aria-hidden className="size-3 animate-spin" />],
    done: ['Built', 'bg-success-bg text-success', <Check key="i" aria-hidden className="size-3" />],
    failed: ['Failed', 'bg-danger-bg text-danger', <XCircle key="i" aria-hidden className="size-3" />],
    cancelled: ['Cancelled', 'bg-neutral-bg text-muted', <CircleSlash key="i" aria-hidden className="size-3" />],
  } as const
  const [text, tone, icon] = map[state]
  return <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-pill px-2 text-xs font-medium', tone)}>{icon}{text}</span>
}

/** Builds started in this window, and one build's steps and log. */
export function BuildsPage({ id }: { id?: string }) {
  const runs = useBuilds()
  const [dialog, setDialog] = useState(false)
  const run = id ? runs.find((r) => r.id === id) : undefined

  if (id && !run)
    return <EmptyState page icon={<Hammer />} title="This build isn’t here any more" body="Builds are kept while Tender stays open." action={<Button onClick={() => navigate('builds')}>Back to builds</Button>} />

  if (run) return <BuildDetail run={run} />

  return (
    <>
      <PageHeader title="Builds">
        <Button variant="primary" icon={<Hammer />} onClick={() => setDialog(true)}>
          Build
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {runs.length ? (
          <ul aria-label="Builds" className="flex flex-col">
            {runs.map((r) => (
              <li key={r.id} className="border-b border-line">
                <a href={href('builds', r.id)} className="flex items-center gap-3 px-5 py-2.5 hover:bg-hover">
                  <StateChip state={r.state} />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{label(r)}</span>
                  <span className="hidden truncate font-mono text-xs text-muted md:block" title={r.spec.context}>
                    {r.spec.context}
                  </span>
                  <span className="w-28 shrink-0 text-right text-sm text-muted" title={fullDate(r.startedAt)}>
                    {ago(r.startedAt)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Hammer />}
            title="No builds yet"
            body="Build an image from a folder with a Dockerfile. The build runs on your engine, and its log stays here while Tender is open."
            action={
              <Button variant="primary" icon={<Hammer />} onClick={() => setDialog(true)}>
                Build an image
              </Button>
            }
          />
        )}
      </div>
      <BuildDialog open={dialog} onClose={() => setDialog(false)} />
    </>
  )
}

function StepIcon({ s }: { s: BuildStep }) {
  if (s.status === 'running') return <Loader2 aria-label="Running" className="size-3.5 shrink-0 animate-spin text-link" />
  if (s.status === 'error') return <XCircle aria-label="Failed" className="size-3.5 shrink-0 text-danger" />
  return <Check aria-label={s.status === 'cached' ? 'Cached' : 'Done'} className={cn('size-3.5 shrink-0', s.status === 'cached' ? 'text-muted' : 'text-success')} />
}

function BuildDetail({ run }: { run: BuildRun }) {
  const steps = run.steps.filter((s) => !/^\[internal\]/.test(s.name))
  return (
    <>
      <PageHeader
        back={
          <a href={href('builds')} aria-label="Back to builds" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" />
          </a>
        }
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">{label(run)}</span>
            <StateChip state={run.state} />
          </span>
        }
      >
        <span className="text-sm text-muted tabular-nums">{took(run)}</span>
        {run.state === 'running' ? (
          <Button variant="danger" onClick={() => void cancelBuild(run.id)}>
            Cancel build
          </Button>
        ) : (
          <Button icon={<RotateCcw />} onClick={() => navigate('builds', startBuild(run.spec))}>
            Build again
          </Button>
        )}
        {run.state === 'done' && run.imageId && (
          <Button variant="primary" icon={<Play />} onClick={() => navigate('images', run.imageId!)}>
            Open image
          </Button>
        )}
      </PageHeader>
      {run.error && (
        <p role="alert" className="shrink-0 border-b border-line bg-danger-bg px-5 py-2 text-sm text-danger">
          {run.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <ol aria-label="Build steps" className="w-80 shrink-0 overflow-auto border-r border-line py-2">
          {steps.length ? (
            steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2 px-4 py-1.5 text-sm">
                <span className="mt-0.5">
                  <StepIcon s={s} />
                </span>
                <span className={cn('min-w-0 flex-1 break-words font-mono text-xs', s.status === 'cached' ? 'text-muted' : 'text-fg')}>{s.name}</span>
                <span className="shrink-0 text-xs text-muted tabular-nums">{s.status === 'cached' ? 'cached' : s.seconds !== undefined ? `${s.seconds}s` : ''}</span>
              </li>
            ))
          ) : (
            <li className="px-4 py-1.5 text-sm text-muted">{run.state === 'running' ? 'Starting…' : 'No steps ran.'}</li>
          )}
        </ol>
        <div className="flex min-w-0 flex-1 flex-col">
          <LogViewer label={`Build log for ${label(run)}`} lines={run.lines} fileName={`build-${(run.spec.tag ?? 'image').replace(/[^a-z0-9._-]/gi, '-')}`} />
        </div>
      </div>
    </>
  )
}
