import { useEffect, useState, type ReactNode } from 'react'
import type { ColumnDef, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import {
  Box,
  Boxes,
  Database,
  ExternalLink,
  HardDrive,
  Layers,
  Moon,
  Network,
  Pause,
  Play,
  RotateCw,
  Square,
  SquareTerminal,
  Sun,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CommandPalette } from '@/components/ui/command-palette'
import { CopyButton } from '@/components/ui/copy-button'
import { BulkBar, ColumnPicker, DataGrid } from '@/components/ui/data-grid'
import { ConfirmDialog, Modal } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input, SearchField } from '@/components/ui/input'
import { KvEditor, type KvRow } from '@/components/ui/kv-editor'
import { LogViewer, type LogLine } from '@/components/ui/log-viewer'
import { ActionsMenu } from '@/components/ui/menu'
import { ProgressList } from '@/components/ui/progress-list'
import { Select } from '@/components/ui/select'
import { EnginePill, ResourceMeter, SidebarNav } from '@/components/ui/shell'
import { StatusChip, Tag, type Status } from '@/components/ui/status-chip'
import { Switch } from '@/components/ui/switch'
import { Tabs } from '@/components/ui/tabs'
import { ToastProvider, useToast } from '@/components/ui/toast'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'

// Sample data for the gallery only. Names are invented.
interface Ctr {
  id: string
  name: string
  image: string
  status: Status
  detail?: string
  port?: string
  cpu: string
  created: string
  project?: string
}

const containers: Ctr[] = [
  { id: 'a1f3', name: 'shop-web-1', image: 'nginx:1.27', status: 'running', port: '8080:80', cpu: '0.4%', created: '2 hours ago', project: 'shop' },
  { id: 'b7c2', name: 'shop-api-1', image: 'node:22-alpine', status: 'restarting', cpu: '—', created: '2 hours ago', project: 'shop' },
  { id: 'c9d8', name: 'shop-db-1', image: 'postgres:17', status: 'running', port: '5432:5432', cpu: '1.2%', created: '2 hours ago', project: 'shop' },
  { id: 'd4e5', name: 'cache', image: 'redis:7', status: 'paused', cpu: '0%', created: '3 days ago' },
  { id: 'e2a7', name: 'migrate-once', image: 'shop/migrate:latest', status: 'exited', detail: '1', cpu: '—', created: '5 days ago' },
]

const logLines: LogLine[] = [
  { ts: '2026-11-06T09:14:02.118Z', stream: 'stdout', text: 'listening on 0.0.0.0:3000' },
  { ts: '2026-11-06T09:14:02.442Z', stream: 'stdout', text: 'connected to database shop on db:5432' },
  { ts: '2026-11-06T09:14:07.901Z', stream: 'stdout', text: 'GET /health 200 2ms' },
  { ts: '2026-11-06T09:14:12.004Z', stream: 'stderr', text: 'warn: slow query (812ms) select * from orders where status = $1' },
  { ts: '2026-11-06T09:14:17.330Z', stream: 'stdout', text: 'GET /api/orders 200 41ms' },
  { ts: '2026-11-06T09:14:19.876Z', stream: 'stderr', text: 'error: connection reset by peer (db:5432), retrying in 2s' },
  { ts: '2026-11-06T09:14:21.910Z', stream: 'stdout', text: 'reconnected to database shop' },
  { ts: '2026-11-06T09:14:22.015Z', stream: 'stdout', text: 'GET /api/orders 200 38ms' },
]

