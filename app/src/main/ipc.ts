import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { ApiError } from '../renderer/src/api/types'
import type { Store } from './db'
import { toApiError, type Engine } from './engine/engine'
import * as migrate from './migrate/migrate'
import { openTerminal } from './engine/wsl'

// The IPC surface from architecture.md ("API"). Three channels:
//   tender:call   (route, args)         -> { ok, value } | { ok: false, error }
//   tender:sub    (subId, kind, args)   -> starts a stream, pushed on tender:push
//   tender:unsub  (subId)
// plus tender:exec for terminal input. Every input is validated with zod.

const id = z.string().min(1).max(200)
const ids = z.array(id).min(1).max(500)
// WSL distribution names: letters, digits, dot, dash, underscore (they end up on a command line).
const distro = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'Not a WSL distribution name.')
const action = z.enum(['start', 'stop', 'restart', 'pause', 'unpause'])
const portNum = z.string().regex(/^\d{1,5}$/).refine((s) => +s > 0 && +s < 65536)

const settingValue = {
  theme: z.enum(['system', 'light', 'dark']),
  start_on_login: z.boolean(),
  open_on_start: z.boolean(),
  only_running: z.boolean(),
  exec_default_shell: z.enum(['/bin/sh', '/bin/bash', 'cmd.exe']),
  log_tail_lines: z.number().int().min(50).max(5000),
  tray_enabled: z.boolean(),
} as const

export interface IpcDeps {
  engine: Engine
  store: Store
  /** Window and OS side effects that live in index.ts. */
  onSettingChanged: (key: string, value: unknown) => void
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean
}

type Route = { args: z.ZodType; run: (args: any) => unknown }

