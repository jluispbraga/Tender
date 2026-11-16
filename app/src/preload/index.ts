import { contextBridge, ipcRenderer } from 'electron'
import type { TenderApi, LayerProgress, BuildEvent, ScanPhase, ScanResult } from '../renderer/src/api/types'

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
  updates: {
    status: () => call('updates.status'),
    check: () => call('updates.check'),
    install: () => call('updates.install'),
    openReleases: () => call('updates.openReleases'),
  },
  kube: {
    contexts: () => call('kube.contexts'),
    configProblem: () => call('kube.configProblem'),
    namespaces: (c) => call('kube.namespaces', c),
    overview: (c, n) => call('kube.overview', c, n),
    logs: (c, n, p, k, onEvent, opts) => quiet(subscribe('kubeLogs', [c, n, p, k, !!opts?.previous], onEvent)),
    act: (c, a) => call('kube.act', c, a),
    list: (c, n, k) => call('kube.list', c, n, k),
    data: (c, n, k, name) => call('kube.data', c, n, k, name),
    yaml: (c, k, n, name) => call('kube.yaml', c, k, n, name),
    events: (c, n) => call('kube.events', c, n),
    rollouts: (c, n, name) => call('kube.rollouts', c, n, name),
    usage: (c, n) => call('kube.usage', c, n),
    sources: () => call('kube.sources'),
    podDetails: (c, n, p) => call('kube.podDetails', c, n, p),
    forwards: () => call('kube.forwards'),
    startForward: (c, t, local) => call('kube.startForward', c, t, local),
    stopForward: (id) => call('kube.stopForward', id),
    openForward: (id) => call('kube.openForward', id),
    exec: async (c, n, p, k, { shell, cols, rows }, onData, onExit) => {
      const s = subscribe('kubeExec', [c, n, p, k, shell, cols, rows], (m: { type: 'data'; data: string } | { type: 'exit'; code: number }) => (m.type === 'data' ? onData(m.data) : onExit(m.code)))
      await s.ready
      return {
        write: (data) => ipcRenderer.send('tender:exec', s.id, 'write', data),
        resize: (cols2, rows2) => ipcRenderer.send('tender:exec', s.id, 'resize', cols2, rows2),
        close: s.stop,
      }
    },
    pickSource: (k) => call('kube.pickSource', k),
  },
  resources: {
    status: () => call('resources.status'),
    act: (a) => call('resources.act', a),
  },
  doctor: {
    check: () => call('doctor.check'),
    fix: (id, distro) => call('doctor.fix', id, distro),
  },
  setup: {
    distros: () => call('setup.distros'),
    inspect: (distro) => call('setup.inspect', distro),
    install: (distro, onEvent) => quiet(subscribe('setupWsl', [distro], onEvent)),
  },
  tools: {
    status: () => call('tools.status'),
    installCli: (onStep) => quiet(subscribe('installCli', [], onStep)),
    useDefaultContext: () => call('tools.useDefaultContext'),
  },
  migrate: {
    check: () => call('migrate.check'),
    plan: (distro) => call('migrate.plan', distro),
    run: (distro, ids, opts, onEvent) => quiet(subscribe('migrate', [distro, ids, opts], onEvent)),
    repairSocket: (distro) => call('migrate.repairSocket', distro),
  },
  engine: {
    status: () => call('engine.status'),
    reconnect: () => call('engine.reconnect'),
    repairWsl: (distro) => call('engine.repairWsl', distro),
    restartWsl: () => call('engine.restartWsl'),
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
    tag: (id, reference) => call('images.tag', id, reference),
    push: (reference, onProgress) => {
      let settle: { resolve: () => void; reject: (e: unknown) => void }
      const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
      const s = subscribe('push', [reference], (p: { type: 'progress'; layers: LayerProgress[] } | { type: 'done' } | { type: 'error'; message: string; status?: number }) => {
        if (p.type === 'progress') onProgress(p.layers)
        else if (p.type === 'done') (handlers.delete(s.id), settle.resolve())
        else (handlers.delete(s.id), settle.reject(apiError(p.message, p.status)))
      })
      s.ready.catch((e) => settle.reject(e))
      return { pullId: s.id, done }
    },
    cancelPush: (pushId) => call('images.cancelPush', pushId),
    scan: (reference, onPhase) => {
      let settle: { resolve: (r: ScanResult) => void; reject: (e: unknown) => void }
      const done = new Promise<ScanResult>((resolve, reject) => (settle = { resolve, reject }))
      const s = subscribe('scan', [reference], (p: { type: 'phase'; phase: ScanPhase } | { type: 'done'; result: ScanResult } | { type: 'error'; message: string; status?: number }) => {
        if (p.type === 'phase') onPhase(p.phase)
        else if (p.type === 'done') (handlers.delete(s.id), settle.resolve(p.result))
        else (handlers.delete(s.id), settle.reject(apiError(p.message, p.status)))
      })
      s.ready.catch((e) => settle.reject(e))
      return { scanId: s.id, done }
    },
    cancelScan: (scanId) => call('images.cancelScan', scanId),
    openAdvisory: (id, url) => call('images.openAdvisory', id, url),
  },
  composeFiles: {
    list: () => call('composeFiles.list'),
    get: (path) => call('composeFiles.get', path),
    add: () => call('composeFiles.add'),
    forget: (path) => call('composeFiles.forget', path),
    run: (path, command, service, onLines) => {
      let settle: { resolve: () => void; reject: (e: unknown) => void }
      const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
      const s = subscribe('compose', [path, command, service ?? null], (p: { type: 'lines'; lines: string[] } | { type: 'done' } | { type: 'error'; message: string; status?: number }) => {
        if (p.type === 'lines') onLines(p.lines)
        else if (p.type === 'done') (handlers.delete(s.id), settle.resolve())
        else (handlers.delete(s.id), settle.reject(apiError(p.message, p.status)))
      })
      s.ready.catch((e) => settle.reject(e))
      return { runId: s.id, done }
    },
    cancel: (runId) => call('composeFiles.cancel', runId),
    readEnv: (path) => call('composeFiles.readEnv', path),
    writeEnv: (path, text) => call('composeFiles.writeEnv', path, text),
  },
  builds: {
    pickContext: () => call('builds.pickContext'),
    start: (spec, onEvent) => {
      let settle: { resolve: (v: { imageId: string }) => void; reject: (e: unknown) => void }
      const done = new Promise<{ imageId: string }>((resolve, reject) => (settle = { resolve, reject }))
      const s = subscribe('build', [spec], (p: BuildEvent | { type: 'done'; imageId: string } | { type: 'error'; message: string; status?: number }) => {
        if (p.type === 'done') (handlers.delete(s.id), settle.resolve({ imageId: p.imageId }))
        else if (p.type === 'error') (handlers.delete(s.id), settle.reject(apiError(p.message, p.status)))
        else onEvent(p)
      })
      s.ready.catch((e) => settle.reject(e))
      return { buildId: s.id, done }
    },
    cancel: (buildId) => call('builds.cancel', buildId),
  },
  tunnels: {
    list: () => call('tunnels.list'),
    open: (containerId, port) => call('tunnels.open', containerId, port),
    close: (id) => call('tunnels.close', id),
    visit: (url) => call('tunnels.visit', url),
  },
  files: {
    list: (id, path) => call('files.list', id, path),
    download: (id, path, isDir) => call('files.download', id, path, isDir),
    upload: (id, dir) => call('files.upload', id, dir),
    changes: (id) => call('files.changes', id),
  },
  registries: {
    list: () => call('registries.list'),
    login: (server, username, password) => call('registries.login', server, username, password),
    logout: (server) => call('registries.logout', server),
  },
  volumes: {
    list: () => call('volumes.list'),
    create: (name) => call('volumes.create', name),
    remove: (names) => call('volumes.remove', names),
    usage: (name) => call('volumes.usage', name),
    exportTo: (name) => call('volumes.exportTo', name),
    restoreFrom: (name) => call('volumes.restoreFrom', name),
  },
  networks: {
    list: () => call('networks.list'),
    create: (spec) => call('networks.create', spec),
    remove: (ids) => call('networks.remove', ids),
    members: (id) => call('networks.members', id),
    connect: (id, containerId) => call('networks.connect', id, containerId),
    disconnect: (id, containerId) => call('networks.disconnect', id, containerId),
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
