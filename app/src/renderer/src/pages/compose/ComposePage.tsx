import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpCircle, Download, FileStack, FolderOpen, Hammer, Info, MoreHorizontal, Power, RotateCw, ScrollText, Square } from 'lucide-react'
import { api, type ComposeCommand, type ComposeFile, type ComposeService, type LogLine } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { LogViewer } from '@/components/ui/log-viewer'
import { ActionsMenu, type MenuEntry } from '@/components/ui/menu'
import { StatusChip } from '@/components/ui/status-chip'
import { Tabs } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/toast'
import { href, navigate } from '@/lib/router'
import { cn } from '@/lib/cn'

export const composeKeys = { list: ['composeFiles'] as const, one: (path: string) => ['composeFile', path] as const }

const fileName = (p: string) => p.split(/[\\/]/).slice(-2).join('/')
const summary = (f: ComposeFile) => {
  const up = f.services.filter((s) => s.state === 'running').length
  return f.error ? 'can’t be read' : !up ? 'down' : up === f.services.length ? 'running' : `${up} of ${f.services.length} running`
}

/** Compose files: the ones added here and the ones running projects came from. */
export function ComposePage({ path }: { path?: string }) {
  return path ? <ComposeDetail path={path} /> : <ComposeList />
}

function ComposeList() {
  const qc = useQueryClient()
  const toast = useToast()
  const files = useQuery({ queryKey: composeKeys.list, queryFn: api.composeFiles.list, staleTime: 0 })
  const [adding, setAdding] = useState(false)

  const add = async () => {
    setAdding(true)
    try {
      const f = await api.composeFiles.add()
      if (!f) return
      void qc.invalidateQueries({ queryKey: composeKeys.list })
      navigate('compose', f.path)
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t open that file', body: (e as Error).message })
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      <PageHeader title="Compose">
        <Button variant="primary" icon={<FolderOpen />} loading={adding} onClick={() => void add()}>
          Open file
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {files.isError ? (
          <ErrorState what="Compose files" error={files.error} onRetry={() => void files.refetch()} />
        ) : files.isPending ? (
          <p role="status" className="p-5 text-base text-muted">
            Reading Compose files…
          </p>
        ) : files.data.length ? (
          <ul aria-label="Compose files" className="flex flex-col">
            {files.data.map((f) => (
              <li key={f.path} className="border-b border-line">
                <a href={href('compose', f.path)} className="flex items-center gap-3 px-5 py-2.5 hover:bg-hover">
                  <FileStack aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-fg">{f.project || fileName(f.path)}</span>
                    <span className="truncate font-mono text-xs text-muted" title={f.path}>
                      {f.path}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm text-muted">{f.error ? 'can’t be read' : `${f.services.length} services · ${summary(f)}`}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<FileStack />}
            title="No Compose files yet"
            body="Open a compose.yaml to start, stop, pull and build its services from here. Projects you start in a terminal show up here on their own."
            action={
              <Button variant="primary" icon={<FolderOpen />} onClick={() => void add()}>
                Open a Compose file
              </Button>
            }
          />
        )}
      </div>
    </>
  )
}

const VERB: Record<ComposeCommand, [string, string]> = {
  up: ['Started', 'Couldn’t start'],
  down: ['Took down', 'Couldn’t take down'],
  pull: ['Pulled', 'Couldn’t pull'],
  build: ['Built', 'Couldn’t build'],
  restart: ['Restarted', 'Couldn’t restart'],
  stop: ['Stopped', 'Couldn’t stop'],
}

const chip = (s: ComposeService['state']) => (s === 'missing' ? 'created' : s)

function ComposeDetail({ path }: { path: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const file = useQuery({ queryKey: composeKeys.one(path), queryFn: () => api.composeFiles.get(path), staleTime: 0 })
  const [tab, setTab] = useState('services')
  const [lines, setLines] = useState<LogLine[]>([])
  const [running, setRunning] = useState<{ id: string; label: string } | null>(null)
  const [confirmDown, setConfirmDown] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    // Set on every mount: StrictMode mounts, unmounts and mounts again.
    alive.current = true
    return () => void (alive.current = false)
  }, [])

  if (file.isError) return <ErrorState what="this Compose file" error={file.error} onRetry={() => void file.refetch()} />
  if (file.isPending) return <p role="status" className="p-5 text-base text-muted">Reading the Compose file…</p>
  const f = file.data
  const title = f.project || fileName(f.path)

  const run = (cmd: ComposeCommand, service?: string) => {
    const what = service ?? title
    const ts = () => new Date().toISOString()
    setLines([{ ts: ts(), stream: 'stdout', text: `$ docker compose ${cmd}${service ? ` ${service}` : ''}` }])
    const h = api.composeFiles.run(path, cmd, service, (ls) => alive.current && setLines((x) => [...x, ...ls.map((text) => ({ ts: ts(), stream: 'stdout' as const, text }))].slice(-5000)))
    setRunning({ id: h.runId, label: `${cmd} ${what}` })
    h.done
      .then(() => toast({ kind: 'success', title: `${VERB[cmd][0]} ${what}` }))
      .catch((e: Error & { status?: number }) => e.status !== 499 && toast({ kind: 'error', title: `${VERB[cmd][1]} ${what}`, body: e.message }))
      .finally(() => {
        if (alive.current) setRunning(null)
        void qc.invalidateQueries({ queryKey: composeKeys.one(path) })
        void qc.invalidateQueries({ queryKey: composeKeys.list })
      })
  }

  const busy = !!running
  const anyBuild = f.services.some((s) => s.build)
  const anyUp = f.services.some((s) => s.state !== 'missing')

  return (
    <>
      <PageHeader
        back={
          <a href={href('compose')} aria-label="Back to Compose files" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" />
          </a>
        }
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">{title}</span>
            {!f.error && <span className="shrink-0 text-sm font-normal text-muted">{summary(f)}</span>}
          </span>
        }
      >
        {running ? (
          <Button variant="danger" icon={<Square />} onClick={() => void api.composeFiles.cancel(running.id)}>
            Stop {running.label.split(' ')[0]}
          </Button>
        ) : (
          <>
            <Button variant="primary" icon={<ArrowUpCircle />} disabled={!!f.error} onClick={() => run('up')}>
              Up
            </Button>
            <Button icon={<Square />} disabled={!!f.error || !anyUp} onClick={() => run('stop')}>
              Stop
            </Button>
            <ActionsMenu
              label={`More for ${title}`}
              trigger={<Button iconOnly aria-label={`More for ${title}`} icon={<MoreHorizontal />} />}
              entries={[
                { label: 'Restart', icon: <RotateCw />, disabled: !!f.error || !anyUp, onSelect: () => run('restart') },
                { label: 'Pull images', icon: <Download />, disabled: !!f.error, onSelect: () => run('pull') },
                { label: 'Build images', icon: <Hammer />, disabled: !!f.error || !anyBuild, disabledReason: 'No service has a build section', onSelect: () => run('build') },
                { kind: 'separator' },
                { label: 'Down (remove containers)', icon: <Power />, danger: true, disabled: !!f.error || !anyUp, onSelect: () => setConfirmDown(true) },
                ...(f.saved
                  ? ([
                      { kind: 'separator' },
                      {
                        label: 'Forget this file',
                        icon: <Info />,
                        onSelect: () =>
                          void api.composeFiles.forget(path).then(() => {
                            void qc.invalidateQueries({ queryKey: composeKeys.list })
                            navigate('compose')
                          }),
                      },
                    ] as MenuEntry[])
                  : []),
              ]}
            />
          </>
        )}
      </PageHeader>
      <p className="shrink-0 truncate border-b border-line px-5 py-1.5 font-mono text-xs text-muted" title={f.path}>
        {f.path}
      </p>
      {f.error ? (
        <ErrorState what="this Compose file" error={new Error(f.error)} onRetry={() => void file.refetch()} />
      ) : (
        <Tabs
          label="Compose file"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'services', label: 'Services', content: <Services file={f} busy={busy} run={run} lines={lines} /> },
            { value: 'env', label: '.env', content: <EnvEditor path={path} /> },
          ]}
        />
      )}
      <ConfirmDialog
        open={confirmDown}
        onOpenChange={setConfirmDown}
        title={`Take ${title} down?`}
        items={f.services.filter((s) => s.state !== 'missing').map((s) => s.name)}
        impact="Its containers and its default network are removed. Named volumes and images stay, so Up brings it back with its data."
        confirmLabel="Take down"
        onConfirm={() => run('down')}
      />
    </>
  )
}

