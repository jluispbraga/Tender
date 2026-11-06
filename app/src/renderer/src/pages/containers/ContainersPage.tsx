import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { Box, Boxes, ExternalLink, Layers, Pause, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { api, type ContainerRow } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { BulkBar, ColumnPicker, DataGrid, type GridGroup } from '@/components/ui/data-grid'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { SearchField } from '@/components/ui/input'
import { ActionsMenu } from '@/components/ui/menu'
import { Switch } from '@/components/ui/switch'
import { ago, browsable, bytes, fullDate, portLabel } from '@/lib/format'
import { keys, setSetting, useContainers, useSettings, useStats } from '@/lib/queries'
import { navigate, routeQuery } from '@/lib/router'
import { useWidth } from '@/lib/use-width'
import { useContainerActions } from './actions'
import { ContainerStatus } from './status'

const optionalColumns = [
  { id: 'image', label: 'Image' },
  { id: 'ports', label: 'Ports' },
  { id: 'cpu', label: 'CPU' },
  { id: 'memory', label: 'Memory' },
  { id: 'started', label: 'Last started' },
  { id: 'created', label: 'Created' },
]

/** S03: every container, grouped by Compose project. */
export function ContainersPage() {
  const containers = useContainers()
  const settings = useSettings()
  const prefs = useQuery({ queryKey: keys.grid('containers'), queryFn: () => api.grid.get('containers') })
  const actions = useContainerActions()
  const [q, setQ] = useState(() => routeQuery().get('q') ?? '')
  const [sel, setSel] = useState<RowSelectionState>({})
  const onlyRunning = settings.data?.only_running ?? false

  const [listRef, listWidth] = useWidth<HTMLDivElement>()
  // The user's column choices, plus two columns dropped while the list is narrow
  // (minimum window) so Name and Image stay readable.
  const chosen: VisibilityState = useMemo(() => Object.fromEntries(optionalColumns.map((c) => [c.id, !(prefs.data?.hidden ?? []).includes(c.id)])), [prefs.data])
  const visibility: VisibilityState = useMemo(() => (listWidth < 900 ? { ...chosen, memory: false, started: false } : chosen), [chosen, listWidth])
  const setVisibility = (v: VisibilityState) => {
    // Only persist what the user changed, not the columns hidden for width.
    const hidden = Object.entries({ ...chosen, ...Object.fromEntries(Object.entries(v).filter(([k, on]) => on !== visibility[k])) }).filter(([, on]) => !on).map(([k]) => k)
    void api.grid.set('containers', { hidden }).then(() => prefs.refetch())
  }

  const running = useMemo(() => (containers.data ?? []).filter((c) => c.state === 'running').map((c) => c.id), [containers.data])
  const liveCols = visibility.cpu !== false || visibility.memory !== false
  const stats = useStats(liveCols ? running : [], 1)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (containers.data ?? []).filter(
      (c) => (!onlyRunning || c.state === 'running' || c.state === 'restarting') && (!needle || c.name.toLowerCase().includes(needle) || c.image.toLowerCase().includes(needle) || (c.project ?? '').toLowerCase().includes(needle)),
    )
  }, [containers.data, q, onlyRunning])

  // Drop selections for rows that disappeared (deleted, filtered out).
  useEffect(() => {
    const ids = new Set(shown.map((c) => c.id))
    setSel((s) => Object.fromEntries(Object.entries(s).filter(([id]) => ids.has(id))))
  }, [shown])

  const data = useMemo(() => {
    const projects = new Map<string, ContainerRow[]>()
    for (const c of shown) if (c.project) projects.set(c.project, [...(projects.get(c.project) ?? []), c])
    const groups: GridGroup<ContainerRow>[] = [...projects].map(([name, rows]) => ({
      id: name,
      rows,
      label: (
        <span className="inline-flex items-center gap-2">
          <Boxes aria-hidden className="size-4 text-muted" />
          {name}
          <span className="font-normal text-muted">
            · {rows.filter((r) => r.state === 'running').length} of {rows.length} running
          </span>
        </span>
      ),
    }))
    return { groups, ungrouped: shown.filter((c) => !c.project) }
  }, [shown])

  const columns: ColumnDef<ContainerRow, any>[] = useMemo(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-medium" title={row.original.name}>
              {row.original.service ?? row.original.name}
            </span>
            <CopyButton label={`Copy ID of ${row.original.name}`} value={row.original.id} className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
          </span>
        ),
      },
      { id: 'image', accessorKey: 'image', header: 'Image', cell: ({ getValue }) => <span className="font-mono text-xs text-muted" title={getValue()}>{getValue()}</span> },
      { id: 'status', accessorKey: 'state', header: 'Status', size: 150, cell: ({ row }) => <ContainerStatus c={row.original} /> },
      {
        id: 'ports',
        header: 'Ports',
        size: 130,
        enableSorting: false,
        cell: ({ row }) => {
          const ports = row.original.ports.filter((p) => p.publicPort)
          if (!ports.length) return <span className="text-muted">—</span>
          const first = ports[0]
          return (
            <span className="inline-flex items-center gap-1.5">
              {browsable(first) && row.original.state === 'running' ? (
                <a
                  href={`http://localhost:${first.publicPort}`}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    void api.containers.openPort(first)
                  }}
                  className="inline-flex items-center gap-1 text-link underline-offset-2 hover:underline"
                  aria-label={`${portLabel(first)}, opens ${row.original.name} in your browser`}
                >
                  {portLabel(first)}
                  <ExternalLink aria-hidden className="size-3" />
                </a>
              ) : (
                <span className="text-muted">{portLabel(first)}</span>
              )}
              {ports.length > 1 && <span className="text-xs text-muted" title={ports.slice(1).map(portLabel).join(', ')}>+{ports.length - 1}</span>}
            </span>
          )
        },
      },
      {
        id: 'cpu',
        header: 'CPU',
        size: 72,
        accessorFn: (c) => stats[c.id]?.at(-1)?.cpuPercent ?? -1,
        cell: ({ getValue }) => <span className="text-muted tabular-nums">{getValue() >= 0 ? `${getValue().toFixed(1)}%` : '—'}</span>,
      },
      {
        id: 'memory',
        header: 'Memory',
        size: 88,
        accessorFn: (c) => stats[c.id]?.at(-1)?.memUsage ?? -1,
        cell: ({ getValue }) => <span className="text-muted tabular-nums">{getValue() >= 0 ? bytes(getValue()) : '—'}</span>,
      },
      { id: 'started', accessorKey: 'startedAt', header: 'Last started', size: 110, cell: ({ getValue }) => <span className="text-muted" title={fullDate(getValue())}>{ago(getValue())}</span> },
      { id: 'created', accessorKey: 'createdAt', header: 'Created', size: 110, cell: ({ getValue }) => <span className="text-muted" title={fullDate(getValue())}>{ago(getValue())}</span> },
    ],
    [stats],
  )

  const selected = (containers.data ?? []).filter((c) => sel[c.id])
  const total = containers.data?.length ?? 0
  const filtered = q || onlyRunning

  return (
    <>
      <PageHeader title="Containers">
        <SearchField label="Search containers" placeholder="Search by name, image or project" value={q} onChange={setQ} className="w-64" />
        <Switch label="Only running" checked={onlyRunning} onCheckedChange={(v) => void setSetting('only_running', v)} />
        <ColumnPicker columns={optionalColumns} visibility={chosen} onChange={setVisibility} />
      </PageHeader>

      <BulkBar count={selected.length} noun="container" onClear={() => setSel({})}>
        <Button size="sm" icon={<Play />} onClick={() => void actions.run(selected.map((c) => c.id), 'start')}>
          Start
        </Button>
        <Button size="sm" icon={<Square />} onClick={() => void actions.run(selected.map((c) => c.id), 'stop')}>
          Stop
        </Button>
        <Button size="sm" icon={<Pause />} disabled={!selected.some((c) => c.state === 'running')} onClick={() => void actions.run(selected.filter((c) => c.state === 'running').map((c) => c.id), 'pause')}>
          Pause
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => actions.askDelete(selected)}>
          Delete
        </Button>
      </BulkBar>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {containers.isError ? (
          <ErrorState what="containers" error={containers.error} onRetry={() => void containers.refetch()} />
        ) : (
          <DataGrid
            label="Containers"
            loading={containers.isPending}
            columns={columns}
            data={data}
            getRowId={(c) => c.id}
            getRowLabel={(c) => c.name}
            rowSelection={sel}
            onRowSelectionChange={setSel}
            columnVisibility={visibility}
            onColumnVisibilityChange={setVisibility}
            isRowBusy={(c) => actions.busy.has(c.id)}
            onRowOpen={(c) => navigate('containers', c.id, 'logs')}
            rowActions={(c) => (
              <>
                {c.state === 'running' || c.state === 'restarting' ? (
                  <Button variant="ghost" size="sm" iconOnly aria-label={`Stop ${c.name}`} icon={<Square />} disabled={actions.busy.has(c.id)} onClick={(e) => (e.stopPropagation(), void actions.run([c.id], 'stop'))} />
                ) : c.state === 'paused' ? (
                  <Button variant="ghost" size="sm" iconOnly aria-label={`Resume ${c.name}`} icon={<Play />} disabled={actions.busy.has(c.id)} onClick={(e) => (e.stopPropagation(), void actions.run([c.id], 'unpause'))} />
                ) : (
                  <Button variant="ghost" size="sm" iconOnly aria-label={`Start ${c.name}`} icon={<Play />} disabled={actions.busy.has(c.id)} onClick={(e) => (e.stopPropagation(), void actions.run([c.id], 'start'))} />
                )}
                <ActionsMenu label={`Actions for ${c.name}`} entries={actions.menu(c)} />
              </>
            )}
            groupActions={(g) => (
              <ActionsMenu
                label={`Actions for project ${g.id}`}
                entries={[
                  { label: 'Open project', icon: <Boxes />, onSelect: () => navigate('projects', g.id) },
                  { label: 'Start all', icon: <Play />, onSelect: () => void actions.run(g.rows.map((r) => r.id), 'start') },
                  { label: 'Stop all', icon: <Square />, onSelect: () => void actions.run(g.rows.map((r) => r.id), 'stop') },
                  { label: 'Restart all', icon: <RotateCw />, onSelect: () => void actions.run(g.rows.map((r) => r.id), 'restart') },
                  { kind: 'separator' },
                  { label: 'Delete project containers', icon: <Trash2 />, danger: true, onSelect: () => actions.askDelete(g.rows) },
                ]}
              />
            )}
            empty={
              filtered && total ? (
                <EmptyState
                  icon={<Box />}
                  title="No containers match"
                  body={onlyRunning && !q ? 'None are running right now.' : `Nothing called “${q}”${onlyRunning ? ' is running' : ''}.`}
                  action={
                    <Button
                      onClick={() => {
                        setQ('')
                        void setSetting('only_running', false)
                      }}
                    >
                      Show all containers
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<Box />}
                  title="No containers yet"
                  body="Run an image and its container shows up here, along with anything started from the command line or Compose."
                  action={
                    <Button variant="primary" icon={<Layers />} onClick={() => navigate('images')}>
                      Go to images
                    </Button>
                  }
                />
              )
            }
          />
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {containers.data ? `${shown.length} of ${total} containers shown` : ''}
      </p>
      {actions.confirm}
    </>
  )
}
