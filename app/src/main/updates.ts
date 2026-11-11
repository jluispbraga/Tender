import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../renderer/src/api/types'

// Updates from the project's GitHub Releases. The Windows installer and the
// AppImage can replace themselves; the portable .exe and the .deb cannot, so
// they only link to the release page. Updates download in the background and
// install when Tender quits, or right away when the user asks.

const { autoUpdater } = electronUpdater
const RELEASES = 'https://github.com/jluispbraga/Tender/releases'
const EVERY = 6 * 60 * 60 * 1000

/** Whether this copy of Tender can update itself. */
function canUpdate(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR
  if (process.platform === 'linux') return !!process.env.APPIMAGE
  return false
}

let status: UpdateStatus = { supported: false, current: app.getVersion(), state: 'idle', releases: RELEASES }
let timer: NodeJS.Timeout | undefined
let wired = false

const set = (s: Partial<UpdateStatus>) => (status = { ...status, ...s })

function wire() {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: undefined }))
  autoUpdater.on('update-not-available', () => set({ state: 'none', version: undefined, checkedAt: new Date().toISOString() }))
  autoUpdater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0, checkedAt: new Date().toISOString() }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version, percent: 100 }))
  autoUpdater.on('error', (e) => set({ state: 'error', error: friendly(e), checkedAt: new Date().toISOString() }))
}

function friendly(e: unknown): string {
  const m = String((e as Error)?.message ?? e)
  if (/latest(-linux)?\.yml/.test(m) && /404|Cannot find/i.test(m)) return 'The latest release has no update information yet.'
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|net::/i.test(m)) return 'Could not reach GitHub. Check your connection.'
  return m.split('\n')[0]
}

/** Starts (or stops) the background checks: one shortly after start, then every 6 hours. */
export function startUpdates(enabled: boolean) {
  clearInterval(timer)
  timer = undefined
  set({ supported: canUpdate() })
  if (!status.supported) return
  if (!enabled) {
    if (status.state !== 'ready') set({ state: 'off' })
    return
  }
  wire()
  if (status.state === 'off') set({ state: 'idle' })
  setTimeout(() => void check(), 15_000)
  timer = setInterval(() => void check(), EVERY)
}

export function updateStatus(): UpdateStatus {
  return status
}

export async function check(): Promise<UpdateStatus> {
  if (!status.supported) return status
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return status
  wire()
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set({ state: 'error', error: friendly(e), checkedAt: new Date().toISOString() })
  }
  return status
}

/** Quits and runs the downloaded installer, which starts Tender again. */
export function installNow(beforeQuit: () => void) {
  if (status.state !== 'ready') throw new Error('No update has been downloaded yet.')
  beforeQuit()
  autoUpdater.quitAndInstall(true, true)
}
