import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Play, RotateCw, SquareTerminal } from 'lucide-react'
import { api, type ContainerRow, type ExecSession } from '@/api'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { useSettings } from '@/lib/queries'

type Phase = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; code: number } | { kind: 'error'; message: string }

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--ds-${name}`).trim()

/** S06: an interactive shell inside the container. */
export function ExecTab({ c }: { c: ContainerRow }) {
  const settings = useSettings()
  const host = useRef<HTMLDivElement>(null)
  const [shell, setShell] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const chosen = shell ?? settings.data?.exec_default_shell ?? '/bin/sh'
  const running = c.state === 'running'

  useEffect(() => {
    if (!running || !host.current) return
    const term = new Terminal({
      fontFamily: css('font-mono'),
      fontSize: 13,
      cursorBlink: true,
      screenReaderMode: true,
      theme: { background: css('term-bg'), foreground: css('term-text'), cursor: css('focus'), selectionBackground: css('selected') },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
    let session: ExecSession | undefined
    let disposed = false
    setPhase({ kind: 'connecting' })
    api.exec
      .open(c.id, { shell: chosen, cols: term.cols, rows: term.rows }, (d) => term.write(d), (code) => setPhase({ kind: 'closed', code }))
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
      // xterm schedules a viewport sync on open(); disposing synchronously
      // (e.g. StrictMode's double effect, or a quick tab switch) makes that
      // timer throw. Let it run first.
      setTimeout(() => term.dispose(), 0)
    }
  }, [c.id, running, chosen, attempt])

  if (!running) {
    return (
      <div className="flex flex-col items-start gap-3 p-5">
        <p className="text-base text-muted">{c.name} isn’t running, so there’s nothing to open a shell in.</p>
        <Button variant="primary" icon={<Play />} onClick={() => void api.containers.action([c.id], 'start')}>
          Start container
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2 text-sm">
        <SquareTerminal aria-hidden className="size-4 text-muted" />
        <Select
          label="Shell"
          value={chosen}
          onValueChange={setShell}
          className="w-52"
          options={[
            { value: '/bin/sh', label: '/bin/sh' },
            { value: '/bin/bash', label: '/bin/bash' },
            { value: 'cmd.exe', label: 'cmd.exe' },
            { value: 'debug', label: 'Debug shell (BusyBox)' },
          ]}
        />
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
          // xterm captures Tab; give keyboard users a way out.
          if (e.key === 'Tab' && e.ctrlKey && e.shiftKey) {
            e.preventDefault()
            ;(document.querySelector('[role="tab"][data-state="active"]') as HTMLElement | null)?.focus()
          }
        }}
      >
        <div ref={host} className="h-full" aria-label={`Terminal in ${c.name}`} />
      </div>
    </div>
  )
}
