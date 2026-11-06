import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Boxes, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { api, type ContainerRow, type LogLine } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { LogViewer } from '@/components/ui/log-viewer'
import { ActionsMenu } from '@/components/ui/menu'
import { Select } from '@/components/ui/select'
import { browsable, portLabel } from '@/lib/format'
import { useContainers } from '@/lib/queries'
import { href, navigate } from '@/lib/router'
import { useContainerActions } from './actions'
import { ContainerStatus } from './status'

const MAX_LINES = 5000

/** S10: one Compose project: its services and their combined logs. */
export function ProjectDetail({ name }: { name: string }) {
  const containers = useContainers()
  const actions = useContainerActions()
  const rows = useMemo(() => (containers.data ?? []).filter((c) => c.project === name).sort((a, b) => (a.service ?? '').localeCompare(b.service ?? '')), [containers.data, name])
  const [service, setService] = useState('all')

  if (containers.isError) return <ErrorState what="this project" error={containers.error} onRetry={() => void containers.refetch()} />
  if (containers.isPending) return <p role="status" className="p-5 text-base text-muted">Loading project…</p>
  if (!rows.length) {
    return (
      <EmptyState
        page
        icon={<Boxes />}
        title={`No containers left in ${name}`}
        body="The project’s containers were removed. Run docker compose up in its folder to bring it back."
        action={<Button onClick={() => navigate('containers')}>Back to containers</Button>}
      />
    )
  }

  const runningCount = rows.filter((r) => r.state === 'running').length
  const ids = rows.map((r) => r.id)
  const workingDir = rows[0].labels['com.docker.compose.project.working_dir']

  return (
    <>
      <PageHeader
        back={
          <a href={href('containers')} aria-label="Back to containers" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" />
          </a>
        }
        title={
          <span className="flex items-center gap-3">
            <Boxes aria-hidden className="size-5 text-muted" />
            {name}
            <span className="text-sm font-normal text-muted">
              {runningCount} of {rows.length} running
            </span>
          </span>
        }
      >
        <Button icon={<Play />} disabled={runningCount === rows.length} onClick={() => void actions.run(ids, 'start')}>
          Start all
        </Button>
        <Button icon={<Square />} disabled={runningCount === 0} onClick={() => void actions.run(ids, 'stop')}>
          Stop all
        </Button>
        <Button iconOnly aria-label="Restart all" icon={<RotateCw />} onClick={() => void actions.run(ids, 'restart')} />
        <Button iconOnly variant="danger" aria-label="Delete the project’s containers" icon={<Trash2 />} onClick={() => actions.askDelete(rows)} />
      </PageHeader>

      {workingDir && (
        <p className="shrink-0 border-b border-line px-5 py-2 text-sm text-muted">
          Started from <span className="font-mono text-xs text-fg">{workingDir}</span>
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <table aria-label={`Services in ${name}`} className="w-full shrink-0 table-fixed border-collapse text-sm">
          <thead className="bg-surface">
            <tr className="h-8 border-b border-line text-left text-xs text-muted">
              <th className="px-5 font-medium">Service</th>
              <th className="px-3 font-medium">Image</th>
              <th className="w-36 px-3 font-medium">Status</th>
              <th className="w-40 px-3 font-medium">Ports</th>
              <th className="w-24 px-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <ServiceRow key={c.id} c={c} busy={actions.busy.has(c.id)} menu={actions.menu(c)} />
            ))}
          </tbody>
        </table>

        <div className="flex shrink-0 items-center gap-3 border-y border-line bg-surface px-5 py-2">
          <h2 className="text-sm font-medium text-fg">Logs</h2>
          <Select
            label="Show logs from"
            value={service}
            onValueChange={setService}
            className="w-44"
            options={[{ value: 'all', label: 'All services' }, ...rows.map((r) => ({ value: r.id, label: r.service ?? r.name }))]}
          />
        </div>
        <div className="min-h-0 flex-1">
          <CombinedLogs rows={service === 'all' ? rows : rows.filter((r) => r.id === service)} />
        </div>
      </div>
      {actions.confirm}
    </>
  )
}

function ServiceRow({ c, busy, menu }: { c: ContainerRow; busy: boolean; menu: ReturnType<ReturnType<typeof useContainerActions>['menu']> }) {
  const ports = c.ports.filter((p) => p.publicPort)
  return (
    <tr className="h-9 border-b border-line hover:bg-hover">
      <td className="truncate px-5">
        <a href={href('containers', c.id, 'logs')} className="font-medium text-fg underline-offset-2 hover:underline">
          {c.service ?? c.name}
        </a>
      </td>
      <td className="truncate px-3 font-mono text-xs text-muted" title={c.image}>
        {c.image}
      </td>
      <td className="px-3">
        <ContainerStatus c={c} />
      </td>
      <td className="truncate px-3">
        {ports.length ? (
          ports.map((p) =>
            browsable(p) && c.state === 'running' ? (
              <button key={portLabel(p)} type="button" onClick={() => void api.containers.openPort(p)} className="mr-2 rounded-sm text-link underline-offset-2 hover:underline">
                {portLabel(p)}
              </button>
            ) : (
              <span key={portLabel(p)} className="mr-2 text-muted">
                {portLabel(p)}
              </span>
            ),
          )
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 text-right">{busy ? <span role="status" className="text-xs text-muted">Working…</span> : <ActionsMenu label={`Actions for ${c.name}`} entries={menu} />}</td>
    </tr>
  )
}

/** Merges the services' log streams by timestamp, tagging each line with its service. */
function CombinedLogs({ rows }: { rows: ContainerRow[] }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const key = rows.map((r) => r.id).join(',')
  useEffect(() => {
    setLines([])
    const offs = rows.map((r) =>
      api.logs.subscribe(r.id, { tail: 200 }, (batch) =>
        setLines((prev) => {
          const tagged = batch.map((l) => ({ ...l, source: r.service ?? r.name }))
          return [...prev, ...tagged].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-MAX_LINES)
        }),
      ),
    )
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (!lines.length) return <p className="p-5 text-base text-muted">No output from these services yet.</p>
  return <LogViewer label="Combined logs" lines={lines} />
}
