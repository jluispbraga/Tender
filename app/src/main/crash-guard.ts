import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// An error nobody caught in the main process used to end in Electron's raw
// "A JavaScript error occurred in the main process" box, and could leave the
// app half-working. These handlers keep Tender up, write the error to a log
// file, and tell the user once in the notification center instead.

type Notify = (n: { kind: 'error'; title: string; body?: string }) => void

let notify: Notify | null = null
const pending: { title: string; body: string }[] = []
let logFile: string | null = null
let lastShown = 0
let shownRecently = 0

/** Errors that only mean "a request was cancelled" (closing a log panel, leaving a page). */
export function harmless(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string }
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.code === 'ECONNRESET' || /operation was aborted/i.test(err?.message ?? '')
}

function write(kind: string, e: unknown) {
  const text = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e)
  console.error(`[tender] ${kind}:`, text)
  if (!logFile) return
  try {
    // One small file, with one older copy kept: enough to send with a bug report.
    if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 512_000) renameSync(logFile, `${logFile}.1`)
    appendFileSync(logFile, `${new Date().toISOString()} ${kind} ${text}\n`)
  } catch {
    // Logging must never be the thing that fails.
  }
}

function report(kind: string, e: unknown) {
  write(kind, e)
  if (harmless(e)) return
  const now = Date.now()
  // At most three notices a minute, so a loop of errors does not flood the list.
  if (now - lastShown > 60_000) shownRecently = 0
  if (shownRecently >= 3) return
  shownRecently++
  lastShown = now
  const n = { title: 'Something went wrong inside Tender', body: `${e instanceof Error ? e.message : String(e)}. Tender kept running; details are in ${logFile ?? 'the log'}.` }
  if (notify) notify({ kind: 'error', ...n })
  else pending.push(n)
}

/** Installs the handlers. Call first thing in the main process. */
export function guardMainProcess(logDir: string) {
  try {
    mkdirSync(logDir, { recursive: true })
    logFile = join(logDir, 'main.log')
  } catch {
    logFile = null
  }
  process.on('uncaughtException', (e) => report('uncaughtException', e))
  process.on('unhandledRejection', (e) => report('unhandledRejection', e))
}

/** Hooks the notification center up once IPC exists; errors from before then show now. */
export function setCrashNotify(fn: Notify) {
  notify = fn
  for (const n of pending.splice(0)) fn({ kind: 'error', ...n })
}
