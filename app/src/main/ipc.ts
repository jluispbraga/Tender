import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { ApiError, type BuildSpec, type ComposeCommand } from '../renderer/src/api/types'
import type { Store } from './db'
import { toApiError, type Engine } from './engine/engine'
import * as migrate from './migrate/migrate'
import * as tools from './tools/windows-tools'
import * as setup from './tools/wsl-setup'
import * as doctor from './tools/doctor'
import * as resources from './tools/resources'
import * as kube from './k8s/kube'
import * as podTools from './k8s/pod-tools'
import * as kubeMore from './k8s/resources'
import { settingValue } from './settings-schema'
import * as updates from './updates'
import type { PipeShare } from './tools/windows-tools'
import { repairSocket } from './engine/wsl'
import * as registries from './engine/registries'
import * as build from './engine/build'
import * as composeFiles from './engine/compose-files'

// The IPC surface from architecture.md ("API"). Three channels:
//   tender:call   (route, args)         -> { ok, value } | { ok: false, error }
//   tender:sub    (subId, kind, args)   -> starts a stream, pushed on tender:push
//   tender:unsub  (subId)
// plus tender:exec for terminal input. Every input is validated with zod.

const id = z.string().min(1).max(200)
const ids = z.array(id).min(1).max(500)
/** A reference that names a repository and optionally a tag: lower case, like Docker requires. */
const imageRef = z
  .string()
  .max(255)
  .regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/, 'Use a name like ghcr.io/you/app:1.0: lower-case letters, digits, dots, dashes and slashes, then an optional :tag.')
/** A path inside a container. */
const containerPath = z.string().min(1).max(4096).startsWith('/', 'Paths inside a container start with /.')
/** An absolute path to a Compose file; the main process checks it exists. */
const filePath = z.string().min(3).max(1024).regex(/\.ya?ml$/i, 'That isn’t a Compose file.')
const registryServer = z.string().min(1, 'Enter the registry address.').max(255).regex(/^(https?:\/\/)?[A-Za-z0-9.-]+(:[0-9]+)?\/?$/, 'Use an address like ghcr.io or myregistry.example:5000.')
const octet = String.raw`(25[0-5]|2[0-4]\d|1?\d?\d)`
const ip4 = new RegExp(String.raw`^${octet}(\.${octet}){3}$`)
const cidr4 = new RegExp(String.raw`^${octet}(\.${octet}){3}/(3[0-2]|[12]?\d)$`)
// Kubernetes context, namespace, pod and container names ('*': every namespace).
const kubeName = z.string().min(1).max(253)
const kubeKind = z.enum(['statefulsets', 'jobs', 'cronjobs', 'ingresses', 'configmaps', 'secrets'])
// WSL distribution names: letters, digits, dot, dash, underscore (they end up on a command line).
const distro = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'Not a WSL distribution name.')
const action = z.enum(['start', 'stop', 'restart', 'pause', 'unpause'])
const portNum = z.string().regex(/^\d{1,5}$/).refine((s) => +s > 0 && +s < 65536)

export interface IpcDeps {
  engine: Engine
  store: Store
  /** Window and OS side effects that live in index.ts. */
  onSettingChanged: (key: string, value: unknown) => void
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean
  share: PipeShare
  /** Lets the window close for good before the update installer runs. */
  beforeUpdateQuit: () => void
}

type Route = { args: z.ZodType; run: (args: any) => unknown }

