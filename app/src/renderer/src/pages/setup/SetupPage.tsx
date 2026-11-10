import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Loader2, X } from 'lucide-react'
import { api, type WslSetupEvent, type WslSetupStep } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { keys } from '@/lib/queries'
import { navigate } from '@/lib/router'

const stepName: Record<WslSetupStep, string> = {
  systemd: 'Turn on systemd',
  packages: 'Install Docker Engine from download.docker.com',
  group: 'Let your user run docker without sudo',
  service: 'Start Docker',
  check: 'Check that it answers',
}

const dockerState = {
  none: 'No Docker yet',
  'cli-only': 'Docker CLI only, no engine',
  'desktop-cli': 'Only Docker Desktop’s integration, no engine of its own',
  installed: 'Docker Engine installed, not running',
  running: 'Docker Engine installed and running',
} as const

/** Windows: install Docker Engine inside a WSL distribution, the way Docker documents it. */
export function SetupPage() {
  const distros = useQuery({ queryKey: ['setup', 'distros'], queryFn: () => api.setup.distros() })
  const [chosen, setChosen] = useState<string | null>(null)
  const list = distros.data ?? []
  const name = chosen ?? list.find((d) => d.isDefault)?.name ?? list[0]?.name ?? null

  return (
    <>
      <PageHeader title="Set up Docker in WSL" />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="flex max-w-3xl flex-col gap-6">
          <p className="text-base text-muted">Tender installs Docker Engine inside a WSL distribution, following Docker’s own instructions for Debian and Ubuntu. Commands run as root through WSL, so there is no password to type, and every line they print shows below.</p>
          {distros.isPending ? (
            <p role="status" className="inline-flex items-center gap-2 text-sm text-muted">
              <Loader2 aria-hidden className="size-4 animate-spin" /> Listing WSL distributions…
            </p>
          ) : list.length === 0 ? (
            <NoDistro />
          ) : (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-md text-fg">Distribution</legend>
                {list.map((d) => (
                  <label key={d.name} className="flex items-center gap-2 text-base text-fg">
                    <input type="radio" name="distro" checked={name === d.name} onChange={() => setChosen(d.name)} className="accent-[var(--ds-accent)]" />
                    {d.name}
                    <span className="text-sm text-muted">
                      {d.isDefault ? 'default · ' : ''}
                      {d.running ? 'running' : 'stopped'} · WSL {d.version}
                    </span>
                  </label>
                ))}
              </fieldset>
              {name && <Distro key={name} name={name} wsl1={list.find((d) => d.name === name)?.version === 1} />}
            </>
          )}
        </div>
      </div>
    </>
  )
}

function NoDistro() {
  const cmd = 'wsl --install -d Ubuntu'
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <h2 className="text-md text-fg">No WSL distribution yet</h2>
      <p className="text-sm text-muted">Install Ubuntu first. Run this in a terminal opened as administrator, restart if Windows asks, then open Ubuntu once to create your Linux user:</p>
      <p className="flex items-center gap-2">
        <code className="rounded-md bg-surface px-2 py-1 font-mono text-sm text-fg">{cmd}</code>
        <CopyButton label="Copy the command" value={cmd} />
      </p>
    </section>
  )
}

