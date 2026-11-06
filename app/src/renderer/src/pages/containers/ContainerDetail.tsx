import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Box, ExternalLink, Pause, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { api, type ContainerRow, type LogLine } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { LogViewer } from '@/components/ui/log-viewer'
import { ActionsMenu } from '@/components/ui/menu'
import { Tabs } from '@/components/ui/tabs'
import { browsable, portLabel, shortId } from '@/lib/format'
import { useContainers, useSettings } from '@/lib/queries'
import { href, navigate } from '@/lib/router'
import { useContainerActions } from './actions'
import { ContainerStatus } from './status'
import { InspectTab } from './tabs/InspectTab'
import { MountsTab } from './tabs/MountsTab'
import { ExecTab } from './tabs/ExecTab'
import { StatsTab } from './tabs/StatsTab'

const MAX_LINES = 5000

/** S04-S09: one container, with its tabs in the URL. */
export function ContainerDetail({ id, tab }: { id: string; tab: string }) {
  const containers = useContainers()
  const actions = useContainerActions()
  const c = containers.data?.find((x) => x.id === id)

  if (containers.isError) return <ErrorState what="this container" error={containers.error} onRetry={() => void containers.refetch()} />
  if (containers.isPending) return <DetailSkeleton />
  if (!c) {
    return (
      <EmptyState
        page
        icon={<Box />}
        title="This container no longer exists"
        body="It was removed, maybe from the command line or by Compose."
        action={<Button onClick={() => navigate('containers')}>Back to containers</Button>}
      />
    )
  }

  const busy = actions.busy.has(c.id)
  const live = c.state === 'running' || c.state === 'restarting'
  const ports = c.ports.filter((p) => p.publicPort)
  const headerLabels = ['Delete', 'Pause', 'Restart', 'Stop', 'Start', 'Resume']

  return (
    <>
      <PageHeader
        back={
          <a
            href={c.project ? href('projects', c.project) : href('containers')}
            aria-label={c.project ? `Back to project ${c.project}` : 'Back to containers'}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
          >
            <ArrowLeft aria-hidden className="size-4" />
          </a>
        }
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate" title={c.name}>
              {c.name}
            </span>
            <ContainerStatus c={c} />
          </span>
        }
      >
        {live ? (
          <Button icon={<Square />} loading={busy} onClick={() => void actions.run([c.id], 'stop')}>
            Stop
          </Button>
        ) : c.state === 'paused' ? (
          <Button icon={<Play />} loading={busy} onClick={() => void actions.run([c.id], 'unpause')}>
            Resume
          </Button>
        ) : (
          <Button variant="primary" icon={<Play />} loading={busy} onClick={() => void actions.run([c.id], 'start')}>
            Start
          </Button>
        )}
        <Button iconOnly aria-label="Pause" icon={<Pause />} disabled={c.state !== 'running' || busy} onClick={() => void actions.run([c.id], 'pause')} />
        <Button iconOnly aria-label="Restart" icon={<RotateCw />} disabled={busy} onClick={() => void actions.run([c.id], 'restart')} />
        <Button iconOnly variant="danger" aria-label="Delete" icon={<Trash2 />} disabled={busy} onClick={() => actions.askDelete([c])} />
        <ActionsMenu label="More actions" entries={actions.menu(c, { inDetail: true }).filter((e) => e.kind !== 'separator' && !headerLabels.includes(e.label))} />
      </PageHeader>

      <dl className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-b border-line px-5 py-2 text-sm">
        <Meta label="Image">
          <span className="font-mono text-xs" title={c.image}>
            {c.image}
          </span>
        </Meta>
        <Meta label="ID">
          <span className="inline-flex items-center gap-0.5 font-mono text-xs">
            {shortId(c.id)}
            <CopyButton label="Copy full container ID" value={c.id} />
          </span>
        </Meta>
        {c.project && (
          <Meta label="Project">
            <a href={href('projects', c.project)} className="text-link underline-offset-2 hover:underline">
              {c.project}
            </a>
          </Meta>
        )}
        <Meta label="Ports">
          {ports.length ? (
            <span className="inline-flex flex-wrap gap-2">
              {ports.map((p) =>
                browsable(p) && c.state === 'running' ? (
                  <button key={portLabel(p)} type="button" onClick={() => void api.containers.openPort(p)} className="inline-flex items-center gap-1 rounded-sm text-link underline-offset-2 hover:underline">
                    {portLabel(p)}
                    <ExternalLink aria-hidden className="size-3" />
                    <span className="sr-only">(opens in your browser)</span>
                  </button>
                ) : (
                  <span key={portLabel(p)} className="text-muted">
                    {portLabel(p)}
                  </span>
                ),
              )}
            </span>
          ) : (
            <span className="text-muted">none published</span>
          )}
        </Meta>
      </dl>

      <Tabs
        label="Container details"
        value={tab}
        onValueChange={(t) => navigate('containers', c.id, t)}
        items={[
          { value: 'logs', label: 'Logs', content: <LogsTab c={c} /> },
          { value: 'inspect', label: 'Inspect', content: <InspectTab id={c.id} /> },
          { value: 'mounts', label: 'Mounts', content: <MountsTab c={c} /> },
          { value: 'exec', label: 'Terminal', content: <ExecTab c={c} /> },
          { value: 'files', label: 'Files', disabled: true, disabledReason: 'Browsing files inside a container is planned for a later milestone', content: null },
          { value: 'stats', label: 'Stats', content: <StatsTab c={c} /> },
        ]}
      />
      {actions.confirm}
    </>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-fg">{children}</dd>
    </div>
  )
}

/** S04. Streams logs from the moment the tab opens; keeps the last 5,000 lines. */
function LogsTab({ c }: { c: ContainerRow }) {
  const settings = useSettings()
  const [lines, setLines] = useState<LogLine[] | null>(null)
  const tail = Math.min(settings.data?.log_tail_lines ?? 1000, MAX_LINES)
  useEffect(() => {
    setLines(null)
    return api.logs.subscribe(c.id, { tail }, (batch) => setLines((prev) => [...(prev ?? []), ...batch].slice(-MAX_LINES)))
  }, [c.id, tail])

  if (lines === null) return <p role="status" className="p-5 text-base text-muted">Loading logs…</p>
  if (!lines.length) {
    return <p className="p-5 text-base text-muted">{c.state === 'running' ? 'Nothing logged yet. New output appears here as it happens.' : 'This container hasn’t written any output.'}</p>
  }
  return <LogViewer label={`Logs for ${c.name}`} lines={lines} />
}

function DetailSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-3 p-5">
      <span className="h-6 w-64 animate-pulse rounded-sm bg-neutral-bg" />
      <span className="h-4 w-96 animate-pulse rounded-sm bg-neutral-bg" />
      <span className="mt-4 h-64 animate-pulse rounded-md bg-neutral-bg" />
      <span className="sr-only">Loading</span>
    </div>
  )
}