export function registerIpc(deps: IpcDeps) {
  const { engine, store } = deps
  const pulls = new Map<string, () => void>()

  const routes: Record<string, Route> = {
    'engine.status': { args: z.tuple([]), run: () => ({ ...engine.getStatus() }) },
    'engine.reconnect': { args: z.tuple([]), run: () => engine.reconnect() },

    'migrate.check': { args: z.tuple([]), run: () => migrate.check() },
    'migrate.plan': { args: z.tuple([distro]), run: ([d]) => migrate.plan(d) },
    'migrate.fixSocket': { args: z.tuple([distro]), run: ([d]) => openTerminal(d, ['sudo', 'systemctl', 'restart', 'docker.socket', 'docker']) },

    'containers.list': { args: z.tuple([]), run: () => engine.listContainers() },
    'containers.inspect': { args: z.tuple([id]), run: ([i]) => engine.inspectContainer(i) },
    'containers.action': { args: z.tuple([ids, action]), run: ([i, a]) => engine.containerAction(i, a) },
    'containers.remove': { args: z.tuple([ids, z.boolean().optional()]), run: ([i, f]) => engine.removeContainers(i, f) },
    'containers.runCommand': { args: z.tuple([id]), run: ([i]) => engine.runCommand(i) },
    'containers.openPort': {
      // Only http://localhost:<published tcp port>. Nothing else reaches the OS shell.
      args: z.tuple([z.object({ publicPort: z.number().int().min(1).max(65535), protocol: z.literal('tcp') }).passthrough()]),
      run: ([p]) => shell.openExternal(`http://localhost:${p.publicPort}`),
    },

    'compose.action': { args: z.tuple([id, action]), run: ([p, a]) => engine.composeAction(p, a) },
    'compose.remove': { args: z.tuple([id]), run: ([p]) => engine.composeRemove(p) },

    'images.list': { args: z.tuple([]), run: () => engine.listImages() },
    'images.inspect': { args: z.tuple([id]), run: ([i]) => engine.inspectImage(i) },
    'images.diskUsage': { args: z.tuple([]), run: () => engine.diskUsage() },
    'images.cancelPull': { args: z.tuple([id]), run: ([p]) => void pulls.get(p)?.() },
    'images.remove': { args: z.tuple([ids, z.boolean().optional()]), run: ([i, f]) => engine.removeImages(i, f) },
    'images.prune': { args: z.tuple([z.enum(['dangling', 'unused'])]), run: ([s]) => engine.pruneImages(s) },
    'images.run': {
      args: z.tuple([
        z.object({
          image: z.string().min(1).max(512),
          name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'Names can use letters, digits, dots, dashes and underscores.').max(128).optional(),
          ports: z.array(z.object({ host: portNum, container: portNum })).max(50),
          volumes: z.array(z.object({ source: z.string().min(1).max(1024), target: z.string().startsWith('/').max(1024) })).max(50),
          env: z.array(z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(32_768) })).max(200),
        }),
      ]),
      run: ([s]) => engine.run(s),
    },

    'volumes.list': { args: z.tuple([]), run: () => engine.listVolumes() },
    'volumes.create': {
      args: z.tuple([z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Use at least two characters: letters, digits, dots, dashes or underscores, starting with a letter or digit.').max(255)]),
      run: ([n]) => engine.createVolume(n),
    },
    'volumes.remove': { args: z.tuple([ids]), run: ([n]) => engine.removeVolumes(n) },
    'volumes.usage': { args: z.tuple([id]), run: ([n]) => engine.volumeUsage(n) },

    'settings.get': { args: z.tuple([]), run: () => store.settings() },
    'settings.set': {
      args: z.tuple([z.enum(Object.keys(settingValue) as [keyof typeof settingValue]), z.unknown()]),
      run: ([key, value]) => {
        const parsed = settingValue[key as keyof typeof settingValue].parse(value)
        store.setSetting(key, parsed as never)
        deps.onSettingChanged(key, parsed)
      },
    },
    'grid.get': { args: z.tuple([z.enum(['containers', 'images', 'volumes'])]), run: ([v]) => store.grid(v) },
    'grid.set': {
      args: z.tuple([z.enum(['containers', 'images', 'volumes']), z.object({ hidden: z.array(z.string().max(40)).max(20) })]),
      run: ([v, p]) => store.setGrid(v, p),
    },
    'notifications.list': { args: z.tuple([]), run: () => store.notifications() },
    'notifications.markRead': { args: z.tuple([z.array(id).max(500)]), run: ([i]) => store.markRead(i) },
    'search.recent': { args: z.tuple([]), run: () => store.recent() },
    'search.recordUse': {
      args: z.tuple([z.object({ type: z.enum(['container', 'image', 'volume']), id, label: z.string().max(300) })]),
      run: ([item]) => store.recordUse(item),
    },
  }

  ipcMain.handle('tender:call', async (e, route: unknown, args: unknown) => {
    if (!deps.isTrustedSender(e)) return { ok: false, error: { message: 'Untrusted sender' } }
    const r = typeof route === 'string' ? routes[route] : undefined
    if (!r) return { ok: false, error: { message: `Unknown route ${String(route)}` } }
    const parsed = r.args.safeParse(args)
    if (!parsed.success) return { ok: false, error: { message: parsed.error.issues.map((i) => i.message).join('; '), status: 400 } }
    try {
      return { ok: true, value: await r.run(parsed.data) }
    } catch (err) {
      const a = err instanceof z.ZodError ? new ApiError(err.issues.map((i) => i.message).join('; '), 400) : toApiError(err)
      return { ok: false, error: { message: a.message, status: a.status } }
    }
  })

  // ---- streams ------------------------------------------------------------------------

  const subs = new Map<string, { wc: WebContents; stop: () => void; exec?: { write(d: string): void; resize(c: number, r: number): void; close(): void } }>()
  const push = (wc: WebContents, subId: string, payload: unknown) => {
    if (!wc.isDestroyed()) wc.send('tender:push', subId, payload)
  }
  const stopAll = (wc: WebContents) => {
    for (const [k, s] of subs) if (s.wc === wc) (s.stop(), subs.delete(k))
  }

  const subArgs = {
    status: z.tuple([]),
    events: z.tuple([]),
    notifications: z.tuple([]),
    logs: z.tuple([id, z.number().int().min(0).max(5000)]),
    stats: z.tuple([z.array(id).max(500)]),
    exec: z.tuple([id, z.enum(['/bin/sh', '/bin/bash', 'cmd.exe']), z.number().int().min(10).max(1000), z.number().int().min(4).max(500)]),
    migrate: z.tuple([distro, z.array(z.string().max(300)).max(2000), z.object({ start: z.boolean() })]),
    pull: z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]{0,255}$/i, 'That isn’t a valid image reference.')]),
  }

  ipcMain.handle('tender:sub', async (e, subId: unknown, kind: unknown, args: unknown) => {
    if (!deps.isTrustedSender(e)) return { ok: false, error: { message: 'Untrusted sender' } }
    if (typeof subId !== 'string' || subId.length > 64 || subs.has(subId) || typeof kind !== 'string' || !(kind in subArgs)) return { ok: false, error: { message: 'Bad subscription' } }
    const parsed = subArgs[kind as keyof typeof subArgs].safeParse(args)
    if (!parsed.success) return { ok: false, error: { message: parsed.error.issues.map((i) => i.message).join('; '), status: 400 } }
    const a = parsed.data as any[]
    const wc = e.sender
    if (!wc.listenerCount('destroyed') || !(wc as unknown as { __tender?: boolean }).__tender) {
      ;(wc as unknown as { __tender?: boolean }).__tender = true
      wc.on('destroyed', () => stopAll(wc))
      // A reload starts a fresh renderer: drop the old one's streams.
      wc.on('did-start-navigation', (_ev, _url, _inPlace, isMainFrame) => isMainFrame && stopAll(wc))
    }
    const to = (payload: unknown) => push(wc, subId, payload)
    try {
      let stop: () => void
      let exec: { write(d: string): void; resize(c: number, r: number): void; close(): void } | undefined
      switch (kind) {
        case 'status':
          stop = engine.onStatus((s) => to(s))
          break
        case 'events':
          stop = engine.onEvents((ev) => to(ev))
          break
        case 'notifications':
          stop = onNotification((n) => to(n))
          break
        case 'logs':
          stop = engine.subscribeLogs(a[0], a[1], (lines) => to(lines))
          break
        case 'stats':
          stop = engine.subscribeStats(a[0], (samples) => to(samples))
          break
        case 'exec': {
          exec = await engine.openExec(a[0], a[1], a[2], a[3], (d) => to({ type: 'data', data: d }), (code) => to({ type: 'exit', code }))
          stop = () => exec!.close()
          break
        }
        case 'pull': {
          const reference: string = a[0]
          const historyId = store.startPull(reference)
          if (!historyId) return { ok: false, error: { message: `${reference} is already being pulled.`, status: 409 } }
          const p = engine.pull(reference, (layers) => to({ type: 'progress', layers }))
          pulls.set(subId, p.cancel)
          stop = p.cancel
          p.done.then(
            () => {
              store.finishPull(historyId, 'done')
              notify({ kind: 'success', title: `Pulled ${reference}` })
              to({ type: 'done' })
            },
            (err) => {
              const ae = toApiError(err)
              store.finishPull(historyId, ae.status === 499 ? 'cancelled' : 'failed', ae.message)
              to({ type: 'error', message: ae.message, status: ae.status })
            },
          ).finally(() => {
            pulls.delete(subId)
            subs.delete(subId)
          })
          break
        }
        case 'migrate':
          stop = migrate.run(a[0], a[1], a[2], (ev) => to(ev))
          break
        default:
          return { ok: false, error: { message: 'Bad subscription' } }
      }
      subs.set(subId, { wc, stop, exec })
      return { ok: true }
    } catch (err) {
      const ae = toApiError(err)
      return { ok: false, error: { message: ae.message, status: ae.status } }
    }
  })

  ipcMain.handle('tender:unsub', (e, subId: unknown) => {
    if (!deps.isTrustedSender(e) || typeof subId !== 'string') return
    subs.get(subId)?.stop()
    subs.delete(subId)
  })

  ipcMain.on('tender:exec', (e, subId: unknown, op: unknown, a: unknown, b: unknown) => {
    if (!deps.isTrustedSender(e as unknown as IpcMainInvokeEvent) || typeof subId !== 'string') return
    const s = subs.get(subId)?.exec
    if (!s) return
    if (op === 'write' && typeof a === 'string' && a.length <= 65_536) s.write(a)
    if (op === 'resize' && Number.isInteger(a) && Number.isInteger(b)) s.resize(a as number, b as number)
  })

  // ---- notifications from the engine and from pulls ----------------------------------------

  const notifListeners = new Set<(n: unknown) => void>()
  function onNotification(fn: (n: unknown) => void) {
    notifListeners.add(fn)
    return () => void notifListeners.delete(fn)
  }
  function notify(n: { kind: 'info' | 'success' | 'error'; title: string; body?: string; objectType?: string; objectId?: string }) {
    const row = store.addNotification(n)
    notifListeners.forEach((fn) => fn(row))
    return row
  }
  engine.onUnexpectedExit(({ id: cid, name, exitCode }) => notify({ kind: 'error', title: `${name} stopped with exit code ${exitCode}`, objectType: 'container', objectId: cid }))

  return { notify }
}