export function registerIpc(deps: IpcDeps) {
  const { engine, store } = deps
  const pulls = new Map<string, () => void>()
  const pushes = new Map<string, () => void>()
  const builds = new Map<string, () => void>()
  const composeRuns = new Map<string, () => void>()
  const scans = new Map<string, () => void>()
  const composeCtx = async () => ({ docker: build.findDockerCli(), host: build.cliHost(engine.currentEndpoint), containers: await engine.rawContainers().catch(() => []) })

  const routes: Record<string, Route> = {
    'engine.status': { args: z.tuple([]), run: () => ({ ...engine.getStatus() }) },
    'engine.reconnect': { args: z.tuple([]), run: () => engine.reconnect() },
    'engine.repairWsl': { args: z.tuple([distro]), run: ([d]) => engine.repairWsl(d) },
    'engine.restartWsl': { args: z.tuple([]), run: () => engine.restartWsl() },

    'updates.status': { args: z.tuple([]), run: () => updates.updateStatus() },
    'updates.check': { args: z.tuple([]), run: () => updates.check() },
    'updates.install': { args: z.tuple([]), run: () => updates.installNow(deps.beforeUpdateQuit) },
    'updates.openReleases': { args: z.tuple([]), run: () => shell.openExternal(updates.updateStatus().releases) },
    'kube.contexts': { args: z.tuple([]), run: () => kube.contexts() },
    'kube.configProblem': { args: z.tuple([]), run: () => kube.configProblem() },
    'kube.namespaces': { args: z.tuple([kubeName]), run: ([c]) => kube.namespaces(c) },
    'kube.overview': { args: z.tuple([kubeName, kubeName]), run: ([c, n]) => kube.overview(c, n) },
    'kube.podDetails': { args: z.tuple([kubeName, kubeName, kubeName]), run: ([c, n, p]) => podTools.podDetails(c, n, p) },
    'kube.forwards': { args: z.tuple([]), run: () => podTools.listForwards() },
    'kube.startForward': {
      args: z.tuple([kubeName, z.object({ kind: z.enum(['pod', 'service']), namespace: kubeName, name: kubeName, port: z.number().int().min(1).max(65535) }), z.number().int().min(0).max(65535)]),
      run: ([c, t, local]) => podTools.startForward(c, t.kind, t.namespace, t.name, t.port, local),
    },
    // Only http://localhost:<a port Tender is forwarding>. Nothing else reaches the OS shell.
    'kube.openForward': {
      args: z.tuple([z.string().max(20)]),
      run: ([id]) => {
        const f = podTools.listForwards().find((x) => x.id === id)
        if (!f) throw new Error('That port forward has stopped.')
        return shell.openExternal(`http://localhost:${f.localPort}`)
      },
    },
    'kube.stopForward': { args: z.tuple([z.string().max(20)]), run: ([id]) => podTools.stopForward(id) },
    'kube.sources': { args: z.tuple([]), run: () => kube.sourceReport() },
    'kube.pickSource': { args: z.tuple([z.enum(['file', 'folder'])]), run: ([k]) => kube.pickSource(k) },
    'kube.act': {
      args: z.tuple([
        kubeName,
        z.discriminatedUnion('kind', [
          z.object({ kind: z.enum(['delete-pod', 'delete-deployment', 'delete-service', 'restart-deployment']), namespace: kubeName, name: kubeName }),
          z.object({ kind: z.literal('scale-deployment'), namespace: kubeName, name: kubeName, replicas: z.number().int().min(0).max(100) }),
          z.object({ kind: z.literal('delete'), resource: kubeKind, namespace: kubeName, name: kubeName }),
          z.object({ kind: z.enum(['restart-statefulset', 'run-cronjob']), namespace: kubeName, name: kubeName }),
          z.object({ kind: z.literal('scale-statefulset'), namespace: kubeName, name: kubeName, replicas: z.number().int().min(0).max(100) }),
          z.object({ kind: z.literal('suspend-cronjob'), namespace: kubeName, name: kubeName, suspend: z.boolean() }),
          z.object({ kind: z.literal('rollback-deployment'), namespace: kubeName, name: kubeName, revision: z.number().int().min(1) }),
        ]),
      ]),
      run: ([c, a]) =>
        a.kind === 'delete' || a.kind === 'rollback-deployment' || a.kind === 'restart-statefulset' || a.kind === 'run-cronjob' || a.kind === 'scale-statefulset' || a.kind === 'suspend-cronjob' ? kubeMore.actMore(c, a) : kube.act(c, a),
    },
    'kube.list': { args: z.tuple([kubeName, kubeName, kubeKind]), run: ([c, n, k]) => kubeMore.list(c, n, k) },
    'kube.yaml': { args: z.tuple([kubeName, z.enum(['pods', 'deployments', 'services', 'statefulsets', 'jobs', 'cronjobs', 'ingresses', 'configmaps', 'secrets']), kubeName, kubeName]), run: ([c, k, n, name]) => kubeMore.yaml(c, k, n, name) },
    'kube.events': { args: z.tuple([kubeName, kubeName]), run: ([c, n]) => kubeMore.events(c, n) },
    'kube.rollouts': { args: z.tuple([kubeName, kubeName, kubeName]), run: ([c, n, name]) => kubeMore.rollouts(c, n, name) },
    'kube.usage': { args: z.tuple([kubeName, kubeName]), run: ([c, n]) => kubeMore.podUsage(c, n) },
    'kube.data': { args: z.tuple([kubeName, kubeName, z.enum(['configmaps', 'secrets']), kubeName]), run: ([c, n, k, name]) => kubeMore.data(c, n, k, name) },
    'resources.status': { args: z.tuple([]), run: () => resources.status(engine) },
    'resources.act': {
      args: z.tuple([
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('reclaim'), mode: z.enum(['gradual', 'dropCache', 'disabled']) }),
          z.object({ kind: z.literal('limit'), gb: z.number().int().min(2).max(1024).nullable() }),
          z.object({ kind: z.literal('sparse-default'), on: z.boolean() }),
          z.object({ kind: z.literal('make-sparse'), distro }),
          z.object({ kind: z.literal('trim'), distro }),
          z.object({ kind: z.literal('prune-build-cache') }),
        ]),
      ]),
      run: ([a]) => resources.act(engine, a),
    },
    'doctor.check': { args: z.tuple([]), run: () => doctor.check(engine, deps.share) },
    'doctor.fix': {
      args: z.tuple([z.enum(['wsl-update', 'restart-wsl', 'start-distro', 'repair-socket', 'start-docker', 'docker-group', 'dns-tunneling', 'default-context']), distro.optional()]),
      run: ([f, d]) => doctor.fix(engine, f, d),
    },
    'setup.distros': { args: z.tuple([]), run: () => setup.listDistros() },
    'setup.inspect': { args: z.tuple([distro]), run: ([d]) => setup.detail(d) },
    'tools.status': { args: z.tuple([]), run: () => tools.status(deps.share) },
    'tools.useDefaultContext': { args: z.tuple([]), run: () => tools.useDefaultContext() },
    'migrate.check': { args: z.tuple([]), run: () => migrate.check() },
    'migrate.plan': { args: z.tuple([distro]), run: ([d]) => migrate.plan(d) },
    'migrate.repairSocket': { args: z.tuple([distro]), run: ([d]) => repairSocket(d) },

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
    'images.tag': { args: z.tuple([id, imageRef]), run: ([i, r]) => engine.tagImage(i, r) },
    'images.openAdvisory': {
      args: z.tuple([z.string().regex(/^[A-Za-z0-9._:-]{3,80}$/), z.string().max(500).optional()]),
      run: ([vid, url]) => {
        const ADVISORY_HOSTS = ['avd.aquasec.com', 'nvd.nist.gov', 'www.cve.org', 'cve.mitre.org', 'github.com', 'security-tracker.debian.org', 'ubuntu.com', 'access.redhat.com', 'security.alpinelinux.org', 'osv.dev', 'pkg.go.dev']
        let target = `https://avd.aquasec.com/nvd/${encodeURIComponent(vid.toLowerCase())}`
        try {
          const u = url ? new URL(url) : null
          if (u && u.protocol === 'https:' && ADVISORY_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) target = u.toString()
        } catch {
          // Not a URL: fall back to the advisory page for the ID.
        }
        return shell.openExternal(target)
      },
    },
    'images.cancelScan': { args: z.tuple([id]), run: ([s]) => void scans.get(s)?.() },
    'images.cancelPush': { args: z.tuple([id]), run: ([p]) => void pushes.get(p)?.() },
    'composeFiles.list': {
      args: z.tuple([]),
      run: async () => {
        const c = await composeCtx()
        return composeFiles.list(c.docker, c.host, c.containers)
      },
    },
    'composeFiles.get': {
      args: z.tuple([filePath]),
      run: async ([p]) => {
        const c = await composeCtx()
        return composeFiles.describe(c.docker, c.host, p, c.containers)
      },
    },
    'composeFiles.add': {
      args: z.tuple([]),
      run: async () => {
        const { dialog } = await import('electron')
        const r = await dialog.showOpenDialog({ title: 'Open a Compose file', properties: ['openFile'], filters: [{ name: 'Compose files', extensions: ['yaml', 'yml'] }] })
        const p = r.canceled ? undefined : r.filePaths[0]
        if (!p) return null
        composeFiles.addPath(p)
        const c = await composeCtx()
        return composeFiles.describe(c.docker, c.host, p, c.containers)
      },
    },
    'composeFiles.forget': { args: z.tuple([filePath]), run: ([p]) => composeFiles.removePath(p) },
    'composeFiles.cancel': { args: z.tuple([id]), run: ([r]) => void composeRuns.get(r)?.() },
    'composeFiles.readEnv': { args: z.tuple([filePath]), run: ([p]) => composeFiles.readEnv(p) },
    'composeFiles.writeEnv': { args: z.tuple([filePath, z.string().max(256 * 1024)]), run: ([p, t]) => composeFiles.writeEnv(p, t) },
    'builds.pickContext': {
      args: z.tuple([]),
      run: async () => {
        const { dialog } = await import('electron')
        const r = await dialog.showOpenDialog({ title: 'Choose the folder to build', properties: ['openDirectory'] })
        return r.canceled || !r.filePaths[0] ? null : build.inspectContext(r.filePaths[0])
      },
    },
    'builds.cancel': { args: z.tuple([id]), run: ([b]) => void builds.get(b)?.() },
    'tunnels.list': { args: z.tuple([]), run: () => engine.listTunnels() },
    'tunnels.open': { args: z.tuple([id, z.number().int().min(1).max(65535)]), run: ([c, p]) => engine.openTunnel(c, p) },
    'tunnels.close': { args: z.tuple([id]), run: ([t]) => engine.closeTunnel(t) },
    'tunnels.visit': {
      args: z.tuple([z.string().regex(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/, 'Only tunnel links open from here.')]),
      run: ([u]) => shell.openExternal(u),
    },
    'files.list': { args: z.tuple([id, containerPath]), run: ([c, p]) => engine.listFiles(c, p) },
    'files.download': {
      args: z.tuple([id, containerPath, z.boolean()]),
      run: async ([c, p, isDir]) => {
        const { dialog } = await import('electron')
        return engine.downloadFile(c, p, isDir, async (defaultPath, folder) => {
          const r = await dialog.showSaveDialog({ title: folder ? 'Save the folder as a .tar' : 'Save the file', defaultPath, ...(folder ? { filters: [{ name: 'Tar archive', extensions: ['tar'] }] } : {}) })
          return r.canceled || !r.filePath ? null : r.filePath
        })
      },
    },
    'files.upload': {
      args: z.tuple([id, containerPath]),
      run: async ([c, dir]) => {
        const { dialog } = await import('electron')
        const r = await dialog.showOpenDialog({ title: `Copy files into ${dir}`, properties: ['openFile', 'multiSelections'] })
        if (r.canceled || !r.filePaths.length) return 0
        return engine.uploadFiles(c, dir, r.filePaths)
      },
    },
    'files.changes': { args: z.tuple([id]), run: ([c]) => engine.containerChanges(c) },
    'registries.list': { args: z.tuple([]), run: () => registries.listLogins() },
    'registries.login': {
      args: z.tuple([registryServer, z.string().min(1, 'Enter the user name.').max(255), z.string().min(1, 'Enter the password or token.').max(4096)]),
      run: async ([s, u, p]) => {
        await engine.checkLogin(s, u, p)
        return registries.saveLogin(s, u, p)
      },
    },
    'registries.logout': { args: z.tuple([registryServer]), run: ([s]) => registries.removeLogin(s) },
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
    'volumes.exportTo': {
      args: z.tuple([id]),
      run: async ([n]) => {
        const { dialog } = await import('electron')
        const r = await dialog.showSaveDialog({ title: `Back up ${n}`, defaultPath: `${n}-${new Date().toISOString().slice(0, 10)}.tar.gz`, filters: [{ name: 'Gzipped tar', extensions: ['gz', 'tgz'] }] })
        if (r.canceled || !r.filePath) return null
        const bytes = await engine.exportVolume(n, r.filePath)
        return { file: r.filePath, bytes }
      },
    },
    'volumes.restoreFrom': {
      args: z.tuple([z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Use at least two characters: letters, digits, dots, dashes or underscores, starting with a letter or digit.').max(255)]),
      run: async ([n]) => {
        const { dialog } = await import('electron')
        const r = await dialog.showOpenDialog({ title: `Restore ${n} from a backup`, properties: ['openFile'], filters: [{ name: 'Tar archives', extensions: ['gz', 'tgz', 'tar'] }] })
        const file = r.canceled ? undefined : r.filePaths[0]
        if (!file) return null
        await engine.restoreVolume(n, file)
        return { file }
      },
    },

    'networks.list': { args: z.tuple([]), run: () => engine.listNetworks() },
    'networks.create': {
      args: z.tuple([
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Use at least two characters: letters, digits, dots, dashes or underscores, starting with a letter or digit.').max(255),
            internal: z.boolean(),
            subnet: z.string().regex(cidr4, 'Write the subnet as an IPv4 range, like 172.30.0.0/24.').optional(),
            gateway: z.string().regex(ip4, 'Write the gateway as an IPv4 address, like 172.30.0.1.').optional(),
          })
          .refine((s) => !s.gateway || s.subnet, { message: 'A gateway needs a subnet.', path: ['gateway'] }),
      ]),
      run: ([s]) => engine.createNetwork(s),
    },
    'networks.remove': { args: z.tuple([ids]), run: ([i]) => engine.removeNetworks(i) },
    'networks.members': { args: z.tuple([id]), run: ([i]) => engine.networkMembers(i) },
    'networks.connect': { args: z.tuple([id, id]), run: ([n, c]) => engine.connectNetwork(n, c) },
    'networks.disconnect': { args: z.tuple([id, id]), run: ([n, c]) => engine.disconnectNetwork(n, c) },

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
    exec: z.tuple([id, z.enum(['/bin/sh', '/bin/bash', 'cmd.exe', 'debug']), z.number().int().min(10).max(1000), z.number().int().min(4).max(500)]),
    installCli: z.tuple([]),
    kubeLogs: z.tuple([kubeName, kubeName, kubeName, kubeName, z.boolean()]),
    kubeExec: z.tuple([kubeName, kubeName, kubeName, kubeName, z.enum(['auto', '/bin/sh', '/bin/bash']), z.number().int().min(10).max(1000), z.number().int().min(4).max(500)]),
    setupWsl: z.tuple([distro]),
    migrate: z.tuple([distro, z.array(z.string().max(300)).max(2000), z.object({ start: z.boolean() })]),
    pull: z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]{0,255}$/i, 'That isn’t a valid image reference.')]),
    push: z.tuple([imageRef]),
    scan: z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]{0,255}$/i, 'That isn’t a valid image reference.')]),
    compose: z.tuple([filePath, z.enum(['up', 'down', 'pull', 'build', 'restart', 'stop']), z.string().regex(/^[a-zA-Z0-9._-]+$/).max(128).nullable()]),
    build: z.tuple([
      z.object({
        context: z.string().min(1).max(1024),
        dockerfile: z.string().min(1).max(255).regex(/^[^/\\]+$/, 'Pick a Dockerfile in the folder itself.'),
        tag: imageRef.optional(),
        target: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'A target is the name after AS in a FROM line.').max(128).optional(),
        buildArgs: z.array(z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Build argument names use letters, digits and underscores.'), value: z.string().max(32_768) })).max(100),
        noCache: z.boolean(),
        pull: z.boolean(),
      }),
    ]),
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
        case 'compose': {
          const [path, cmd, service] = a as [string, ComposeCommand, string | null]
          const docker = build.findDockerCli()
          if (!docker) return { ok: false, error: { message: 'Compose files need the Docker CLI with Compose. Install it in Settings › General › Windows tools.', status: 424 } }
          const r = composeFiles.command(docker, build.cliHost(engine.currentEndpoint), path, cmd, service ?? undefined, (lines) => to({ type: 'lines', lines }))
          composeRuns.set(subId, r.cancel)
          stop = r.cancel
          r.done
            .then(
              () => to({ type: 'done' }),
              (err) => {
                const ae = toApiError(err)
                to({ type: 'error', message: ae.message, status: ae.status })
              },
            )
            .finally(() => {
              composeRuns.delete(subId)
              subs.delete(subId)
            })
          break
        }
        case 'build': {
          const spec = a[0] as BuildSpec
          const docker = build.findDockerCli()
          if (!docker) return { ok: false, error: { message: 'Building needs the Docker CLI. Install it in Settings › General › Windows tools, or put docker on your PATH.', status: 424 } }
          build.inspectContext(spec.context)
          const b = build.build(docker, build.cliHost(engine.currentEndpoint), spec, (ev) => to(ev))
          builds.set(subId, b.cancel)
          stop = b.cancel
          b.done
            .then(
              ({ imageId }) => {
                notify({ kind: 'success', title: spec.tag ? `Built ${spec.tag}` : 'Build finished' })
                to({ type: 'done', imageId })
              },
              (err) => {
                const ae = toApiError(err)
                if (ae.status !== 499) notify({ kind: 'error', title: spec.tag ? `Couldn’t build ${spec.tag}` : 'Build failed', body: ae.message })
                to({ type: 'error', message: ae.message, status: ae.status })
              },
            )
            .finally(() => {
              builds.delete(subId)
              subs.delete(subId)
            })
          break
        }
        case 'scan': {
          const ref: string = a[0]
          const sc = engine.scanImage(ref, (phase) => to({ type: 'phase', phase }))
          scans.set(subId, sc.cancel)
          stop = sc.cancel
          sc.done
            .then(
              (result) => to({ type: 'done', result }),
              (err) => {
                const ae = toApiError(err)
                to({ type: 'error', message: ae.message, status: ae.status })
              },
            )
            .finally(() => {
              scans.delete(subId)
              subs.delete(subId)
            })
          break
        }
        case 'push': {
          const reference: string = a[0]
          const p = engine.push(reference, (layers) => to({ type: 'progress', layers }))
          pushes.set(subId, p.cancel)
          stop = p.cancel
          p.done
            .then(
              () => {
                notify({ kind: 'success', title: `Pushed ${reference}` })
                to({ type: 'done' })
              },
              (err) => {
                const ae = toApiError(err)
                to({ type: 'error', message: ae.message, status: ae.status })
              },
            )
            .finally(() => {
              pushes.delete(subId)
              subs.delete(subId)
            })
          break
        }
        case 'kubeLogs':
          stop = kube.followLogs(a[0], a[1], a[2], a[3], 1000, (lines) => to({ type: 'lines', lines }), (message) => to({ type: 'error', message }), a[4])
          break
        case 'kubeExec': {
          exec = await podTools.openExec(a[0], a[1], a[2], a[3], a[4], a[5], a[6], (d) => to({ type: 'data', data: d }), (code) => to({ type: 'exit', code }))
          stop = () => exec!.close()
          break
        }
        case 'installCli': {
          let live = true
          stop = () => (live = false)
          tools.installCli((s) => live && to({ type: 'step', ...s })).then(
            () => live && to({ type: 'done' }),
            (err) => live && to({ type: 'error', message: toApiError(err).message }),
          )
          break
        }
        case 'setupWsl':
          stop = setup.install(a[0], (ev) => to(ev))
          break
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