const colDefs: ColumnDef<Ctr, any>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    size: 200,
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1">
        <span className="truncate font-medium">{row.original.name}</span>
        <CopyButton label={`Copy ID of ${row.original.name}`} value={row.original.id} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
      </span>
    ),
  },
  { id: 'image', accessorKey: 'image', header: 'Image', cell: ({ getValue }) => <span className="font-mono text-xs text-muted">{getValue()}</span> },
  { id: 'status', accessorKey: 'status', header: 'Status', size: 150, cell: ({ row }) => <StatusChip status={row.original.status} detail={row.original.detail} /> },
  {
    id: 'port',
    accessorKey: 'port',
    header: 'Ports',
    size: 120,
    enableSorting: false,
    cell: ({ getValue }) =>
      getValue() ? (
        <a href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation() }} className="inline-flex items-center gap-1 text-link underline-offset-2 hover:underline">
          {getValue()}
          <ExternalLink aria-hidden className="size-3" />
        </a>
      ) : (
        <span className="text-muted">—</span>
      ),
  },
  { id: 'cpu', accessorKey: 'cpu', header: 'CPU', size: 80, cell: ({ getValue }) => <span className="text-muted tabular-nums">{getValue()}</span> },
  { id: 'created', accessorKey: 'created', header: 'Created', size: 120, cell: ({ getValue }) => <span className="text-muted">{getValue()}</span> },
]

export function DesignPage() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <Gallery />
      </ToastProvider>
    </TooltipProvider>
  )
}

