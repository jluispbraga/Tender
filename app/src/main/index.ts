import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, session, Tray, type IpcMainInvokeEvent } from 'electron'
import { Store } from './db'
import { Engine } from './engine/engine'
import { registerIpc } from './ipc'
import trayIcon from '../../resources/tray.png?asset'
import trayIcon2x from '../../resources/tray@2x.png?asset'
import appIcon from '../../resources/icon.png?asset'

// Harbor's main process: one window, one engine connection, one local store.

const devUrl = process.env.ELECTRON_RENDERER_URL
const startHidden = process.argv.includes('--hidden')

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const store = new Store(process.env.HARBOR_DB_PATH || join(app.getPath('userData'), 'harbor.db'))
const engine = new Engine()

function trusted(e: IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? ''
  return e.sender === win?.webContents && (devUrl ? url.startsWith(devUrl) : url.startsWith('file://'))
}

function createWindow() {
  const settings = store.settings()
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors)
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Harbor',
    icon: appIcon,
    // Matches the bg token so there's no white flash before the page paints.
    backgroundColor: dark ? '#16181d' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => {
    if (!startHidden && (settings.open_on_start || !settings.tray_enabled)) win?.show()
  })
  // The page never opens windows or navigates away; links to ports go through IPC.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!(devUrl ? url.startsWith(devUrl) : url.startsWith('file://'))) e.preventDefault()
  })
  win.on('close', (e) => {
    // With the tray on, closing the window keeps Harbor running (S25).
    if (!quitting && store.settings().tray_enabled) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => (win = null))
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

function showWindow(hash?: string) {
  if (!win) createWindow()
  if (hash) void win!.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`)
  win!.show()
  if (win!.isMinimized()) win!.restore()
  win!.focus()
}

// ---- tray (S25) ---------------------------------------------------------------------

function trayMenu() {
  const s = engine.getStatus()
  const label = { running: `Engine running${s.version ? ` · v${s.version}` : ''}`, starting: 'Engine starting…', stopped: 'Engine stopped', error: 'Engine unreachable' }[s.state]
  return Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open Harbor', click: () => showWindow() },
    { label: 'Containers', click: () => showWindow('#/containers') },
    { label: 'Images', click: () => showWindow('#/images') },
    { label: 'Reconnect to the engine', click: () => void engine.reconnect() },
    { type: 'separator' },
    { label: 'Settings', click: () => showWindow('#/settings/general') },
    { label: 'Quit Harbor', click: () => ((quitting = true), app.quit()) },
  ])
}

function setupTray(enabled: boolean) {
  if (!enabled) {
    tray?.destroy()
    tray = null
    return
  }
  if (tray) return
  const img = nativeImage.createFromPath(trayIcon)
  img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(trayIcon2x).toPNG() })
  tray = new Tray(img)
  tray.setToolTip('Harbor')
  tray.setContextMenu(trayMenu())
  tray.on('click', () => showWindow())
}

// ---- settings with OS side effects -----------------------------------------------------

function applyLoginItem(on: boolean) {
  // Only the packaged app registers itself; a dev build would register electron.exe.
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
}

function onSettingChanged(key: string, value: unknown) {
  if (key === 'start_on_login') applyLoginItem(value === true)
  if (key === 'tray_enabled') setupTray(value === true)
  if (key === 'theme') nativeTheme.themeSource = value as 'system' | 'light' | 'dark'
}

// ---- lifecycle ---------------------------------------------------------------------------------

app.on('second-instance', () => showWindow())

app.whenReady().then(() => {
  // No camera, mic, notifications-permission or anything else for web content.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  // CSP for the packaged renderer (the dev server's HMR needs its own websocket).
  if (!devUrl) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) =>
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'"] } }),
    )
  }

  const endpoint = engine.currentEndpoint
  store.seed({ name: endpoint.name, kind: endpoint.kind, address: endpoint.address })
  store.housekeep()
  const settings = store.settings()
  nativeTheme.themeSource = settings.theme

  registerIpc({ engine, store, onSettingChanged, isTrustedSender: trusted })
  engine.onStatus(() => tray?.setContextMenu(trayMenu()))
  engine.start()

  createWindow()
  setupTray(settings.tray_enabled)
  applyLoginItem(settings.start_on_login)

  // Dev only: HARBOR_SMOKE=<file> runs that script in the page against
  // window.harbor, prints the result between markers and quits.
  if (process.env.HARBOR_SMOKE && !app.isPackaged) {
    win!.webContents.once('did-finish-load', async () => {
      const { readFileSync } = await import('node:fs')
      let out: unknown
      try {
        out = await win!.webContents.executeJavaScript(readFileSync(process.env.HARBOR_SMOKE!, 'utf8'))
      } catch (e) {
        out = { smokeError: String(e) }
      }
      // HARBOR_SHOTS=<dir>: also capture each listed route (comma-separated hashes).
      if (process.env.HARBOR_SHOTS) {
        const { writeFileSync } = await import('node:fs')
        const [w, h] = (process.env.HARBOR_SHOT_SIZE ?? '1280x800').split('x').map(Number)
        win!.setContentSize(w, h)
        for (const [i, hash] of (process.env.HARBOR_SHOT_ROUTES ?? '#/containers').split(',').entries()) {
          await win!.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`)
          await new Promise((r) => setTimeout(r, 3500))
          writeFileSync(join(process.env.HARBOR_SHOTS, `${String(i).padStart(2, '0')}-${hash.replace(/[^a-z0-9]+/gi, '_')}.png`), (await win!.webContents.capturePage()).toPNG())
        }
      }
      process.stdout.write(`\n@@SMOKE@@${JSON.stringify(out)}@@END@@\n`)
      quitting = true
      app.exit(0)
    })
  }
})

app.on('before-quit', () => {
  quitting = true
  engine.stop()
})

app.on('window-all-closed', () => {
  if (!store.settings().tray_enabled) app.quit()
})
