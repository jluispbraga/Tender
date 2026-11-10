import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, Download, Loader2, X } from 'lucide-react'
import { api, type Settings, type ToolInstallEvent } from '@/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { href } from '@/lib/router'

const stepName = { cli: 'Docker CLI', compose: 'Docker Compose', buildx: 'Buildx', path: 'Add to your PATH' } as const

/**
 * Windows: what Docker tools outside Tender need once Docker Desktop is gone.
 * The standard pipe (served from the engine in WSL) and the official CLI.
 */
export function WindowsTools({ settings, save }: { settings: Settings; save: <K extends keyof Settings>(k: K, v: Settings[K]) => Promise<void> }) {
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api.tools.status(), refetchInterval: 5000 })
  const t = tools.data
  const [steps, setSteps] = useState<Extract<ToolInstallEvent, { type: 'step' }>[]>([])
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)

  const install = () => {
    setSteps([])
    setError(null)
    setInstalling(true)
    api.tools.installCli((e) => {
      if (e.type === 'step') setSteps((ss) => [...ss.filter((s) => s.step !== e.step), e])
      if (e.type === 'error') setError(e.message)
      if (e.type === 'done' || e.type === 'error') {
        setInstalling(false)
        void tools.refetch()
      }
    })
  }

  const pipeText = !t
    ? 'Checking…'
    : t.pipe.state === 'serving'
      ? `Serving //./pipe/docker_engine from Docker in ${t.pipe.distro}, while Tender runs.`
      : t.pipe.state === 'taken'
        ? 'Another program serves //./pipe/docker_engine (usually Docker Desktop), so Tender leaves it alone.'
        : t.pipe.state === 'waiting'
          ? 'Starts once Tender is connected to Docker in WSL.'
          : 'Off.'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Switch label="Let Docker tools on Windows use this engine" checked={settings.share_docker_pipe} onCheckedChange={(v) => void save('share_docker_pipe', v)} />
        <p className="text-sm text-muted">
          docker.exe, the VS Code Docker extension, Testcontainers and IDEs look for Docker at <code className="font-mono text-xs text-fg">//./pipe/docker_engine</code>. Tender answers there with the engine in WSL. {pipeText} Keep Tender in the notification area (and start it at sign-in) so the pipe is always there.
        </p>
      </div>

      <p className="text-sm text-muted">
        No engine in WSL yet?{' '}
        <a href={href('setup')} className="text-link underline underline-offset-2">
          Set up Docker in WSL
        </a>
      </p>

      <div className="flex flex-col gap-2">
        <p className="text-base text-fg">Docker CLI</p>
        {!t ? (
          <p role="status" className="inline-flex items-center gap-2 text-sm text-muted">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Looking for docker.exe…
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            <Line ok={!!t.cli} text={t.cli ? `docker ${t.cli.version}${t.cli.own ? ', installed by Tender' : ''} (${t.cli.path})` : 'docker.exe not found'} />
            <Line ok={!!t.compose} text={t.compose ? `Compose ${t.compose}` : 'Compose not found'} />
            <Line ok={!!t.buildx} text={t.buildx ? `Buildx ${t.buildx}` : 'Buildx not found'} />
          </ul>
        )}
        {t && (!t.cli || !t.compose || !t.buildx) && (
          <p className="text-sm text-muted">Tender can install the official builds for your user: the Docker CLI from download.docker.com, Compose and Buildx from their GitHub releases (checked against their published SHA-256). No admin rights needed.</p>
        )}
        <div>
          <Button icon={<Download />} loading={installing} onClick={install}>
            {t?.cli?.own ? 'Update the Docker CLI' : 'Install the Docker CLI'}
          </Button>
        </div>
        {steps.length > 0 && (
          <ul aria-label="Install progress" className="flex flex-col gap-1 text-sm">
            {steps.map((s) => (
              <li key={s.step} className="flex items-start gap-2">
                {s.status === 'working' ? <Loader2 aria-label="working" className="mt-0.5 size-4 animate-spin text-muted" /> : s.status === 'done' ? <Check aria-label="done" className="mt-0.5 size-4 text-success" /> : <X aria-label="failed" className="mt-0.5 size-4 text-danger" />}
                <span className="text-fg">{stepName[s.step]}</span>
                {s.detail && <span className="min-w-0 break-all text-muted">· {s.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        {steps.some((s) => s.step === 'path' && s.status === 'done') && <p role="status" className="text-sm text-muted">Open a new terminal to use docker.</p>}
      </div>

      {t?.cli && !t.contextUsesPipe && (
        <div className="flex flex-col gap-2 rounded-md bg-warning-bg px-3 py-2 text-sm">
          <p className="inline-flex items-start gap-2 text-fg">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            The Docker CLI uses the context “{t.context}”, so docker.exe does not talk to this engine. Docker Desktop leaves its context behind.
          </p>
          <div>
            <Button
              size="sm"
              loading={switching}
              onClick={async () => {
                setSwitching(true)
                try {
                  await api.tools.useDefaultContext()
                } catch (e) {
                  setError((e as Error).message)
                } finally {
                  setSwitching(false)
                  void tools.refetch()
                }
              }}
            >
              Switch to the default context
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Line({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? <Check aria-label="found" className="mt-0.5 size-4 shrink-0 text-success" /> : <X aria-label="missing" className="mt-0.5 size-4 shrink-0 text-muted" />}
      <span className="min-w-0 break-all text-muted">{text}</span>
    </li>
  )
}
