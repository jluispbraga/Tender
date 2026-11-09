import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Check, CircleSlash, Loader2, RotateCw, Wrench, X } from 'lucide-react'
import { api, type MigrationCheck, type MigrationEvent, type MigrationItem, type MigrationStep } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { bytes } from '@/lib/format'
import { navigate } from '@/lib/router'

/**
 * Moves containers, images and volumes from Docker Desktop into the Docker
 * Engine inside WSL (Windows). Tender never opens or changes Docker Desktop:
 * the user opens it for the move, and nothing is deleted from it.
 */
export function MigratePage() {
  const check = useQuery({ queryKey: ['migrate', 'check'], queryFn: () => api.migrate.check(), refetchOnWindowFocus: true })
  const c = check.data
  const ready = !!c?.source.ok && !!c.target.ok && !!c.target.distro
  const [running, setRunning] = useState(false)

  return (
    <>
      <PageHeader title="Move from Docker Desktop" />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="flex max-w-3xl flex-col gap-6">
          <p className="text-base text-muted">
            Your containers, images and volumes live inside Docker Desktop’s engine. This copies them into the Docker Engine inside WSL, the one Tender uses without Docker Desktop. Nothing is deleted from Docker Desktop, so you can move again or go back.
          </p>
          {!running && <Checks check={c} loading={check.isFetching} onRecheck={() => void check.refetch()} />}
          {ready && <Move distro={c.target.distro!} onRunning={setRunning} />}
        </div>
      </div>
    </>
  )
}

// ---- 1. both engines ----------------------------------------------------------------------

function Checks({ check, loading, onRecheck }: { check?: MigrationCheck; loading: boolean; onRecheck: () => void }) {
  return (
    <section aria-labelledby="checks-title" className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="checks-title" className="text-md text-fg">
          Before moving
        </h2>
        <Button icon={<RotateCw />} loading={loading} onClick={onRecheck}>
          Check again
        </Button>
      </div>
      {!check ? (
        <p role="status" className="inline-flex items-center gap-2 text-sm text-muted">
          <Loader2 aria-hidden className="size-4 animate-spin" /> Looking at both engines…
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          <CheckRow ok={check.source.ok} title="Docker Desktop’s engine (where they are now)" detail={check.source.ok ? `Running, Docker ${check.source.version}, ${check.source.containers} containers` : check.source.reason} />
          <CheckRow
            ok={check.target.ok}
            title="Docker Engine inside WSL (where they go)"
            detail={check.target.ok ? `${check.target.distro}, Docker ${check.target.version}` : check.target.reason}
          >
            {(check.target.hijacked || check.target.lost) && <RepairSteps distro={(check.target.hijacked ?? check.target.lost)!} hijacked={!!check.target.hijacked} onDone={onRecheck} />}
            {!check.target.ok && !check.target.hijacked && !check.target.lost && (
              <p className="text-sm text-muted">
                Install Docker Engine in your WSL distribution (Docker’s guide “Install Docker Engine on Ubuntu”), add your user to the <code className="font-mono text-xs text-fg">docker</code> group, and keep the distribution running.
              </p>
            )}
          </CheckRow>
        </ul>
      )}
    </section>
  )
}

