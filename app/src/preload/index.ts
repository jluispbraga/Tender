import { contextBridge, ipcRenderer } from 'electron'
import type { TenderApi, LayerProgress } from '../renderer/src/api/types'

// window.tender: the real implementation of TenderApi, over IPC. The renderer
// gets these functions and nothing else; no Node, no ipcRenderer.

// contextBridge copies Error objects without their extra fields, so failures
// cross as plain { name, message, status } objects; screens read .message
// and .status from them the same way.
const apiError = (message: string, status?: number) => ({ name: 'ApiError', message, status })

type Envelope<T> = { ok: true; value: T } | { ok: false; error: { message: string; status?: number } }

async function call<T>(route: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke('tender:call', route, args)) as Envelope<T>
  if (!r.ok) throw apiError(r.error.message, r.error.status)
  return r.value
}

const handlers = new Map<string, (payload: any) => void>()
ipcRenderer.on('tender:push', (_e, subId: string, payload: unknown) => handlers.get(subId)?.(payload))

let n = 0
const newId = () => `${Date.now().toString(36)}-${(n++).toString(36)}`

/** Starts a main-process stream; returns a function that stops it. */
function subscribe(kind: string, args: unknown[], onPayload: (p: any) => void): { id: string; ready: Promise<void>; stop: () => void } {
  const id = newId()
  handlers.set(id, onPayload)
  const ready = (ipcRenderer.invoke('tender:sub', id, kind, args) as Promise<Envelope<void>>).then((r) => {
    if (!r.ok) {
      handlers.delete(id)
      throw apiError(r.error.message, r.error.status)
    }
  })
  return {
    id,
    ready,
    stop: () => {
      handlers.delete(id)
      void ipcRenderer.invoke('tender:unsub', id)
    },
  }
}

/** For fire-and-forget streams the renderer can't await: log the failure, don't crash. */
const quiet = (s: { ready: Promise<void>; stop: () => void }) => {
  s.ready.catch((e) => console.warn('[tender] subscription failed:', e.message))
  return s.stop
}

const tender: TenderApi = {
  kind: 'ipc',
  platform: process.platform,
  migrate: {
    check: () => call('migrate.check'),
    plan: (distro) => call('migrate.plan', distro),
    run: (distro, ids, opts, onEvent) => quiet(subscribe('migrate', [distro, ids, opts], onEvent)),
    fixSocket: (distro) => call('migrate.fixSocket', distro),
  },
  engine: {
    status: () => call('engine.status'),
    reconnect: () => call('engine.reconnect'),
    onStatus: (cb) => quiet(subscribe('status', [], cb)),
    onEvents: (cb) => quiet(subscribe('events', [], cb)),
  },
  containers: {
    list: () => call('containers.list'),
    inspect: (id) => call('containers.inspect', id),
    action: (ids, action) => call('containers.action', ids, action),
    remove: (ids, force) => call('containers.remove', ids, force),
    runCommand: (id) => call('containers.runCommand', id),
    openPort: (p) => call('containers.openPort', p),
  },
  logs: {
    subscribe: (id, { tail }, cb) => {
      const s = subscribe('logs', [id, tail], cb)
      s.ready.catch((e) => cb([{ ts: new Date().toISOString(), stream: 'stderr', text: e.message }]))
      return s.stop
    },
  },
  stats: { subscribe: (ids, cb) => quiet(subscribe('stats', [ids], cb)) },
  exec: {
    open: async (id, { shell, cols, rows }, onData, onExit) => {
      const s = subscribe('exec', [id, shell, cols, rows], (p: { type: 'data'; data: string } | { type: 'exit'; code: number }) => (p.type === 'data' ? onData(p.data) : onExit(p.code)))
      await s.ready
      return {
        write: (data) => ipcRenderer.send('tender:exec', s.id, 'write', data),
        resize: (c, r) => ipcRenderer.send('tender:exec', s.id, 'resize', c, r),
        close: s.stop,
      }
    },
  },
  compose: {
    action: (project, action) => call('compose.action', project, action),
    remove: (project) => call('compose.remove', project),
  },
  images: {
    list: () => call('images.list'),
    inspect: (id) => call('images.inspect', id),
    diskUsage: () => call('images.diskUsage'),
    pull: (reference, onProgress) => {
      let settle: { resolve: () => void; reject: (e: unknown) => void }
      const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
      const s = subscribe('pull', [reference], (p: { type: 'progress'; layers: LayerProgress[] } | { type: 'done' } | { type: 'error'; message: string; status?: number }) => {
        if (p.type === 'progress') onProgress(p.layers)
        else if (p.type === 'done') (handlers.delete(s.id), settle.resolve())
        else (handlers.delete(s.id), settle.reject(apiError(p.message, p.status)))
      })
      s.ready.catch((e) => settle.reject(e))
      return { pullId: s.id, done }
    },
    cancelPull: (pullId) => call('images.cancelPull', pullId),
    remove: (ids, force) => call('images.remove', ids, force),
    prune: (scope) => call('images.prune', scope),
    run: (spec) => call('images.run', spec),
  },
  volumes: {
    list: () => call('volumes.list'),
    create: (name) => call('volumes.create', name),
    remove: (names) => call('volumes.remove', names),
    usage: (name) => call('volumes.usage', name),
  },
  settings: {
    get: () => call('settings.get'),
    set: (key, value) => call('settings.set', key, value),
  },
  grid: {
    get: (view) => call('grid.get', view),
    set: (view, prefs) => call('grid.set', view, prefs),
  },
  notifications: {
    list: () => call('notifications.list'),
    markRead: (ids) => call('notifications.markRead', ids),
    onNew: (cb) => quiet(subscribe('notifications', [], cb)),
  },
  search: {
    recent: () => call('search.recent'),
    recordUse: (item) => call('search.recordUse', item),
  },
}

contextBridge.exposeInMainWorld('tender', tender)