function Distro({ name, wsl1 }: { name: string; wsl1: boolean }) {
  const qc = useQueryClient()
  // Looking inside starts the distribution if it is stopped, so only when the user picks it.
  const detail = useQuery({ queryKey: ['setup', 'inspect', name], queryFn: () => api.setup.inspect(name), enabled: !wsl1 })
  const [steps, setSteps] = useState<Extract<WslSetupEvent, { type: 'step' }>[]>([])
  const [lines, setLines] = useState<string[]>([])
  const [result, setResult] = useState<Extract<WslSetupEvent, { type: 'done' | 'error' }> | null>(null)
  const [running, setRunning] = useState(false)
  const stop = useRef<(() => void) | null>(null)
  const log = useRef<HTMLPreElement>(null)
  useEffect(() => () => stop.current?.(), [])
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [lines])

  if (wsl1) return <p className="text-sm text-muted">{name} runs on WSL 1. Docker Engine needs WSL 2: <code className="font-mono text-xs text-fg">wsl --set-version {name} 2</code></p>
  if (detail.isPending) {
    return (
      <p role="status" className="inline-flex items-center gap-2 text-sm text-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Looking inside {name}…
      </p>
    )
  }
  if (detail.isError) return <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">Could not look inside {name}: {(detail.error as Error).message}</p>
  const d = detail.data

  const go = () => {
    setSteps([])
    setLines([])
    setResult(null)
    setRunning(true)
    stop.current = api.setup.install(name, (e) => {
      if (e.type === 'step') setSteps((ss) => [...ss.filter((s) => s.step !== e.step), e])
      if (e.type === 'line') setLines((ls) => [...ls.slice(-400), e.line])
      if (e.type === 'done' || e.type === 'error') {
        setResult(e)
        setRunning(false)
        stop.current = null
        void detail.refetch()
        // Tender may now find this engine: look again.
        void api.engine.reconnect().then((s) => qc.setQueryData(keys.engine, s))
      }
    })
  }

  const plan = [!d.systemd && 'turn on systemd in /etc/wsl.conf and restart the distribution (whatever runs in it stops)', d.docker !== 'installed' && 'add Docker’s apt repository and its signing key, then install docker-ce, containerd, Buildx and Compose', d.user && d.user !== 'root' && `add ${d.user} to the docker group`, 'start Docker and keep it starting with the distribution'].filter(Boolean)

  return (
    <section aria-label={`Docker in ${name}`} className="flex flex-col gap-4 rounded-lg border border-line p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-md text-fg">{d.os}</h2>
        <p className="text-sm text-muted">
          {dockerState[d.docker]} · systemd {d.systemd ? 'on' : 'off'} · user {d.user || 'unknown'}
        </p>
      </div>
      {d.docker === 'running' && !result ? (
        <div className="flex flex-col gap-2">
          <p className="inline-flex items-center gap-2 text-base text-fg">
            <Check aria-hidden className="size-4 text-success" /> Docker Engine is already set up here.
          </p>
          <div>
            <Button onClick={() => navigate('containers')}>Open containers</Button>
          </div>
        </div>
      ) : !d.supported ? (
        <p className="text-sm text-muted">Tender can install Docker on Debian and Ubuntu (and distributions based on them). For {d.os}, follow Docker’s instructions for your distribution; Tender finds the engine once it runs.</p>
      ) : (
        !result && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg">What happens:</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {plan.map((p) => (
                <li key={p as string}>{p}</li>
              ))}
            </ul>
            <div>
              <Button variant="primary" icon={<Download />} loading={running} onClick={go}>
                Install Docker Engine in {name}
              </Button>
            </div>
          </div>
        )
      )}

      {steps.length > 0 && (
        <ul aria-label="Setup progress" className="flex flex-col gap-1 text-sm">
          {steps.map((s) => (
            <li key={s.step} className="flex items-start gap-2">
              {s.status === 'working' ? <Loader2 aria-label="working" className="mt-0.5 size-4 shrink-0 animate-spin text-muted" /> : s.status === 'done' ? <Check aria-label="done" className="mt-0.5 size-4 shrink-0 text-success" /> : <X aria-label="failed" className="mt-0.5 size-4 shrink-0 text-danger" />}
              <span className="text-fg">{stepName[s.step]}</span>
              {s.detail && <span className="min-w-0 break-all text-muted">· {s.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <pre ref={log} aria-label="Command output" tabIndex={0} className="max-h-72 overflow-auto rounded-md bg-surface p-3 font-mono text-xs whitespace-pre-wrap text-muted">
          {lines.join('\n')}
        </pre>
      )}
      {result?.type === 'error' && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">Setup stopped: {result.message}</p>}
      {result?.type === 'done' && (
        <div className="flex flex-col gap-2">
          <p role="status" className="text-base text-fg">
            {result.alreadyInstalled ? 'Docker Engine was already running.' : `Docker Engine is installed and running in ${name}.`}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => navigate('containers')}>
              Open containers
            </Button>
            <Button onClick={() => navigate('migrate')}>Move containers from Docker Desktop</Button>
          </div>
        </div>
      )}
    </section>
  )
}