function Services({ file: f, busy, run, lines }: { file: ComposeFile; busy: boolean; run: (c: ComposeCommand, s?: string) => void; lines: LogLine[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('overflow-auto', lines.length ? 'max-h-[45%] shrink-0' : 'min-h-0 flex-1')}>
        <table aria-label={`Services in ${f.project}`} className="w-full table-fixed border-collapse text-sm">
          <thead className="sticky top-0 bg-surface">
            <tr className="h-8 border-b border-line text-left text-xs text-muted">
              <th className="px-5 font-medium">Service</th>
              <th className="w-32 px-3 font-medium">State</th>
              <th className="px-3 font-medium">Image</th>
              <th className="w-36 px-3 font-medium">Ports</th>
              <th className="w-12 px-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {f.services.map((s) => (
              <tr key={s.name} className="h-10 border-b border-line">
                <td className="truncate px-5 font-medium">{s.name}</td>
                <td className="px-3">{s.state === 'missing' ? <span className="text-muted">Not created</span> : <StatusChip status={chip(s.state)} />}</td>
                <td className="truncate px-3 font-mono text-xs text-muted" title={s.image}>
                  {s.image ?? (s.build ? 'built from a Dockerfile' : '—')}
                </td>
                <td className="truncate px-3 font-mono text-xs text-muted">{s.ports.join(', ') || '—'}</td>
                <td className="px-3 text-right">
                  <ActionsMenu
                    label={`Actions for ${s.name}`}
                    entries={[
                      { label: s.state === 'missing' ? 'Create and start' : 'Start', icon: <ArrowUpCircle />, disabled: busy || s.state === 'running', onSelect: () => run('up', s.name) },
                      { label: 'Stop', icon: <Square />, disabled: busy || s.state !== 'running', onSelect: () => run('stop', s.name) },
                      { label: 'Restart', icon: <RotateCw />, disabled: busy || s.state === 'missing', onSelect: () => run('restart', s.name) },
                      { label: 'Pull image', icon: <Download />, disabled: busy || !s.image, onSelect: () => run('pull', s.name) },
                      { label: 'Build image', icon: <Hammer />, disabled: busy || !s.build, onSelect: () => run('build', s.name) },
                      ...(s.containerIds[0] ? ([{ kind: 'separator' }, { label: 'Logs', icon: <ScrollText />, onSelect: () => navigate('containers', s.containerIds[0], 'logs') }] as MenuEntry[]) : []),
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line">
          <LogViewer label="Compose output" lines={lines} fileName={`compose-${f.project}`} />
        </div>
      )}
    </div>
  )
}

