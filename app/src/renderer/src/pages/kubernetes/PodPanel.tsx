import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { AlertTriangle, CheckCircle2, RotateCw, X } from 'lucide-react'
import { api, type ExecSession, type KubeOverview } from '@/api'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { ago } from '@/lib/format'
import { cn } from '@/lib/cn'
import { LogViewer, type LogLine } from '@/components/ui/log-viewer'

type Pod = KubeOverview['pods'][number]
export type PodTab = 'logs' | 'details' | 'terminal'

/** The panel under the list for one pod: its logs, its details and events, or a shell in it. */
export function PodPanel({ context, pod, tab, onTab, onClose }: { context: string; pod: Pod; tab: PodTab; onTab: (t: PodTab) => void; onClose: () => void }) {
  const [container, setContainer] = useState(pod.containers[0])
  const [height, setHeight] = usePanelHeight()
  return (
    <section aria-label={`Pod ${pod.name}`} style={{ height }} className="relative flex shrink-0 flex-col border-t border-line">
      <ResizeHandle height={height} onResize={setHeight} />
      <div className="flex shrink-0 items-center gap-3 px-4 pt-2 text-sm">
        <span className="truncate font-medium text-fg">{pod.name}</span>
        <div role="tablist" aria-label="Pod view" className="flex gap-1">
          {(['logs', 'details', 'terminal'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => onTab(t)} className={cn('-mb-px border-b-2 px-2 py-1 capitalize', tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
              {t}
            </button>
          ))}
        </div>
        {tab !== 'details' && pod.containers.length > 1 && (
          <div className="w-40">
            <Select label="Container" value={container} onValueChange={setContainer} options={pod.containers.map((k) => ({ value: k, label: k }))} />
          </div>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" iconOnly aria-label="Close pod panel" icon={<X />} onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t border-line">
        {tab === 'logs' && <PodLogs key={`${pod.name}/${container}`} context={context} pod={pod} container={container} />}
        {tab === 'details' && <PodDetails context={context} pod={pod} />}
        {tab === 'terminal' && <PodTerminal key={`${pod.name}/${container}`} context={context} pod={pod} container={container} />}
      </div>
    </section>
  )
}

const HEIGHT_KEY = 'tender.kube.panelHeight'
const MIN_HEIGHT = 160
// Leave the header and a few rows of the list above the panel.
const maxHeight = () => Math.max(MIN_HEIGHT, window.innerHeight - 220)
const clamp = (h: number) => Math.round(Math.min(maxHeight(), Math.max(MIN_HEIGHT, h)))

/** The panel's height, remembered across pods and restarts. */
function usePanelHeight(): [number, (h: number) => void] {
  const [h, set] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY))
      return clamp(saved || 320)
    } catch {
      return 320
    }
  })
  useEffect(() => {
    const fit = () => set((x) => clamp(x))
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  const update = (next: number) => {
    const v = clamp(next)
    set(v)
    try {
      localStorage.setItem(HEIGHT_KEY, String(v))
    } catch {
      /* private profile: the height just isn't remembered */
    }
  }
  return [h, update]
}

/** Drag the top edge, or focus it and use the arrow keys (Shift for bigger steps). */
function ResizeHandle({ height, onResize }: { height: number; onResize: (h: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize pod panel"
      aria-valuenow={height}
      aria-valuemin={MIN_HEIGHT}
      aria-valuemax={maxHeight()}
      tabIndex={0}
      className="absolute -top-1.5 right-0 left-0 z-10 h-3 cursor-row-resize outline-none after:absolute after:top-1/2 after:right-0 after:left-0 after:h-0.5 after:-translate-y-1/2 hover:after:bg-accent focus-visible:after:bg-focus"
      onPointerDown={(e) => {
        e.preventDefault()
        const startY = e.clientY
        const startH = height
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const move = (ev: PointerEvent) => onResize(startH + (startY - ev.clientY))
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
      onDoubleClick={() => onResize(320)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 20
        if (e.key === 'ArrowUp') onResize(height + step)
        else if (e.key === 'ArrowDown') onResize(height - step)
        else if (e.key === 'Home') onResize(maxHeight())
        else if (e.key === 'End') onResize(MIN_HEIGHT)
        else return
        e.preventDefault()
      }}
    />
  )
}

const MAX_LINES = 5000

/** "2024-05-01T10:00:00.123456789Z message", as the API sends it with timestamps on. */
export function podLogLine(raw: string): LogLine {
  const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/s.exec(raw)
  return m ? { ts: m[1], stream: 'stdout', text: m[2] } : { ts: '', stream: 'stdout', text: raw }
}

function PodLogs({ context, pod, container }: { context: string; pod: Pod; container: string }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  // A crashing pod's current log is usually empty; why it crashed is in the run before.
  const crashing = pod.restarts > 0 && !/^Running$|^Completed$|^Succeeded$/.test(pod.status)
  const [previous, setPrevious] = useState(crashing)
  useEffect(() => {
    setLines([])
    setError(null)
    return api.kube.logs(context, pod.namespace, pod.name, container, (e) => (e.type === 'lines' ? setLines((ls) => [...ls, ...e.lines.map(podLogLine)].slice(-MAX_LINES)) : setError(e.message)), { previous })
  }, [context, pod.namespace, pod.name, container, previous])
  const which = (
    <>
      {pod.restarts > 0 && (
        <div role="radiogroup" aria-label="Which run" className="inline-flex rounded-md border border-line p-0.5">
          {([false, true] as const).map((p) => (
            <button key={String(p)} role="radio" aria-checked={previous === p} onClick={() => setPrevious(p)} className={cn('rounded px-2 py-0.5 text-xs', previous === p ? 'bg-selected font-medium text-fg' : 'text-muted hover:text-fg')}>
              {p ? 'Before the last restart' : 'Current run'}
            </button>
          ))}
        </div>
      )}
      <span className="text-xs text-muted">{previous ? `before restart ${pod.restarts}` : 'last 1,000 lines, then live'}</span>
    </>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && <p className="mx-4 my-1 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <LogViewer label={`Logs of ${pod.name}`} fileName={`${pod.name}-${container}${previous ? '-previous' : ''}`} lines={lines} toolbar={which} />
    </div>
  )
}

function PodDetails({ context, pod }: { context: string; pod: Pod }) {
  const d = useQuery({ queryKey: ['kube', 'pod', context, pod.namespace, pod.name], queryFn: () => api.kube.podDetails(context, pod.namespace, pod.name), refetchInterval: 5000, retry: false })
  if (d.isError) return <p className="m-4 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(d.error as Error).message}</p>
  if (!d.data) return <p className="p-4 text-sm text-muted">Reading {pod.name}…</p>
  const x = d.data
  const warnings = x.events.filter((e) => e.type === 'Warning')
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-0 overflow-hidden text-sm">
      <div className="min-h-0 overflow-auto border-r border-line px-4 py-3">
        <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted">Node</dt>
          <dd className="truncate">{x.node ?? '—'}</dd>
          <dt className="text-muted">Pod IP</dt>
          <dd className="font-mono text-xs">{x.ip ?? '—'}</dd>
          <dt className="text-muted">Started</dt>
          <dd>{x.startedAt ? ago(x.startedAt) : '—'}</dd>
        </dl>
        <h2 className="mt-3 mb-1 font-medium text-fg">Containers</h2>
        <ul aria-label="Containers" className="flex flex-col gap-2">
          {x.containers.map((c) => (
            <li key={c.name} className="rounded-md border border-line px-3 py-2">
              <p className="flex items-center gap-2">
                {c.ready ? <CheckCircle2 aria-hidden className="size-4 text-success" /> : <AlertTriangle aria-hidden className="size-4 text-danger" />}
                <span className="font-medium">{c.name}</span>
                <span className="text-muted">{c.state}</span>
              </p>
              <p className="truncate font-mono text-xs text-muted">{c.image}</p>
              {c.message && <p className="text-xs text-danger">{c.message}</p>}
              {c.lastTermination && (
                <p className="text-xs text-muted">
                  Last run ended: <span className="text-fg">{c.lastTermination.reason}</span>, exit code {c.lastTermination.exitCode}
                  {c.lastTermination.finishedAt && `, ${ago(c.lastTermination.finishedAt)}`}. Restarts: {c.restarts}.
                </p>
              )}
            </li>
          ))}
        </ul>
        <h2 className="mt-3 mb-1 font-medium text-fg">Conditions</h2>
        <ul className="flex flex-col gap-0.5">
          {x.conditions.map((c) => (
            <li key={c.type} className={c.ok ? 'text-muted' : 'text-danger'}>
              {c.ok ? '✓' : '✗'} {c.type}
              {!c.ok && c.message && `: ${c.message}`}
            </li>
          ))}
        </ul>
      </div>
      <div className="min-h-0 overflow-auto px-4 py-3">
        <h2 className="mb-1 font-medium text-fg">
          Events{warnings.length > 0 && <span className="ml-2 text-danger">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
        </h2>
        {x.events.length ? (
          <ul aria-label="Events" className="flex flex-col gap-1.5">
            {x.events.map((e, i) => (
              <li key={i} className={cn('rounded-md px-2 py-1', e.type === 'Warning' ? 'bg-danger-bg' : 'bg-surface')}>
                <p className="flex gap-2">
                  <span className={cn('font-medium', e.type === 'Warning' ? 'text-danger' : 'text-fg')}>{e.reason}</span>
                  <span className="text-muted">
                    {e.lastSeen && ago(e.lastSeen)}
                    {e.count > 1 && ` · ${e.count} times`}
                  </span>
                </p>
                <p className="text-xs break-words text-fg">{e.message}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">No recent events. Kubernetes keeps them for about an hour.</p>
        )}
      </div>
    </div>
  )
}

type Phase = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; code: number } | { kind: 'error'; message: string }
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--ds-${name}`).trim()

function PodTerminal({ context, pod, container }: { context: string; pod: Pod; container: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [shell, setShell] = useState<'auto' | '/bin/sh' | '/bin/bash'>('auto')
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({ fontFamily: css('font-mono'), fontSize: 13, cursorBlink: true, screenReaderMode: true, theme: { background: css('term-bg'), foreground: css('term-text'), cursor: css('focus'), selectionBackground: css('selected') } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
    let session: ExecSession | undefined
    let disposed = false
    setPhase({ kind: 'connecting' })
    api.kube
      .exec(context, pod.namespace, pod.name, container, { shell, cols: term.cols, rows: term.rows }, (d) => term.write(d), (code) => setPhase({ kind: 'closed', code }))
      .then((s) => {
        if (disposed) return s.close()
        session = s
        setPhase({ kind: 'open' })
        term.focus()
      })
      .catch((e: Error) => setPhase({ kind: 'error', message: e.message }))
    const input = term.onData((d) => session?.write(d))
    const ro = new ResizeObserver(() => {
      if (disposed) return
      fit.fit()
      session?.resize(term.cols, term.rows)
    })
    ro.observe(host.current)
    return () => {
      disposed = true
      ro.disconnect()
      input.dispose()
      session?.close()
      // Let xterm's first viewport sync run before disposing (see ExecTab).
      setTimeout(() => term.dispose(), 0)
    }
  }, [context, pod.namespace, pod.name, container, shell, attempt])
  return (
    <>
      <div className="flex shrink-0 items-center gap-3 px-4 py-1.5 text-sm">
        <div className="w-44">
          <Select label="Shell" value={shell} onValueChange={(v) => setShell(v as typeof shell)} options={[{ value: 'auto', label: 'bash, else sh' }, { value: '/bin/sh', label: '/bin/sh' }, { value: '/bin/bash', label: '/bin/bash' }]} />
        </div>
        <span role="status" className="text-muted">
          {phase.kind === 'connecting' && 'Connecting…'}
          {phase.kind === 'open' && 'Connected. Ctrl+Shift+Tab moves focus out of the terminal.'}
          {phase.kind === 'closed' && `Session ended (exit code ${phase.code}).`}
          {phase.kind === 'error' && <span className="text-danger">{phase.message}</span>}
        </span>
        <div className="flex-1" />
        {(phase.kind === 'closed' || phase.kind === 'error') && (
          <Button size="sm" icon={<RotateCw />} onClick={() => setAttempt((a) => a + 1)}>
            Reconnect
          </Button>
        )}
      </div>
      <div
        className="min-h-0 flex-1 bg-term-bg p-2"
        onKeyDown={(e) => {
          if (e.key === 'Tab' && e.ctrlKey && e.shiftKey) {
            e.preventDefault()
            ;(document.querySelector('[role="tablist"][aria-label="Pod view"] [aria-selected="true"]') as HTMLElement | null)?.focus()
          }
        }}
      >
        <div ref={host} className="h-full" aria-label={`Terminal in ${pod.name}`} />
      </div>
    </>
  )
}

/** The pods behind a deployment or StatefulSet, as the logs panel needs them. */
export type GroupPod = { name: string; namespace: string; container: string }

/**
 * Every pod of a deployment or StatefulSet in one log, each line tagged with its
 * pod and kept in time order (like stern). Pods that appear later join in; pods
 * that go away stop.
 */
export function WorkloadPanel({ context, title, tag, pods, onClose }: { context: string; title: string; /** The short name each line is tagged with. */ tag: (pod: string) => string; pods: GroupPod[]; onClose: () => void }) {
  const [height, setHeight] = usePanelHeight()
  const [lines, setLines] = useState<LogLine[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const subs = useRef(new Map<string, () => void>())
  const key = pods.map((p) => `${p.namespace}/${p.name}/${p.container}`).join(',')
  useEffect(() => {
    const want = new Set(pods.map((p) => `${p.namespace}/${p.name}`))
    for (const [id, stop] of subs.current) if (!want.has(id)) (stop(), subs.current.delete(id))
    for (const p of pods) {
      const id = `${p.namespace}/${p.name}`
      if (subs.current.has(id)) continue
      subs.current.set(
        id,
        api.kube.logs(context, p.namespace, p.name, p.container, (e) => {
          if (e.type === 'error') return setErrors((x) => ({ ...x, [p.name]: e.message }))
          const batch = e.lines.map((raw) => ({ ...podLogLine(raw), source: tag(p.name) }))
          // Each pod's first burst is its tail: merge by time so the pods interleave.
          setLines((ls) => [...ls, ...batch].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(-MAX_LINES))
        }),
      )
    }
    // The pods are compared by `key`, not by array identity.
  }, [context, key])
  useEffect(() => {
    const s = subs.current
    return () => {
      for (const stop of s.values()) stop()
      s.clear()
    }
  }, [])
  return (
    <section aria-label={`Logs of ${title}`} style={{ height }} className="relative flex shrink-0 flex-col border-t border-line">
      <ResizeHandle height={height} onResize={setHeight} />
      <div className="flex shrink-0 items-center gap-3 px-4 pt-2 pb-1 text-sm">
        <span className="truncate font-medium text-fg">{title}</span>
        <span className="text-muted">
          {pods.length} {pods.length === 1 ? 'pod' : 'pods'}, last 1,000 lines each, then live
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" iconOnly aria-label="Close logs panel" icon={<X />} onClick={onClose} />
      </div>
      {Object.entries(errors).map(([pod, msg]) => (
        <p key={pod} className="mx-4 mb-1 rounded-md bg-danger-bg px-3 py-1 text-xs text-danger">
          {pod}: {msg}
        </p>
      ))}
      <div className="flex min-h-0 flex-1 flex-col border-t border-line">
        {pods.length ? <LogViewer label={`Logs of ${title}`} fileName={title.replace(/\s+/g, '-')} lines={lines} /> : <p className="p-4 text-sm text-muted">No pods running for {title} right now.</p>}
      </div>
    </section>
  )
}