function Gallery() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const toast = useToast()

  const [nav, setNav] = useState('containers')
  const [q, setQ] = useState('')
  const [onlyRunning, setOnlyRunning] = useState(false)
  const [sel, setSel] = useState<RowSelectionState>({})
  const [vis, setVis] = useState<VisibilityState>({ cpu: true })
  const [filter, setFilter] = useState('all')
  const [tab, setTab] = useState('logs')
  const [runOpen, setRunOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [blockedOpen, setBlockedOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [ports, setPorts] = useState<KvRow[]>([{ key: '8080', value: '80' }, { key: '3000', value: '3000', error: 'Port 3000 is already used by shop-api-1.' }])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shown = containers.filter((c) => (!onlyRunning || c.status === 'running') && c.name.includes(q))
  const grouped = {
    groups: shown.some((c) => c.project)
      ? [{ id: 'shop', label: <span className="inline-flex items-center gap-2"><Boxes aria-hidden className="size-4 text-muted" />shop <span className="font-normal text-muted">· 3 services</span></span>, rows: shown.filter((c) => c.project === 'shop') }]
      : [],
    ungrouped: shown.filter((c) => !c.project),
  }
  const selected = Object.keys(sel).filter((k) => sel[k])

  return (
    <div className="flex min-h-full flex-col bg-bg">
      <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-surface px-6">
        <h1 className="text-md text-fg">Design system</h1>
        <span className="text-sm text-muted">Tender primitives · tokens from replica/design/tokens.json</span>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" icon={theme === 'dark' ? <Sun /> : <Moon />} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'} theme
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-10 px-6 py-8">
        <Section title="Colour roles">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            {['bg', 'surface', 'raised', 'hover', 'selected', 'border', 'border-input', 'text', 'text-muted', 'accent', 'accent-text', 'danger', 'danger-solid', 'success', 'warning', 'term-bg'].map((r) => (
              <div key={r} className="overflow-hidden rounded-md border border-line">
                <div className="h-10" style={{ background: `var(--ds-${r})` }} />
                <div className="px-2 py-1 font-mono text-xs text-muted">{r}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type">
          <div className="flex flex-col gap-1">
            <p className="text-xl text-fg">xl 24/32 · Nothing running yet</p>
            <p className="text-lg text-fg">lg 20/28 · Containers</p>
            <p className="text-md text-fg">md 16/24 · Run a new container</p>
            <p className="text-base text-fg">base 14/20 · Body text, form fields and dialog copy.</p>
            <p className="text-sm text-fg">sm 13/18 · Grid rows, menus, tabs.</p>
            <p className="text-xs text-muted">xs 12/16 · Column headers, chips, footer.</p>
            <p className="font-mono text-mono text-fg">mono 12/18 · sha256:4f2a9c1e0b7d…</p>
          </div>
        </Section>

        <Section title="Buttons">
          <Row>
            <Button variant="primary" icon={<Play />}>Run</Button>
            <Button>Pull image</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger" icon={<Trash2 />}>Delete</Button>
            <Button variant="primary" loading>Starting</Button>
            <Button disabled>Disabled</Button>
            <Tooltip content="Open a terminal"><Button variant="ghost" iconOnly aria-label="Open a terminal" icon={<SquareTerminal />} /></Tooltip>
          </Row>
          <Row>
            <Button size="sm">Small 28</Button>
            <Button size="md">Medium 32</Button>
            <Button size="lg">Large 40</Button>
          </Row>
        </Section>

        <Section title="Fields and toggles">
          <div className="grid max-w-[720px] grid-cols-2 gap-4">
            <Input label="Container name" placeholder="Optional, generated if empty" hint="Letters, digits, dots, dashes and underscores." />
            <Input label="Image reference" defaultValue="ngnix:latest" error="No image called ngnix:latest on Docker Hub. Did you mean nginx?" />
            <Input label="Disabled" disabled defaultValue="read only" />
            <div className="flex flex-col gap-3 pt-6">
              <Switch label="Only running" checked={onlyRunning} onCheckedChange={setOnlyRunning} />
              <Switch label="Disabled toggle" checked={false} onCheckedChange={() => {}} disabled />
            </div>
          </div>
          <Row>
            <SearchField label="Search containers" placeholder="Search" value={q} onChange={setQ} />
            <Select label="Filter images" value={filter} onValueChange={setFilter} className="w-40" options={[{ value: 'all', label: 'All images' }, { value: 'in-use', label: 'In use' }, { value: 'unused', label: 'Unused' }, { value: 'dangling', label: 'Untagged' }]} />
          </Row>
        </Section>

        <Section title="Status">
          <Row>
            {(['running', 'paused', 'restarting', 'created', 'exited', 'error', 'in-use', 'unused', 'dangling'] as Status[]).map((s) => (
              <StatusChip key={s} status={s} detail={s === 'exited' ? '137' : undefined} />
            ))}
            <Tag>arm64</Tag>
          </Row>
          <Row>
            <EnginePill state="running" detail="v28.3" />
            <EnginePill state="starting" />
            <EnginePill state="stopped" />
            <EnginePill state="error" detail="no engine on //./pipe/docker_engine" />
          </Row>
        </Section>

        <Section title="App shell with grid (S02 + S03)">
          <div className="flex h-[460px] overflow-hidden rounded-lg border border-line">
            <aside className="flex flex-col border-r border-line bg-surface">
              <SidebarNav
                current={nav}
                onSelect={setNav}
                items={[
                  { key: 'containers', label: 'Containers', icon: <Box />, count: 5 },
                  { key: 'images', label: 'Images', icon: <Layers />, count: 12 },
                  { key: 'volumes', label: 'Volumes', icon: <Database />, count: 4 },
                  { key: 'networks', label: 'Networks', icon: <Network /> },
                ]}
              />
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
                <h2 className="text-lg text-fg">Containers</h2>
                <div className="flex-1" />
                <SearchField label="Search containers" placeholder="Search" value={q} onChange={setQ} className="w-52" />
                <Switch label="Only running" checked={onlyRunning} onCheckedChange={setOnlyRunning} />
                <ColumnPicker visibility={vis} onChange={setVis} columns={[{ id: 'image', label: 'Image' }, { id: 'port', label: 'Ports' }, { id: 'cpu', label: 'CPU' }, { id: 'created', label: 'Created' }]} />
              </div>
              <BulkBar count={selected.length} noun="container" onClear={() => setSel({})}>
                <Button size="sm" icon={<Play />}>Start</Button>
                <Button size="sm" icon={<Square />}>Stop</Button>
                <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setConfirmOpen(true)}>Delete</Button>
              </BulkBar>
              <div className="min-h-0 flex-1 overflow-auto">
                <DataGrid
                  label="Containers"
                  columns={colDefs}
                  data={grouped}
                  getRowId={(r) => r.id}
                  getRowLabel={(r) => r.name}
                  rowSelection={sel}
                  onRowSelectionChange={setSel}
                  columnVisibility={vis}
                  onColumnVisibilityChange={setVis}
                  isRowBusy={(r) => r.status === 'restarting'}
                  onRowOpen={(r) => toast({ kind: 'info', title: `Open ${r.name}`, body: 'Detail view comes in replica-build.' })}
                  rowActions={(r) => (
                    <ActionsMenu
                      label={`Actions for ${r.name}`}
                      entries={[
                        r.status === 'running' ? { label: 'Stop', icon: <Square />, onSelect: () => {} } : { label: 'Start', icon: <Play />, onSelect: () => {} },
                        { label: 'Pause', icon: <Pause />, onSelect: () => {}, disabled: r.status !== 'running', disabledReason: 'Only running containers can be paused' },
                        { label: 'Restart', icon: <RotateCw />, onSelect: () => {} },
                        { label: 'Open terminal', icon: <SquareTerminal />, onSelect: () => {}, disabled: r.status !== 'running' },
                        { kind: 'separator' },
                        { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setConfirmOpen(true) },
                      ]}
                    />
                  )}
                  empty={
                    <EmptyState
                      icon={<Box />}
                      title={q || onlyRunning ? 'No containers match' : 'No containers yet'}
                      body={q || onlyRunning ? 'Try a different name, or show stopped containers too.' : 'Start one from an image and it shows up here.'}
                      action={q || onlyRunning ? <Button onClick={() => { setQ(''); setOnlyRunning(false) }}>Clear filters</Button> : <Button variant="primary" icon={<Layers />}>Go to images</Button>}
                    />
                  }
                />
              </div>
              <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-4">
                <EnginePill state="running" detail="v28.3" />
                <div className="flex-1" />
                <ResourceMeter label="CPU" value={7} max={100} format={(v) => `${v}%`} />
                <ResourceMeter label="RAM" value={3.4} max={7.6} format={(v) => `${v.toFixed(1)} GB`} />
              </footer>
            </div>
          </div>
        </Section>

        <Section title="Grid states">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-line">
              <DataGrid label="Loading" columns={colDefs} data={[]} loading getRowId={(r) => r.id} getRowLabel={(r) => r.name} rowSelection={{}} onRowSelectionChange={() => {}} columnVisibility={{}} onColumnVisibilityChange={() => {}} />
            </div>
            <div className="rounded-lg border border-line">
              <EmptyState icon={<HardDrive />} title="No volumes yet" body="Volumes keep data when a container is removed. Create one, or run a container that declares one." action={<Button variant="primary">Create volume</Button>} />
            </div>
          </div>
        </Section>

        <Section title="Detail tabs and log viewer (S04)">
          <div className="flex h-[360px] flex-col overflow-hidden rounded-lg border border-line">
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
              <h2 className="text-md text-fg">shop-api-1</h2>
              <StatusChip status="running" />
              <span className="font-mono text-xs text-muted">node:22-alpine</span>
              <div className="flex-1" />
              <Button size="sm" iconOnly aria-label="Pause" icon={<Pause />} />
              <Button size="sm" iconOnly aria-label="Stop" icon={<Square />} />
              <Button size="sm" iconOnly aria-label="Restart" icon={<RotateCw />} />
              <Button size="sm" variant="danger" iconOnly aria-label="Delete" icon={<Trash2 />} />
            </div>
            <Tabs
              label="Container details"
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'logs', label: 'Logs', content: <LogViewer label="Logs for shop-api-1" lines={logLines} /> },
                { value: 'inspect', label: 'Inspect', content: <p className="p-4 text-base text-muted">JSON inspector (CodeMirror) is built in replica-build.</p> },
                { value: 'mounts', label: 'Mounts', content: <p className="p-4 text-base text-muted">Bind mounts table.</p> },
                { value: 'exec', label: 'Terminal', content: <p className="p-4 text-base text-muted">xterm.js terminal is built in replica-build.</p> },
                { value: 'files', label: 'Files', disabled: true, disabledReason: 'Coming in a later milestone', content: null },
                { value: 'stats', label: 'Stats', content: <p className="p-4 text-base text-muted">uPlot charts are built in replica-build.</p> },
              ]}
            />
          </div>
        </Section>

        <Section title="Overlays">
          <Row>
            <Button variant="primary" icon={<Play />} onClick={() => setRunOpen(true)}>Run dialog (S13)</Button>
            <Button variant="danger" onClick={() => setConfirmOpen(true)}>Confirm delete (S18)</Button>
            <Button onClick={() => setBlockedOpen(true)}>Blocked delete</Button>
            <Button onClick={() => setPaletteOpen(true)}>Quick search <kbd className="ml-1 text-xs text-muted">Ctrl K</kbd></Button>
            <Button onClick={() => toast({ kind: 'success', title: 'Pulled nginx:1.27', body: '6 layers, 72.4 MB' })}>Success toast</Button>
            <Button onClick={() => toast({ kind: 'error', title: 'Could not start shop-api-1', body: 'Port 3000 is already allocated on the host.' })}>Error toast</Button>
          </Row>
        </Section>

        <Section title="Pull progress (S14)">
          <div className="max-w-[560px]">
            <ProgressList
              layers={[
                { id: '4f2a9c1e0b7d', status: 'done', total: 29_000_000, current: 29_000_000 },
                { id: '9b13e7a2c440', status: 'extracting', total: 41_200_000, current: 41_200_000 },
                { id: '1c0d5f88ab21', status: 'downloading', total: 18_900_000, current: 7_300_000 },
                { id: 'e7a1b2c3d4f5', status: 'waiting' },
                { id: '3d9e0f1a2b3c', status: 'error' },
              ]}
            />
          </div>
        </Section>
      </main>

      <Modal
        open={runOpen}
        onOpenChange={setRunOpen}
        title="Run nginx:1.27"
        description="Starts a new container from this image."
        footer={
          <>
            <Button onClick={() => setRunOpen(false)}>Cancel</Button>
            <Button variant="primary" icon={<Play />} onClick={() => setRunOpen(false)}>Run</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input label="Container name" placeholder="Optional, generated if empty" />
          <KvEditor legend="Ports" keyLabel="Host port" valueLabel="Container port" keyPlaceholder="host" valuePlaceholder="container" rows={ports} onChange={setPorts} addLabel="Add port" />
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete 2 containers?"
        items={['shop-web-1', 'migrate-once']}
        impact="Their anonymous volumes are kept."
        confirmLabel="Delete containers"
        onConfirm={() => new Promise((r) => setTimeout(r, 600))}
      />
      <ConfirmDialog
        open={blockedOpen}
        onOpenChange={setBlockedOpen}
        title="Can’t delete shop-data yet"
        items={['shop-data']}
        blockedReason="shop-db-1 is using this volume. Stop and remove that container first."
        confirmLabel="Delete volume"
        onConfirm={() => {}}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        groups={[
          { heading: 'Containers', items: containers.map((c) => ({ id: c.id, label: c.name, hint: c.image, icon: <Box />, onSelect: () => {} })) },
          { heading: 'Images', items: [{ id: 'i1', label: 'nginx:1.27', hint: '72.4 MB', icon: <Layers />, onSelect: () => {} }, { id: 'i2', label: 'postgres:17', hint: '438 MB', icon: <Layers />, onSelect: () => {} }] },
          { heading: 'Volumes', items: [{ id: 'v1', label: 'shop-data', hint: 'in use', icon: <Database />, onSelect: () => {} }] },
        ]}
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg text-fg">{title}</h2>
      {children}
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>
}