function EnvEditor({ path }: { path: string }) {
  const toast = useToast()
  const env = useQuery({ queryKey: ['composeEnv', path], queryFn: () => api.composeFiles.readEnv(path), staleTime: 0 })
  const [text, setText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const value = text ?? env.data ?? ''
  const dirty = text !== null && text !== env.data

  const save = async () => {
    setSaving(true)
    try {
      await api.composeFiles.writeEnv(path, value)
      toast({ kind: 'success', title: 'Saved .env', body: 'Up applies it to containers that need recreating.' })
      await env.refetch()
      setText(null)
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t save .env', body: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (env.isError) return <ErrorState what="the .env file" error={env.error} onRetry={() => void env.refetch()} />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
      <p className="text-sm text-muted">The .env next to the Compose file. Compose reads it for ${'{'}VARIABLES{'}'} in the file. It is saved as plain text, so keep real secrets elsewhere.</p>
      <textarea
        aria-label=".env contents"
        spellCheck={false}
        value={value}
        disabled={env.isPending}
        onChange={(e) => setText(e.target.value)}
        placeholder="NAME=value"
        className="min-h-48 flex-1 resize-none rounded-md border border-line-strong bg-bg p-3 font-mono text-sm text-fg outline-none focus-visible:outline-2 focus-visible:outline-focus"
      />
      <div className="flex gap-2">
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
        <Button disabled={!dirty || saving} onClick={() => setText(null)}>
          Discard changes
        </Button>
      </div>
    </div>
  )
}
