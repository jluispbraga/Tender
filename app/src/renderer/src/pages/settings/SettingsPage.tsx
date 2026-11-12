import { useState, type ReactNode } from 'react'
import { PageHeader } from '@/app/AppShell'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { setSetting, useEngine, useSettings } from '@/lib/queries'
import { href } from '@/lib/router'
import { cn } from '@/lib/cn'
import { api, type Settings } from '@/api'
import { WindowsTools } from './WindowsTools'
import { Updates } from './Updates'
import { KubeSources } from './KubeSources'

const sections = [
  { key: 'general', label: 'General' },
  { key: 'engine', label: 'Engine' },
]

/** S21 (General) and S22 (Engine). Changes apply immediately; there is no Apply button. */
export function SettingsPage({ section }: { section: string }) {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-line p-2">
          {sections.map((s) => (
            <a
              key={s.key}
              href={href('settings', s.key)}
              aria-current={section === s.key ? 'page' : undefined}
              className={cn('flex h-8 items-center rounded-md px-2.5 text-base text-muted hover:bg-hover hover:text-fg', section === s.key && 'bg-selected font-medium text-fg hover:bg-selected')}
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto p-6">{section === 'engine' ? <EngineSection /> : <GeneralSection />}</div>
      </div>
    </>
  )
}

function GeneralSection() {
  const settings = useSettings()
  const toast = useToast()
  const s = settings.data
  const [tail, setTail] = useState<string | null>(null)
  if (!s) return <p role="status" className="text-base text-muted">Loading settings…</p>

  const save = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    try {
      await setSetting(key, value)
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t save that setting', body: (e as Error).message })
    }
  }

  const tailValue = tail ?? String(s.log_tail_lines)
  const tailNum = Number(tailValue)
  const tailError = tail !== null && (!Number.isInteger(tailNum) || tailNum < 50 || tailNum > 5000) ? 'Pick a whole number from 50 to 5,000.' : undefined

  return (
    <div className="flex max-w-xl flex-col gap-8">
      <Group title="Appearance">
        <Field label="Theme" description="System follows your computer’s light or dark mode.">
          <Select
            label="Theme"
            value={s.theme}
            onValueChange={(v) => void save('theme', v as Settings['theme'])}
            className="w-44 shrink-0"
            options={[
              { value: 'system', label: 'Same as system' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Field>
      </Group>
      {api.platform === 'win32' && (
        <Group title="Docker on Windows">
          <WindowsTools settings={s} save={save} />
        </Group>
      )}
      {api.platform === 'win32' && (
        <Group title="Docker Desktop">
          <p className="text-sm text-muted">
            Containers, images and volumes made with Docker Desktop stay inside it. Tender can copy them into the Docker Engine inside WSL, so you can stop using Docker Desktop.{' '}
            <a href={href('migrate')} className="text-link underline underline-offset-2">
              Move from Docker Desktop
            </a>
          </p>
        </Group>
      )}
      <Group title="Startup">
        <Switch label="Start Tender when I sign in" checked={s.start_on_login} onCheckedChange={(v) => void save('start_on_login', v)} />
        <Switch label="Open the window when Tender starts" checked={s.open_on_start} onCheckedChange={(v) => void save('open_on_start', v)} />
        <Switch label={`Keep running in the ${api.platform === 'darwin' ? 'menu bar' : api.platform === 'win32' ? 'notification area' : 'system tray'} when the window is closed`} checked={s.tray_enabled} onCheckedChange={(v) => void save('tray_enabled', v)} />
      </Group>
      <Group title="Updates">
        <Updates settings={s} save={save} />
      </Group>
      <Group title="Kubernetes">
        <KubeSources settings={s} save={save} />
      </Group>
      <Group title="Containers">
        <Field label="Default shell" description="Used when you open a terminal in a container. You can switch per session.">
          <Select
            label="Default shell"
            value={s.exec_default_shell}
            onValueChange={(v) => void save('exec_default_shell', v)}
            className="w-40"
            options={[
              { value: '/bin/sh', label: '/bin/sh' },
              { value: '/bin/bash', label: '/bin/bash' },
              { value: 'cmd.exe', label: 'cmd.exe' },
            ]}
          />
        </Field>
        <div className="w-56">
          <Input
            label="Log lines to load"
            type="number"
            inputMode="numeric"
            min={50}
            max={5000}
            value={tailValue}
            hint="How much history to show when you open a container’s logs."
            error={tailError}
            onChange={(e) => setTail(e.target.value)}
            onBlur={() => {
              if (tail !== null && !tailError) {
                void save('log_tail_lines', tailNum)
                setTail(null)
              }
            }}
          />
        </div>
      </Group>
      <p className="text-sm text-muted" role="note">
        Changes are saved as you make them.
      </p>
    </div>
  )
}

function EngineSection() {
  const engine = useEngine()
  const e = engine.data
  return (
    <div className="flex max-w-xl flex-col gap-8">
      <Group title="Connection">
        <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Endpoint</dt>
          <dd className="font-mono text-xs">{e?.endpoint ?? '—'}</dd>
          <dt className="text-muted">Status</dt>
          <dd>{e?.state ?? '—'}</dd>
          <dt className="text-muted">Engine version</dt>
          <dd>{e?.version ? `${e.version} (API ${e.apiVersion})` : '—'}</dd>
          <dt className="text-muted">Operating system</dt>
          <dd>{e?.os ?? '—'}</dd>
          <dt className="text-muted">CPUs / memory</dt>
          <dd>{e?.ncpu ? `${e.ncpu} CPUs · ${((e.memTotal ?? 0) / 1e9).toFixed(1)} GB` : '—'}</dd>
        </dl>
      </Group>
      <p className="text-sm text-muted">
        Tender uses an engine you already run. Connecting to other engines and editing the engine’s configuration file are planned for a later milestone.
      </p>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <h2 className="text-md text-fg">{title}</h2>
      {children}
    </section>
  )
}

function Field({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-0.5">
        <span className="text-base font-medium text-fg">{label}</span>
        <span className="text-sm text-muted">{description}</span>
      </div>
      {children}
    </div>
  )
}