/** The distribution's engine runs, but Docker Desktop holds or removed its socket. */
function RepairSteps({ distro, hijacked, onDone }: { distro: string; hijacked: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2 text-sm text-muted">
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          In Docker Desktop, open Settings › Resources › WSL integration, turn off <strong className="text-fg">Enable integration with my default WSL distro</strong> and <strong className="text-fg">{distro}</strong>, then click Apply. {hijacked ? 'Until then, Docker Desktop answers in its place.' : 'Otherwise Docker Desktop takes the socket again next time it starts.'}
        </li>
        <li>Repair: Tender restarts Docker in {distro} so it gets its socket back. Containers running there stop; those with a restart policy come back.</li>
      </ol>
      <div>
        <Button
          icon={<Wrench />}
          loading={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await api.migrate.repairSocket(distro)
              onDone()
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Repair Docker in {distro}
        </Button>
      </div>
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-danger">{error}</p>}
    </div>
  )
}

function CheckRow({ ok, title, detail, children }: { ok: boolean; title: string; detail?: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={ok ? 'text-success' : 'text-warning'}>{ok ? <Check aria-hidden className="size-5" /> : <AlertTriangle aria-hidden className="size-5" />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-base text-fg">
          {title}
          <span className="sr-only">{ok ? ': ready' : ': not ready'}</span>
        </p>
        {detail && <p className="text-sm text-muted">{detail}</p>}
        {children}
      </div>
    </li>
  )
}

// ---- 2. choose and move -------------------------------------------------------------------

const stepLabel: Record<MigrationStep, string> = { prepare: 'Preparing', images: 'Images', networks: 'Networks', volumes: 'Volumes', containers: 'Containers', start: 'Starting containers' }

interface Line {
  step: MigrationStep
  name: string
  status: 'working' | 'done' | 'skipped' | 'failed'
  message?: string
}

function Move({ distro, onRunning }: { distro: string; onRunning: (r: boolean) => void }) {
  const qc = useQueryClient()
  const plan = useQuery({ queryKey: ['migrate', 'plan', distro], queryFn: () => api.migrate.plan(distro) })
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [start, setStart] = useState(true)
  const [lines, setLines] = useState<Line[]>([])
  const [step, setStep] = useState<MigrationStep | null>(null)
  const [transfer, setTransfer] = useState<{ name: string; done: number; total: number } | null>(null)
  const [result, setResult] = useState<Extract<MigrationEvent, { type: 'done' }> | { type: 'error'; message: string } | null>(null)
  const stop = useRef<(() => void) | null>(null)
  const items = plan.data?.items ?? []
  // Everything that runs a container is picked by default; spare images and volumes are opt-in.
  const chosen = picked ?? new Set(items.filter((i) => i.kind === 'project' || i.kind === 'container').map((i) => i.id))
  const total = useMemo(() => items.filter((i) => chosen.has(i.id)).reduce((n, i) => n + i.bytes, 0), [items, chosen])
  const busy = step !== null && !result

  useEffect(() => () => stop.current?.(), [])

  const go = () => {
    setLines([])
    setResult(null)
    setStep('prepare')
    onRunning(true)
    stop.current = api.migrate.run(distro, [...chosen], { start }, (e) => {
      if (e.type === 'step') setStep(e.step)
      if (e.type === 'bytes') setTransfer({ name: e.name, done: e.done, total: e.total })
      if (e.type === 'item') {
        setLines((ls) => {
          const i = ls.findIndex((l) => l.step === e.step && l.name === e.name)
          const line = { step: e.step, name: e.name, status: e.status, message: e.message }
          return i < 0 ? [...ls, line] : ls.map((l, j) => (j === i ? line : l))
        })
        if (e.status !== 'working') setTransfer(null)
      }
      if (e.type === 'done' || e.type === 'error') {
        setResult(e)
        setTransfer(null)
        stop.current = null
        // The engine Tender shows may be the target: refresh what it lists.
        void qc.invalidateQueries()
      }
    })
  }

  if (plan.isPending) {
    return (
      <p role="status" className="inline-flex items-center gap-2 text-sm text-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Listing what Docker Desktop has…
      </p>
    )
  }
  if (plan.isError) return <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">Could not list Docker Desktop’s containers: {(plan.error as Error).message}</p>

  return (
    <section aria-labelledby="move-title" className="flex flex-col gap-4 rounded-lg border border-line p-4">
      <h2 id="move-title" className="text-md text-fg">
        {result ? 'Done' : busy ? 'Moving…' : 'What to move'}
      </h2>

      {!busy && !result && (
        <>
          {items.length === 0 ? (
            <p className="text-sm text-muted">Docker Desktop has no containers, images or volumes to move.</p>
          ) : (
            <ul aria-label="Things to move" className="flex flex-col divide-y divide-line rounded-md border border-line">
              {items.map((i) => (
                <PlanRow
                  key={i.id}
                  item={i}
                  checked={chosen.has(i.id)}
                  onChange={(on) => {
                    const next = new Set(chosen)
                    if (on) next.add(i.id)
                    else next.delete(i.id)
                    setPicked(next)
                  }}
                />
              ))}
            </ul>
          )}
          <Switch label="Start the containers that were running in Docker Desktop" checked={start} onCheckedChange={setStart} />
          <div className="flex items-center gap-3">
            <Button variant="primary" icon={<ArrowRight />} disabled={!chosen.size} onClick={go}>
              Move {chosen.size} {chosen.size === 1 ? 'item' : 'items'} (about {bytes(total)})
            </Button>
            <span className="text-sm text-muted">Into {distro}. Images and volumes stream straight across; nothing is written to disk.</span>
          </div>
        </>
      )}

      {(busy || result) && (
        <>
          {busy && step && (
            <div role="status" className="flex flex-col gap-2">
              <p className="inline-flex items-center gap-2 text-base text-fg">
                <Loader2 aria-hidden className="size-4 animate-spin" /> {stepLabel[step]}
                {transfer && (
                  <span className="text-muted">
                    · {transfer.name}: {bytes(transfer.done)}
                    {transfer.total > 0 && ` of about ${bytes(transfer.total)}`}
                  </span>
                )}
              </p>
            </div>
          )}
          <ul aria-label="Progress" className="flex max-h-96 flex-col gap-1 overflow-auto rounded-md bg-surface p-3 text-sm">
            {lines.map((l) => (
              <li key={`${l.step}/${l.name}`} className="flex items-start gap-2">
                <StatusIcon status={l.status} />
                <span className="text-muted">{stepLabel[l.step]}</span>
                <span className="min-w-0 flex-1 break-all text-fg">
                  {l.name}
                  {l.message && <span className="text-muted"> · {l.message}</span>}
                </span>
              </li>
            ))}
          </ul>
          {busy && (
            <div>
              <Button icon={<X />} onClick={() => stop.current?.()}>
                Cancel
              </Button>
            </div>
          )}
          {result && <Summary result={result} />}
        </>
      )}
    </section>
  )
}

function PlanRow({ item, checked, onChange }: { item: MigrationItem; checked: boolean; onChange: (on: boolean) => void }) {
  const what = [
    item.containers.length && `${item.containers.length} ${item.containers.length === 1 ? 'container' : 'containers'}${item.running ? `, ${item.running} running` : ''}`,
    item.images.length && `${item.images.length} ${item.images.length === 1 ? 'image' : 'images'}`,
    item.volumes.length && `${item.volumes.length} ${item.volumes.length === 1 ? 'volume' : 'volumes'}`,
  ].filter(Boolean)
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <Checkbox label={`Move ${item.label}`} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-base text-fg">
          {item.label}
          {item.kind === 'project' && <span className="text-muted"> · Compose project</span>}
        </span>
        <span className="text-sm text-muted">{what.join(' · ')}</span>
        {item.conflicts.length > 0 && <span className="text-sm text-warning">Already in WSL, left as is: {item.conflicts.join(', ')}</span>}
      </div>
      <span className="text-sm text-muted tabular-nums">{bytes(item.bytes)}</span>
    </li>
  )
}

function StatusIcon({ status }: { status: Line['status'] }) {
  if (status === 'working') return <Loader2 aria-label="working" className="mt-0.5 size-4 shrink-0 animate-spin text-muted" />
  if (status === 'done') return <Check aria-label="done" className="mt-0.5 size-4 shrink-0 text-success" />
  if (status === 'skipped') return <CircleSlash aria-label="skipped" className="mt-0.5 size-4 shrink-0 text-muted" />
  return <X aria-label="failed" className="mt-0.5 size-4 shrink-0 text-danger" />
}

function Summary({ result }: { result: Extract<MigrationEvent, { type: 'done' }> | { type: 'error'; message: string } }) {
  if (result.type === 'error') return <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">The move stopped: {result.message}</p>
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-base text-fg">
        {result.cancelled ? 'Cancelled. ' : ''}
        {result.moved} moved, {result.skipped} already there, {result.failed} failed.
      </p>
      <p className="text-sm text-muted">
        Docker Desktop still has its copy. Once everything works from WSL, you can uninstall Docker Desktop; if you still use the Windows <code className="font-mono text-xs text-fg">docker</code> command, switch it back with{' '}
        <code className="font-mono text-xs text-fg">docker context use default</code>.
      </p>
      <div>
        <Button variant="primary" onClick={() => navigate('containers')}>
          Open containers
        </Button>
      </div>
    </div>
  )
}
