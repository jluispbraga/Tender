import {
  ApiError,
  type ActionResult,
  type ContainerRow,
  type EngineEvent,
  type EngineStatus,
  type GridPrefs,
  type KubeForward,
  type KubeItem,
  type GridView,
  type TenderApi,
  type ImageRow,
  type LayerProgress,
  type LogLine,
  type MigrationEvent,
  type MigrationItem,
  type MigrationStep,
  type Notification,
  type RecentItem,
  type Settings,
  type StatsSample,
  type NetworkMember,
  type RegistryLogin,
  type BuildStep,
  type ComposeFile,
  type Severity,
  type FileEntry,
  type Tunnel,
  type LocalCluster,
  type LocalClusterTool,
  type Vulnerability,
  type ComposeService,
  type NetworkRow,
  type VolumeRow,
  type WindowsTools,
  type WslSetupEvent,
  type WslResources,
  type UpdateStatus,
} from '../types'
import { bootLines, chatter, flavour, seedAttachments, seedContainers, seedImages, seedLayers, seedNetworks, seedVolumes } from './seed'
import { createFakeShell } from './shell'

// An in-memory stand-in for Docker Engine, so every screen can be built and
// tested before the Electron main process exists. Behaviour follows the
// public Engine API where it matters to the UI: 304 on no-op start/stop,
// 409 when an object is in use, events after every change.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')

export function createFakeApi(): TenderApi {
  let containers: ContainerRow[] = structuredClone(seedContainers)
  let images: ImageRow[] = structuredClone(seedImages)
  let volumes: VolumeRow[] = structuredClone(seedVolumes)
  let networks: NetworkRow[] = structuredClone(seedNetworks)
  const attachments = new Map<string, string[]>(Object.entries(structuredClone(seedAttachments)))
  const addresses = new Map<string, string>()
  const logins = new Map<string, RegistryLogin>()
  const uploaded = new Map<string, string[]>()
  let localClusters: LocalCluster[] = [{ tool: 'kind', name: 'dev', context: 'kind-dev' }]
  const helmRels = [
    {
      name: 'web',
      namespace: 'shop',
      history: [
        { revision: 3, status: 'deployed', chart: 'nginx-15.4.2', appVersion: '1.27.2', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), description: 'Upgrade complete' },
        { revision: 2, status: 'superseded', chart: 'nginx-15.4.1', appVersion: '1.27.1', updatedAt: new Date(Date.now() - 3 * 86400_000).toISOString(), description: 'Upgrade complete' },
        { revision: 1, status: 'superseded', chart: 'nginx-15.4.0', appVersion: '1.27.0', updatedAt: new Date(Date.now() - 9 * 86400_000).toISOString(), description: 'Install complete' },
      ],
    },
    {
      name: 'cache',
      namespace: 'shop',
      history: [{ revision: 1, status: 'failed', chart: 'redis-19.6.0', appVersion: '7.2.5', updatedAt: new Date(Date.now() - 40 * 60_000).toISOString(), description: 'Release "cache" failed: timed out waiting for the condition' }],
    },
  ]
  let tunnels: Tunnel[] = []
  // Compose files the fake knows: what `docker compose config` would print for each.
  type FakeService = { image?: string; build?: boolean; ports: string[]; command: string }
  const composeDefs: Record<string, { project: string; services: Record<string, FakeService> }> = {
    [String.raw`C:\code\shop\compose.yaml`]: {
      project: 'shop',
      services: {
        web: { image: 'nginx:1.27', ports: ['8080:80'], command: 'nginx -g "daemon off;"' },
        api: { build: true, ports: ['3000:3000'], command: 'node server.js' },
        db: { image: 'postgres:17', ports: ['5432:5432'], command: 'docker-entrypoint.sh postgres' },
        worker: { build: true, ports: [], command: 'node worker.js' },
      },
    },
    [String.raw`C:\code\analytics\compose.yaml`]: {
      project: 'analytics',
      services: {
        clickhouse: { image: 'clickhouse/clickhouse-server:24.8', ports: ['8123:8123'], command: '/entrypoint.sh' },
        grafana: { image: 'grafana/grafana:11.2.0', ports: ['3001:3000'], command: '/run.sh' },
      },
    },
  }
  const savedCompose = new Set<string>([String.raw`C:\code\analytics\compose.yaml`])
  const envFiles = new Map<string, string>([[String.raw`C:\code\shop\compose.yaml`, '# Read by compose.yaml\nPOSTGRES_PASSWORD=dev\nAPI_PORT=3000\n']])
  function describeCompose(path: string): ComposeFile {
    const def = composeDefs[path]
    const base = { path, saved: savedCompose.has(path), hasEnv: envFiles.has(path) }
    if (!def) return { ...base, project: '', services: [], error: 'The file isn’t there any more.' }
    const services: ComposeService[] = Object.entries(def.services).map(([name, sv]) => {
      const mine = containers.filter((c) => c.project === def.project && c.service === name)
      const states = mine.map((c) => c.state)
      return {
        name,
        image: sv.image,
        build: !!sv.build,
        ports: sv.ports,
        state: !mine.length ? 'missing' : states.includes('running') ? 'running' : states.includes('restarting') ? 'restarting' : states.includes('paused') ? 'paused' : 'exited',
        containerIds: mine.map((c) => c.id),
      }
    })
    return { ...base, project: def.project, services: services.sort((a, b) => a.name.localeCompare(b.name)) }
  }
  const server = (x: string) => {
    const h = x.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
    return !h || h === 'index.docker.io' || h === 'hub.docker.com' ? 'docker.io' : h
  }
  const registryOf = (ref: string) => {
    const first = ref.split('/')[0]
    return ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? server(first) : 'docker.io'
  }
  const splitRef = (ref: string) => {
    const slash = ref.lastIndexOf('/')
    const colon = ref.lastIndexOf(':')
    return colon > slash ? { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { repo: ref, tag: 'latest' }
  }
  let engine: EngineStatus = {
    state: 'running',
    endpoint: '//./pipe/docker_engine',
    version: '28.3.2',
    apiVersion: '1.51',
    os: 'linux',
    ncpu: 8,
    memTotal: 7.6e9,
  }
  const settings: Settings = {
    theme: 'system',
    start_on_login: false,
    open_on_start: true,
    only_running: false,
    exec_default_shell: '/bin/sh',
    log_tail_lines: 1000,
    tray_enabled: true,
    share_docker_pipe: true,
    check_updates: true,
    engine_choice: 'auto',
    alerts: true,
    kube_sources: [],
    kube_labels: {},
    kube_forwards: [],
  }
  const fakeProd = String.raw`C:\Users\you\.kube\prod`
  const grid: Record<GridView, GridPrefs> = { containers: { hidden: ['created'] }, images: { hidden: [] }, volumes: { hidden: [] } }
  const notifications: Notification[] = [
    { id: rid(), kind: 'error', title: 'migrate-once stopped with exit code 1', createdAt: new Date(Date.now() - 5 * 3600_000).toISOString() },
    { id: rid(), kind: 'success', title: 'Pulled postgres:17', body: '438 MB', createdAt: new Date(Date.now() - 14 * 86400_000).toISOString(), readAt: now() },
  ]
  let recents: RecentItem[] = []

  // ---- logs ---------------------------------------------------------------
  const logs = new Map<string, LogLine[]>()
  const logSubs = new Map<string, Set<(l: LogLine[]) => void>>()
  const pushLog = (id: string, lines: LogLine[]) => {
    const buf = logs.get(id) ?? []
    buf.push(...lines)
    if (buf.length > 5000) buf.splice(0, buf.length - 5000)
    logs.set(id, buf)
    logSubs.get(id)?.forEach((cb) => cb(lines))
  }
  for (const c of containers) {
    const f = flavour(c.image)
    const base = Date.now() - 120_000
    pushLog(c.id, (bootLines[f] ?? bootLines.default).map((text, i) => ({ ts: new Date(base + i * 400).toISOString(), stream: /error|failed/i.test(text) ? 'stderr' : 'stdout', text })))
    if (c.state === 'running') {
      const lines = chatter[f] ?? chatter.default
      pushLog(c.id, Array.from({ length: 40 }, (_, i) => ({ ts: new Date(base + 2000 + i * 2500).toISOString(), ...lines[i % lines.length] })))
    }
  }

  // ---- events / status ----------------------------------------------------
  const eventSubs = new Set<(e: EngineEvent[]) => void>()
  const statusSubs = new Set<(s: EngineStatus) => void>()
  const notifSubs = new Set<(n: Notification) => void>()
  const emit = (...events: EngineEvent[]) => eventSubs.forEach((cb) => cb(events))
  const notify = (n: Omit<Notification, 'id' | 'createdAt'>) => {
    const full = { ...n, id: rid(), createdAt: now() }
    notifications.unshift(full)
    notifSubs.forEach((cb) => cb(full))
  }
  const setEngine = (patch: Partial<EngineStatus>) => {
    engine = { ...engine, ...patch }
    statusSubs.forEach((cb) => cb(engine))
  }
  const up = async (ms = 120) => {
    await sleep(ms)
    if (engine.state !== 'running') throw new ApiError(`Can’t reach the engine at ${engine.endpoint}`, 503)
  }

  // ---- background ticks: chatter, restart loop, stats ---------------------
  const stats = new Map<string, StatsSample>()
  let tick = 0
  setInterval(() => {
    if (engine.state !== 'running') return
    tick++
    containers.forEach((c, i) => {
      if (c.state !== 'running') return
      // Every running container writes a line every other tick (staggered), so
      // a log view always sees new output within a few seconds; tests rely on it.
      if ((tick + i) % 2 === 0) {
        const lines = chatter[flavour(c.image)] ?? chatter.default
        pushLog(c.id, [{ ts: now(), ...lines[(tick + i) % lines.length] }])
      }
    })
    // The worker never manages to start: restarting -> running -> restarting.
    const w = containers.find((c) => c.name === 'shop-worker-1' && (c.state === 'restarting' || c.state === 'running'))
    if (w && Math.random() < 0.3) {
      w.state = w.state === 'restarting' ? 'running' : 'restarting'
      w.startedAt = now()
      pushLog(w.id, chatter.worker.map((l) => ({ ts: now(), ...l })))
      emit({ type: 'container', action: w.state === 'running' ? 'start' : 'die', id: w.id })
    }
  }, 1200)
  const statSubs = new Set<{ ids: Set<string>; cb: (s: StatsSample[]) => void }>()
  setInterval(() => {
    if (engine.state !== 'running') return
    const out: StatsSample[] = []
    for (const c of containers) {
      if (c.state !== 'running') {
        stats.delete(c.id)
        continue
      }
      const prev = stats.get(c.id)
      const limit = 7.6e9
      const baseMem = { postgres: 180e6, node: 120e6, nginx: 12e6, collector: 90e6 }[flavour(c.image)] ?? 30e6
      const s: StatsSample = {
        id: c.id,
        at: Date.now(),
        cpuPercent: Math.max(0, Math.min(400, (prev?.cpuPercent ?? Math.random() * 3) + (Math.random() - 0.5) * 1.5)),
        memUsage: Math.max(1e6, (prev?.memUsage ?? baseMem) + (Math.random() - 0.48) * 2e6),
        memLimit: limit,
        netRx: (prev?.netRx ?? 0) + Math.random() * 40e3,
        netTx: (prev?.netTx ?? 0) + Math.random() * 25e3,
        blkRead: (prev?.blkRead ?? 0) + Math.random() * 8e3,
        blkWrite: (prev?.blkWrite ?? 0) + Math.random() * 12e3,
        pids: prev?.pids ?? 3 + Math.floor(Math.random() * 20),
      }
      stats.set(c.id, s)
      out.push(s)
    }
    for (const sub of statSubs) {
      const mine = out.filter((s) => sub.ids.has(s.id))
      if (mine.length) sub.cb(mine)
    }
  }, 1000)

  // ---- helpers ------------------------------------------------------------
  const byId = (id: string) => {
    const c = containers.find((x) => x.id === id || x.id.startsWith(id) || x.name === id)
    if (!c) throw new ApiError(`No such container: ${id}`, 404)
    return c
  }
  const refreshUsage = () => {
    for (const i of images) i.inUse = containers.some((c) => c.imageId === i.id)
    for (const v of volumes) v.usedBy = containers.filter((c) => c.mounts.some((m) => m.type === 'volume' && m.source === v.name)).map((c) => c.name)
    for (const n of networks) n.usedBy = containers.filter((c) => netsOf(c).includes(n.id)).map((c) => c.name)
  }
  /** Like Docker: a container joins its Compose project's network, or bridge, unless told otherwise. */
  function netsOf(c: ContainerRow): string[] {
    const own = attachments.get(c.id)
    if (own) return own.filter((id) => networks.some((n) => n.id === id))
    const def = networks.find((n) => n.name === (c.project ? `${c.project}_default` : 'bridge'))
    return def ? [def.id] : []
  }
  /** Stable, unique addresses inside each network's subnet. */
  function addressIn(n: NetworkRow, c: ContainerRow): string | undefined {
    if (!n.subnet) return undefined
    const key = `${n.id}:${c.id}`
    if (!addresses.has(key)) {
      const taken = [...addresses.keys()].filter((k) => k.startsWith(`${n.id}:`)).length
      addresses.set(key, n.subnet.split('/')[0].replace(/\.0$/, `.${taken + 2}`))
    }
    return addresses.get(key)
  }
  const netById = (id: string) => {
    const n = networks.find((x) => x.id === id || x.name === id)
    if (!n) throw new ApiError(`No such network: ${id}`, 404)
    return n
  }
  refreshUsage()

  async function act(c: ContainerRow, action: string): Promise<ActionResult> {
    const f = flavour(c.image)
    switch (action) {
      case 'start':
        if (c.state === 'running') return { id: c.id, ok: true } // 304
        if (c.state === 'paused') return { id: c.id, ok: false, error: 'Container is paused; resume it instead.' }
        await sleep(500)
        c.state = f === 'migrate' ? 'exited' : 'running'
        c.startedAt = now()
        c.exitCode = f === 'migrate' ? 1 : undefined
        pushLog(c.id, (bootLines[f] ?? bootLines.default).map((text) => ({ ts: now(), stream: /error|failed/i.test(text) ? 'stderr' : 'stdout', text })))
        emit({ type: 'container', action: 'start', id: c.id })
        if (f === 'migrate') {
          emit({ type: 'container', action: 'die', id: c.id })
          notify({ kind: 'error', title: `${c.name} stopped with exit code 1` })
        }
        return { id: c.id, ok: true }
      case 'stop':
        if (c.state === 'exited' || c.state === 'created') return { id: c.id, ok: true } // 304
        await sleep(700)
        c.state = 'exited'
        c.exitCode = c.name === 'shop-worker-1' ? 1 : 0
        pushLog(c.id, [{ ts: now(), stream: 'stdout', text: 'received SIGTERM, shutting down' }])
        emit({ type: 'container', action: 'stop', id: c.id })
        return { id: c.id, ok: true }
      case 'restart':
        await sleep(900)
        c.state = 'running'
        c.startedAt = now()
        c.exitCode = undefined
        pushLog(c.id, [{ ts: now(), stream: 'stdout', text: 'received SIGTERM, shutting down' }, ...(bootLines[f] ?? bootLines.default).map((text) => ({ ts: now(), stream: 'stdout' as const, text }))])
        emit({ type: 'container', action: 'restart', id: c.id })
        return { id: c.id, ok: true }
      case 'pause':
        if (c.state !== 'running') return { id: c.id, ok: false, error: 'Only a running container can be paused.' }
        await sleep(200)
        c.state = 'paused'
        emit({ type: 'container', action: 'pause', id: c.id })
        return { id: c.id, ok: true }
      case 'unpause':
        if (c.state !== 'paused') return { id: c.id, ok: false, error: 'Container is not paused.' }
        await sleep(200)
        c.state = 'running'
        emit({ type: 'container', action: 'unpause', id: c.id })
        return { id: c.id, ok: true }
    }
    return { id: c.id, ok: false, error: `Unknown action ${action}` }
  }

  async function removeContainers(ids: string[], force = false): Promise<ActionResult[]> {
    await up(300)
    return ids.map((id) => {
      const c = containers.find((x) => x.id === id)
      if (!c) return { id, ok: true } // 404 counts as done
      if ((c.state === 'running' || c.state === 'paused' || c.state === 'restarting') && !force) {
        return { id, ok: false, error: `${c.name} is running. Stop it first, or force the removal.` }
      }
      containers = containers.filter((x) => x !== c)
      logs.delete(c.id)
      emit({ type: 'container', action: 'destroy', id: c.id })
      refreshUsage()
      return { id, ok: true }
    })
  }

  const pulls = new Map<string, { cancel: () => void }>()
  const activePullByRef = new Map<string, string>()

  let fakeDoctorFixed = false
  const fakeKubeScale = { web: 1 }
  const fakeKubeDeleted = new Set<string>()
  const fakeMore = { dbReplicas: 1, nightlySuspended: false, manualRuns: [] as string[], webRevision: 3 }
  const fakeForwards: KubeForward[] = []
  let fakeForwardId = 1
  let fakeKubeBroken = false
  let fakeUpdate: UpdateStatus = { supported: true, current: '0.4.0', state: 'none', releases: 'https://github.com/jluispbraga/Tender/releases' }
  const fakeResources: WslResources = {
    memory: { vmBytes: 3_050_000_000, hostBytes: 16_600_000_000, limit: null, reclaim: 'disabled' },
    disks: [{ distro: 'Ubuntu', path: String.raw`C:\Users\you\AppData\Local\Packages\Ubuntu\LocalState\ext4.vhdx`, fileBytes: 59_000_000_000, usedBytes: 41_000_000_000, sparse: false, running: true, version: 2 }],
    sparseByDefault: false,
    buildCache: { total: 6_200_000_000, reclaimable: 5_900_000_000 },
    wslconfig: String.raw`C:\Users\you\.wslconfig`,
  }
  let fakeTools: WindowsTools = { pipe: { state: 'serving', distro: 'Ubuntu' }, cli: null, compose: null, buildx: null, context: 'desktop-linux', contextUsesPipe: false, binOnPath: false }

  const fakeMigrationPlan: MigrationItem[] = [
    { id: 'project:shop', kind: 'project', label: 'shop', containers: ['shop-web-1', 'shop-db-1', 'shop-worker-1'], images: ['sha256:shopweb', 'sha256:postgres17', 'sha256:shopworker'], volumes: ['shop-data'], bytes: 912_000_000, running: 2, conflicts: [] },
    { id: 'project:analytics', kind: 'project', label: 'analytics', containers: ['clickhouse', 'grafana'], images: ['sha256:clickhouse', 'sha256:grafana'], volumes: ['analytics_ch-data'], bytes: 2_400_000_000, running: 0, conflicts: ['grafana'] },
    { id: 'container:qdrant', kind: 'container', label: 'qdrant', containers: ['qdrant'], images: ['sha256:qdrant'], volumes: [], bytes: 210_000_000, running: 0, conflicts: [] },
    { id: 'unused-images', kind: 'unused-images', label: 'Images no container uses (4)', containers: [], images: ['sha256:node22', 'sha256:python313', 'sha256:alpine', 'sha256:busybox'], volumes: [], bytes: 1_300_000_000, running: 0, conflicts: [] },
  ]

  const api: TenderApi = {
    kind: 'fake',
    updates: {
      async status() {
        return { ...fakeUpdate }
      },
      async check() {
        if (fakeUpdate.state === 'ready') return { ...fakeUpdate }
        fakeUpdate = { ...fakeUpdate, state: 'checking' }
        await sleep(300)
        fakeUpdate = { ...fakeUpdate, state: 'ready', version: '0.4.1', percent: 100, checkedAt: new Date().toISOString() }
        return { ...fakeUpdate }
      },
      async install() {
        await sleep(100)
        fakeUpdate = { ...fakeUpdate, state: 'none', current: fakeUpdate.version ?? fakeUpdate.current, version: undefined }
      },
      async openReleases() {},
    },
    kube: {
      async configProblem() {
        await sleep(50)
        return fakeKubeBroken
          ? { path: 'C:\\Users\\dev\\.kube\\config', problem: 'Your kubeconfig lists the cluster minikube but no context to reach it, and its current context “minikube” does not exist. kubectl cannot use it either.', hint: 'Run minikube start: it starts the cluster and writes its context again.' }
          : null
      },
      async contexts() {
        await sleep(100)
        if (fakeKubeBroken) return []
        return [
          { name: 'kind-dev', context: 'kind-dev', key: 'config#kind-dev', defaultLabel: 'kind-dev', guessedEnv: 'local' as const, cluster: 'kind-dev', server: 'https://127.0.0.1:6443', namespace: 'default', current: true },
          { name: 'minikube', context: 'minikube', key: 'config#minikube', defaultLabel: 'minikube', guessedEnv: 'local' as const, cluster: 'minikube', server: 'https://127.0.0.1:57796', namespace: 'default', current: false },
          // Two clusters set up with microk8s defaults: same context name, told apart by their files.
          ...(settings.kube_sources.includes(fakeProd)
            ? [
                { name: 'microk8s', context: 'microk8s', key: 'prod#flake-prod', defaultLabel: 'flake-prod', guessedEnv: 'prod' as const, cluster: 'microk8s-cluster', server: 'https://10.0.0.12:16443', namespace: 'default', current: false, file: `${fakeProd}\\flake-prod-kubeconfig` },
                { name: 'microk8s (flake-qa-kubeconfig)', context: 'microk8s', key: 'prod#flake-qa', defaultLabel: 'flake-qa', guessedEnv: 'qa' as const, cluster: 'microk8s-cluster', server: 'https://10.0.0.21:16443', namespace: 'default', current: false, file: `${fakeProd}\\flake-qa-kubeconfig` },
              ]
            : []),
        ]
      },
      async namespaces(c) {
        await sleep(150)
        if (c === 'minikube') throw new ApiError('minikube did not answer within 6 s. Is the cluster running?')
        return ['default', 'kube-system', 'shop']
      },
      async overview(c, ns) {
        await sleep(200)
        if (c === 'minikube') throw new ApiError('minikube did not answer within 6 s. Is the cluster running?')
        const pods = [
          { name: 'web-7d9f8b6c5-x2k4p', namespace: 'shop', status: 'Running', ready: '1/1', restarts: 0, node: 'kind-dev-control-plane', containers: ['web'], ports: [8080], createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() , owner: { kind: 'ReplicaSet', name: 'web-7d9f8b6c5' } },
          { name: 'worker-5c6d7f8-abcde', namespace: 'shop', status: 'CrashLoopBackOff', ready: '0/1', restarts: 7, node: 'kind-dev-control-plane', containers: ['worker'], ports: [], createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() , owner: { kind: 'ReplicaSet', name: 'worker-5c6d7f8' } },
          { name: 'migrate-v42-7xk2p', namespace: 'shop', status: 'Error', ready: '0/1', restarts: 0, node: 'kind-dev-control-plane', containers: ['migrate'], ports: [], createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), owner: { kind: 'Job', name: 'migrate-v42' } },
          { name: 'coredns-5d78c9869d-q8rlz', namespace: 'kube-system', status: 'Running', ready: '1/1', restarts: 0, node: 'kind-dev-control-plane', containers: ['coredns'], ports: [53], createdAt: new Date(Date.now() - 86400_000).toISOString() , owner: { kind: 'ReplicaSet', name: 'coredns-5d78c9869d' } },
        ]
        const keep = <T extends { namespace: string; name: string }>(xs: T[]) => (ns === '*' ? xs : xs.filter((x) => x.namespace === ns)).filter((x) => !fakeKubeDeleted.has(x.name))
        return {
          pods: keep(pods),
          deployments: keep([
            { name: 'web', namespace: 'shop', ready: `${fakeKubeScale.web}/${fakeKubeScale.web}`, replicas: fakeKubeScale.web, upToDate: fakeKubeScale.web, images: ['shop/web:1.4.2'] },
            { name: 'worker', namespace: 'shop', ready: '0/1', replicas: 1, upToDate: 1, images: ['shop/worker:dev'] },
          ]),
          services: keep([{ name: 'web', namespace: 'shop', type: 'NodePort', clusterIP: '10.96.12.40', ports: ['80:30080/TCP'], portNumbers: [80] }]),
        }
      },
      async sources() {
        await sleep(100)
        return {
          base: [{ file: String.raw`C:\Users\you\.kube\config`, contexts: ['kind-dev', 'minikube'] }],
          fromEnv: false,
          added: settings.kube_sources.map((path) => ({ path, folder: path === fakeProd, files: path === fakeProd ? [{ file: `${fakeProd}\\flake-prod-kubeconfig`, contexts: ['microk8s'] }, { file: `${fakeProd}\\flake-qa-kubeconfig`, contexts: ['microk8s'] }] : [] , error: path === fakeProd ? undefined : 'Not there any more.' })),
        }
      },
      async pickSource(kind) {
        await sleep(100)
        return kind === 'folder' ? fakeProd : null
      },
      async podDetails(_c, _ns, pod) {
        await sleep(150)
        const crashing = pod.startsWith('worker-')
        return {
          node: 'kind-dev-control-plane',
          ip: crashing ? '10.244.0.17' : '10.244.0.12',
          startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
          conditions: [
            { type: 'PodScheduled', ok: true },
            { type: 'Ready', ok: !crashing, reason: crashing ? 'ContainersNotReady' : undefined, message: crashing ? 'containers with unready status: [worker]' : undefined },
          ],
          containers: [
            crashing
              ? { name: 'worker', image: 'shop/worker:dev', ready: false, restarts: 7, state: 'waiting: CrashLoopBackOff', message: 'back-off 5m0s restarting failed container=worker', lastTermination: { reason: 'Error', exitCode: 1, finishedAt: new Date(Date.now() - 120_000).toISOString() }, ports: [] }
              : { name: 'web', image: 'shop/web:1.4.2', ready: true, restarts: 0, state: 'running', ports: [{ port: 8080, name: 'http', protocol: 'TCP' }] },
          ],
          events: crashing
            ? [
                { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container worker in pod ' + pod, count: 31, lastSeen: new Date(Date.now() - 60_000).toISOString() },
                { type: 'Normal', reason: 'Pulled', message: 'Container image "shop/worker:dev" already present on machine', count: 8, lastSeen: new Date(Date.now() - 300_000).toISOString() },
              ]
            : [],
        }
      },
      async exec(_c, _ns, pod, _k, opts, onData, onExit) {
        await sleep(200)
        const row = { id: pod + '00000000000', name: pod, image: 'shop/web:1.4.2' } as unknown as Parameters<typeof createFakeShell>[0]
        return createFakeShell(row, opts.shell === 'auto' ? '/bin/bash' : opts.shell, onData, onExit)
      },
      async forwards() {
        await sleep(50)
        return fakeForwards.map((f) => ({ ...f }))
      },
      async startForward(c, t, local) {
        await sleep(150)
        const localPort = local || 50000 + fakeForwardId
        if (fakeForwards.some((f) => f.localPort === localPort)) throw new ApiError(`Port ${localPort} on this computer is already in use. Pick another one.`)
        const f: KubeForward = { id: String(fakeForwardId++), context: c, ...t, localPort, startedAt: new Date().toISOString() }
        fakeForwards.push(f)
        return { ...f }
      },
      async stopForward(id) {
        const i = fakeForwards.findIndex((f) => f.id === id)
        if (i >= 0) fakeForwards.splice(i, 1)
      },
      async openForward() {},
      async act(_c, a) {
        await sleep(200)
        if (a.kind === 'scale-deployment') {
          fakeKubeScale.web = a.replicas
          return `Scaled ${a.name} to ${a.replicas} ${a.replicas === 1 ? 'pod' : 'pods'}.`
        }
        if (a.kind === 'restart-deployment') return `Restarting ${a.name}: new pods replace the old ones one by one.`
        if (a.kind === 'rollback-deployment') {
          fakeMore.webRevision = 4
          return `Rolling ${a.name} back to revision ${a.revision}: shop/web:1.4.${a.revision - 1}.`
        }
        if (a.kind === 'restart-statefulset') return `Restarting ${a.name}: its pods are replaced one at a time, highest number first.`
        if (a.kind === 'scale-statefulset') {
          fakeMore.dbReplicas = a.replicas
          return `Scaled ${a.name} to ${a.replicas} ${a.replicas === 1 ? 'pod' : 'pods'}.`
        }
        if (a.kind === 'suspend-cronjob') {
          fakeMore.nightlySuspended = a.suspend
          return a.suspend ? `Paused ${a.name}: no new runs until you resume it.` : `Resumed ${a.name}: it runs on its schedule again.`
        }
        if (a.kind === 'run-cronjob') {
          const job = `${a.name}-manual-${fakeMore.manualRuns.length + 1}`
          fakeMore.manualRuns.push(job)
          return `Started job ${job} from ${a.name}.`
        }
        fakeKubeDeleted.add(a.name)
        return `Deleted ${a.kind === 'delete' ? a.resource.replace(/s$/, '') : a.kind.slice(7)} ${a.name}.`
      },
      async list(_c, ns, kind) {
        await sleep(150)
        const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
        const items: Record<typeof kind, KubeItem[]> = {
          statefulsets: [{ name: 'db', namespace: 'shop', replicas: fakeMore.dbReplicas, createdAt: at(30), fields: { ready: `${fakeMore.dbReplicas}/${fakeMore.dbReplicas}`, images: 'postgres:16' } }],
          jobs: [
            { name: 'nightly-29012345', namespace: 'shop', createdAt: at(9), fields: { status: 'Complete', completions: '1/1', duration: '42s', owner: 'nightly' } },
            { name: 'migrate-v42', namespace: 'shop', createdAt: at(2), fields: { status: 'Failed', completions: '0/1', duration: '3m10s', owner: '' } },
            ...fakeMore.manualRuns.map((n) => ({ name: n, namespace: 'shop', createdAt: at(0), fields: { status: 'Running', completions: '0/1', duration: '2s', owner: 'nightly' } })),
          ],
          cronjobs: [{ name: 'nightly', namespace: 'shop', suspended: fakeMore.nightlySuspended, createdAt: at(200), fields: { schedule: '0 3 * * *', timeZone: '', active: '0', lastSchedule: at(9) } }],
          ingresses: [{ name: 'web', namespace: 'shop', createdAt: at(50), fields: { class: 'nginx', hosts: 'shop.localtest.me', address: '192.168.49.2', ports: '80, 443' } }],
          configmaps: [{ name: 'web-config', namespace: 'shop', createdAt: at(50), fields: { keys: 'LOG_LEVEL, app.yaml', count: '2' } }],
          secrets: [{ name: 'db-password', namespace: 'shop', createdAt: at(50), fields: { type: 'Opaque', keys: 'password, username', count: '2' } }],
        }
        return items[kind].filter((x) => (ns === '*' || x.namespace === ns) && !fakeKubeDeleted.has(x.name))
      },
      async localClusters() {
        await sleep(150)
        return { tools: ['kind', 'k3d'] as LocalClusterTool[], clusters: structuredClone(localClusters) }
      },
      localCluster(tool, action, name, onLines) {
        const runId = rid()
        let cancelled = false
        pulls.set(runId, { cancel: () => (cancelled = true) })
        const done = (async () => {
          try {
            const steps =
              action === 'create'
                ? [`Creating cluster "${name}" ...`, ' • Ensuring node image (kindest/node:v1.31.0) 🖼', ' • Preparing nodes 📦', ' • Writing configuration 📜', ' • Starting control-plane 🕹️', ` Set kubectl context to "${tool}-${name}"`]
                : [`Deleting cluster "${name}" ...`, `Deleted nodes: ["${name}-control-plane"]`]
            for (const l of steps) {
              await sleep(200)
              if (cancelled) throw new ApiError('Stopped.', 499)
              onLines([l])
            }
            if (action === 'create') {
              if (localClusters.some((c) => c.tool === tool && c.name === name)) throw new ApiError(`node(s) already exist for a cluster with the name "${name}"`, 422)
              localClusters.push({ tool, name, context: tool === 'minikube' ? name : `${tool}-${name}`, running: tool === 'kind' ? undefined : true })
            } else localClusters = localClusters.filter((c) => !(c.tool === tool && c.name === name))
          } finally {
            pulls.delete(runId)
          }
        })()
        return { runId, done }
      },
      async cancelLocalCluster(runId) {
        pulls.get(runId)?.cancel()
      },
      async helmReleases(_c, ns) {
        await sleep(120)
        const all = helmRels.map((r) => ({ ...r.history[0], name: r.name, namespace: r.namespace, revisions: r.history.length }))
        return ns === '*' ? all : all.filter((r) => r.namespace === ns)
      },
      async helmHistory(_c, ns, name) {
        await sleep(100)
        return structuredClone(helmRels.find((r) => r.namespace === ns && r.name === name)?.history ?? [])
      },
      async helmValues(_c, ns, name, rev) {
        await sleep(100)
        const r = helmRels.find((x) => x.namespace === ns && x.name === name)
        if (!r?.history.some((h) => h.revision === rev)) throw new ApiError(`Revision ${rev} of ${name} isn’t there any more.`, 404)
        return { values: { replicaCount: rev > 2 ? 3 : 2, image: { tag: rev > 2 ? '1.27.2' : '1.27.1' }, auth: { enabled: true, password: '••••' } }, notes: 'Get the URL with: kubectl get svc web-nginx' }
      },
      async helmRollback(_c, ns, name, rev) {
        await sleep(600)
        const r = helmRels.find((x) => x.namespace === ns && x.name === name)
        const from = r?.history.find((h) => h.revision === rev)
        if (!r || !from) throw new ApiError(`Revision ${rev} of ${name} isn’t there any more.`, 404)
        for (const h of r.history) if (h.status === 'deployed') h.status = 'superseded'
        r.history.unshift({ ...from, revision: r.history[0].revision + 1, status: 'deployed', updatedAt: now(), description: `Rollback to ${rev}` })
        return `Rolled ${name} back to revision ${rev}.`
      },
      async events(_c, ns) {
        await sleep(120)
        const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
        const all = [
          { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container worker in pod worker-5c6d7f8-abcde', kind: 'Pod', name: 'worker-5c6d7f8-abcde', namespace: 'shop', count: 41, lastSeen: ago(1) },
          { type: 'Normal', reason: 'Pulled', message: 'Container image "shop/web:1.4.2" already present on machine', kind: 'Pod', name: 'web-7d9f8b6c5-x2k4p', namespace: 'shop', count: 1, lastSeen: ago(12) },
          { type: 'Warning', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', kind: 'Job', name: 'migrate-v42', namespace: 'shop', count: 1, lastSeen: ago(30) },
          { type: 'Normal', reason: 'ScalingReplicaSet', message: 'Scaled up replica set web-7d9f8b6c5 to 1', kind: 'Deployment', name: 'web', namespace: 'shop', count: 1, lastSeen: ago(180) },
        ]
        return all.filter((e) => ns === '*' || e.namespace === ns)
      },
      async rollouts(_c, _ns, name) {
        await sleep(120)
        if (name !== 'web') return [{ revision: 1, current: true, images: ['shop/worker:dev'], createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(), pods: 1 }]
        const cur = fakeMore.webRevision
        return [4, 3, 2]
          .filter((r) => r <= cur)
          .map((r) => ({ revision: r, current: r === cur, images: [`shop/web:1.4.${r === 4 ? 1 : r - 1}`], changeCause: r === 3 ? 'deploy 1.4.2' : undefined, createdAt: new Date(Date.now() - (5 - r) * 86400_000).toISOString(), pods: r === cur ? fakeKubeScale.web : 0 }))
      },
      async usage(c, ns) {
        await sleep(100)
        if (c !== 'kind-dev') return null
        const u = { 'shop/web-7d9f8b6c5-x2k4p': { cpuMilli: 12, memoryBytes: 84 * 2 ** 20 }, 'shop/worker-5c6d7f8-abcde': { cpuMilli: 0, memoryBytes: 3 * 2 ** 20 }, 'kube-system/coredns-5d78c9869d-q8rlz': { cpuMilli: 3, memoryBytes: 19 * 2 ** 20 } }
        return Object.fromEntries(Object.entries(u).filter(([k]) => ns === '*' || k.startsWith(`${ns}/`)))
      },
      async yaml(_c, kind, ns, name) {
        await sleep(100)
        const secret = kind === 'secrets'
        return `apiVersion: v1\nkind: ${secret ? 'Secret' : kind === 'pods' ? 'Pod' : 'Object'}\nmetadata:\n  name: ${name}\n  namespace: ${ns}\n${secret ? 'data:\n  password: (hidden)\n  username: (hidden)\ntype: Opaque\n' : 'spec:\n  replicas: 1\n'}`
      },
      async data(_c, _ns, kind) {
        await sleep(100)
        return kind === 'configmaps'
          ? { entries: [{ key: 'LOG_LEVEL', bytes: 4, value: 'info' }, { key: 'app.yaml', bytes: 31, value: 'port: 8080\nfeatures:\n  search: true' }] }
          : { type: 'Opaque', entries: [{ key: 'password', bytes: 24 }, { key: 'username', bytes: 4 }] }
      },
      logs(_c, _n, pod, _k, onEvent, opts) {
        if (opts?.previous) {
          const t = setTimeout(() => onEvent({ type: 'lines', lines: [`${pod} starting`, 'Error: connect ECONNREFUSED 10.96.0.15:5432', 'worker exited with code 1'] }), 100)
          return () => clearTimeout(t)
        }
        let i = 0
        const timer = setInterval(() => onEvent({ type: 'lines', lines: [`${pod} line ${++i}`] }), 150)
        return () => clearInterval(timer)
      },
    },
    resources: {
      async status() {
        await sleep(200)
        return { ...fakeResources, disks: fakeResources.disks.map((d) => ({ ...d })) }
      },
      async act(a) {
        await sleep(200)
        if (a.kind === 'reclaim') fakeResources.memory.reclaim = a.mode
        if (a.kind === 'limit') fakeResources.memory.limit = a.gb ? `${a.gb}GB` : null
        if (a.kind === 'sparse-default') fakeResources.sparseByDefault = a.on
        if (a.kind === 'make-sparse') fakeResources.disks = fakeResources.disks.map((d) => (d.distro === a.distro ? { ...d, sparse: true } : d))
        if (a.kind === 'trim') fakeResources.disks = fakeResources.disks.map((d) => (d.distro === a.distro ? { ...d, fileBytes: d.usedBytes ?? d.fileBytes } : d))
        if (a.kind === 'prune-build-cache') fakeResources.buildCache = { total: 0, reclaimable: 0 }
        return a.kind === 'trim' ? '/: 4.2 GiB (4509715660 bytes) trimmed' : 'Saved.'
      },
    },
    doctor: {
      async check() {
        await sleep(400)
        return [
          { id: 'wsl', area: 'wsl', title: 'WSL is up to date enough', status: 'ok', detail: 'WSL 2.6.3' },
          { id: 'distro', area: 'wsl', title: 'Ubuntu is running', status: 'ok', detail: 'Ubuntu 24.04.1 LTS' },
          { id: 'systemd', area: 'wsl', title: 'systemd runs in Ubuntu', status: 'ok' },
          fakeDoctorFixed
            ? { id: 'engine', area: 'engine', title: 'Docker Engine runs in Ubuntu', status: 'ok', detail: 'Docker 29.4.3' }
            : { id: 'engine', area: 'engine', title: 'Docker in Ubuntu lost its socket', status: 'fail', detail: 'Docker Desktop removes /var/run/docker.sock when it quits.', fix: { id: 'repair-socket', label: 'Repair Docker in Ubuntu', distro: 'Ubuntu', note: 'Restarts Docker there.' } },
          { id: 'dns', area: 'network', title: 'Ubuntu cannot resolve Docker Hub', status: 'fail', detail: 'Pulls will fail.', fix: { id: 'dns-tunneling', label: 'Turn on DNS tunneling' } },
          { id: 'pipe', area: 'windows', title: 'Windows tools can reach the engine', status: 'ok', detail: '//./pipe/docker_engine → Ubuntu' },
          { id: 'cli', area: 'windows', title: 'No Docker CLI on Windows', status: 'info', link: { label: 'Install it', route: 'settings' } },
        ]
      },
      async fix(id) {
        await sleep(300)
        if (id === 'repair-socket') fakeDoctorFixed = true
        return id === 'repair-socket' ? 'Docker in Ubuntu has its socket back.' : 'Done.'
      },
    },
    setup: {
      async distros() {
        await sleep(150)
        return [
          { name: 'Ubuntu', isDefault: true, running: true, version: 2 },
          { name: 'Debian', isDefault: false, running: false, version: 2 },
        ]
      },
      async inspect(name) {
        await sleep(250)
        return name === 'Ubuntu'
          ? { name, os: 'Ubuntu 24.04.1 LTS', supported: true, systemd: false, docker: 'none', user: 'you' }
          : { name, os: 'Debian GNU/Linux 12 (bookworm)', supported: true, systemd: true, docker: 'running', user: 'you' }
      },
      install(_name, onEvent) {
        const script: WslSetupEvent[] = [
          { type: 'step', step: 'systemd', status: 'working' },
          { type: 'line', line: 'systemd turned on in /etc/wsl.conf' },
          { type: 'step', step: 'systemd', status: 'done', detail: 'restarted the distribution with systemd' },
          { type: 'step', step: 'packages', status: 'working' },
          { type: 'line', line: 'Setting up docker-ce (5:29.4.3-1~ubuntu.24.04~noble) ...' },
          { type: 'step', step: 'packages', status: 'done' },
          { type: 'step', step: 'group', status: 'working' },
          { type: 'step', step: 'group', status: 'done', detail: 'added you to the docker group' },
          { type: 'step', step: 'service', status: 'working' },
          { type: 'step', step: 'service', status: 'done' },
          { type: 'step', step: 'check', status: 'working' },
          { type: 'step', step: 'check', status: 'done', detail: 'Docker 29.4.3 answers' },
          { type: 'done' },
        ]
        let i = 0
        const timer = setInterval(() => (i < script.length ? onEvent(script[i++]) : clearInterval(timer)), 60)
        return () => clearInterval(timer)
      },
    },
    tools: {
      async status() {
        await sleep(200)
        return { ...fakeTools }
      },
      installCli(onStep) {
        const steps = ['cli', 'compose', 'buildx', 'path'] as const
        let i = 0
        const timer = setInterval(() => {
          if (i < steps.length * 2) {
            const step = steps[i >> 1]
            onStep({ type: 'step', step, status: i % 2 ? 'done' : 'working', detail: i % 2 ? '29.4.3' : undefined })
            i++
            return
          }
          fakeTools = { ...fakeTools, cli: { path: String.raw`C:\Users\you\AppData\Local\Tender\bin\docker.exe`, version: '29.4.3', own: true }, compose: '5.1.3', buildx: 'v0.30.1', binOnPath: true }
          onStep({ type: 'done' })
          clearInterval(timer)
        }, 80)
        return () => clearInterval(timer)
      },
      async useDefaultContext() {
        fakeTools = { ...fakeTools, context: 'default', contextUsesPipe: true }
      },
    },
    migrate: {
      async check() {
        await sleep(300)
        return { desktopInstalled: true, source: { ok: true, version: '29.4.3', containers: 9 }, target: { ok: true, distro: 'Ubuntu', version: '28.5.1' } }
      },
      async plan() {
        await sleep(300)
        return { items: fakeMigrationPlan }
      },
      run(_distro, ids, opts, onEvent) {
        // Plays a short, believable move: every chosen item's images, volumes, containers.
        const chosen = fakeMigrationPlan.filter((i) => ids.includes(i.id))
        const script: MigrationEvent[] = []
        const steps: [MigrationStep, string[]][] = [
          ['images', [...new Set(chosen.flatMap((i) => i.images))]],
          ['volumes', [...new Set(chosen.flatMap((i) => i.volumes))]],
          ['containers', chosen.flatMap((i) => i.containers)],
        ]
        let moved = 0
        let skipped = 0
        for (const [step, names] of steps) {
          if (!names.length) continue
          script.push({ type: 'step', step, total: names.length })
          for (const name of names) {
            const taken = chosen.some((i) => i.conflicts.includes(name))
            script.push({ type: 'item', step, name, status: 'working' })
            if (step !== 'containers' && !taken) script.push({ type: 'bytes', name, done: 50, total: 100 })
            script.push({ type: 'item', step, name, status: taken ? 'skipped' : 'done', message: taken ? 'already there' : undefined })
            taken ? skipped++ : moved++
          }
        }
        if (opts.start) script.push({ type: 'step', step: 'start', total: 0 })
        script.push({ type: 'done', moved, skipped, failed: 0 })
        let i = 0
        const timer = setInterval(() => {
          if (i >= script.length) return clearInterval(timer)
          onEvent(script[i++])
        }, 60)
        return () => clearInterval(timer)
      },
      async repairSocket() {
        await sleep(300)
      },
    },
    platform: /Windows/.test(navigator.userAgent) ? 'win32' : /Mac OS/.test(navigator.userAgent) ? 'darwin' : 'linux',
    engine: {
      async options() {
        await up()
        return [
          { choice: 'auto', label: 'Automatic', detail: 'Like the Docker CLI: now npipe:////./pipe/docker_engine, with WSL as a fallback on Windows' },
          { choice: 'wsl://Ubuntu', label: 'WSL: Ubuntu', detail: 'Docker inside this distribution' },
          { choice: 'context://staging', label: 'Context: staging', detail: 'ssh://deploy@staging.example.internal' },
          ...(/^(tcp|ssh|unix|npipe):\/\//.test(settings.engine_choice) ? [{ choice: settings.engine_choice, label: 'Custom address', detail: settings.engine_choice }] : []),
        ]
      },
      async use(choice) {
        await up(300)
        if (!/^(auto|wsl:\/\/[\w.-]+|context:\/\/[\w.-]+|(tcp|ssh|unix|npipe):\/\/.+)$/.test(choice)) throw new ApiError('Use an address like tcp://host:2375, ssh://user@host, unix:///path or npipe:////./pipe/name.', 400)
        settings.engine_choice = choice
        setEngine({ state: 'running', endpoint: choice === 'auto' ? '//./pipe/docker_engine' : choice })
        return engine
      },
      async status() {
        await sleep(80)
        return { ...engine, containersRunning: containers.filter((c) => c.state === 'running').length }
      },
      async repairWsl() {
        setEngine({ state: 'starting', error: undefined, repair: undefined })
        await sleep(800)
        setEngine({ state: 'running' })
        return engine
      },
      async restartWsl() {
        setEngine({ state: 'starting', error: undefined, wslStuck: undefined })
        await sleep(800)
        setEngine({ state: 'running' })
        return engine
      },
      async reconnect() {
        setEngine({ state: 'starting', error: undefined })
        await sleep(1200)
        setEngine({ state: 'running' })
        return engine
      },
      onStatus(cb) {
        statusSubs.add(cb)
        return () => statusSubs.delete(cb)
      },
      onEvents(cb) {
        eventSubs.add(cb)
        return () => eventSubs.delete(cb)
      },
    },

    containers: {
      async list() {
        await up()
        return structuredClone(containers)
      },
      async inspect(id) {
        await up()
        const c = byId(id)
        return {
          Id: c.id + rid() + rid() + rid(),
          Name: '/' + c.name,
          Created: c.createdAt,
          Path: c.command.split(' ')[0],
          Args: c.command.split(' ').slice(1),
          State: {
            Status: c.state,
            Running: c.state === 'running',
            Paused: c.state === 'paused',
            Restarting: c.state === 'restarting',
            ExitCode: c.exitCode ?? 0,
            StartedAt: c.startedAt,
          },
          Image: c.imageId,
          Config: { Image: c.image, Env: c.env, Cmd: c.command.split(' '), Labels: c.labels },
          HostConfig: {
            RestartPolicy: { Name: c.project ? 'unless-stopped' : 'no' },
            PortBindings: Object.fromEntries(c.ports.map((p) => [`${p.privatePort}/${p.protocol}`, [{ HostIp: p.hostIp ?? '', HostPort: String(p.publicPort ?? '') }]])),
          },
          Mounts: c.mounts.map((m) => ({ Type: m.type, Source: m.source, Destination: m.destination, RW: m.rw })),
          NetworkSettings: { Networks: { [c.project ? `${c.project}_default` : 'bridge']: { IPAddress: c.state === 'running' ? '172.18.0.' + (2 + containers.indexOf(c)) : '' } } },
        }
      },
      async action(ids, action) {
        await up()
        return Promise.all(ids.map((id) => act(byId(id), action)))
      },
      remove: removeContainers,
      async runCommand(id) {
        const c = byId(id)
        const parts = ['docker run -d', `--name ${c.name}`]
        for (const p of c.ports) if (p.publicPort) parts.push(`-p ${p.hostIp && p.hostIp !== '0.0.0.0' ? p.hostIp + ':' : ''}${p.publicPort}:${p.privatePort}${p.protocol === 'udp' ? '/udp' : ''}`)
        for (const m of c.mounts) parts.push(`-v ${m.source}:${m.destination}${m.rw ? '' : ':ro'}`)
        for (const e of c.env) parts.push(`-e ${e.includes(' ') ? JSON.stringify(e) : e}`)
        parts.push(c.image)
        return parts.join(' \\\n  ')
      },
      async openPort(p) {
        window.open(`http://localhost:${p.publicPort}`, '_blank', 'noopener')
      },
    },

    logs: {
      subscribe(id, { tail }, cb) {
        const set = logSubs.get(id) ?? new Set()
        set.add(cb)
        logSubs.set(id, set)
        queueMicrotask(() => cb((logs.get(id) ?? []).slice(-tail)))
        return () => set.delete(cb)
      },
    },

    stats: {
      subscribe(ids, cb) {
        const sub = { ids: new Set(ids), cb }
        statSubs.add(sub)
        return () => statSubs.delete(sub)
      },
    },

    exec: {
      async open(id, opts, onData, onExit) {
        await up(300)
        const c = byId(id)
        if (c.state !== 'running') throw new ApiError(`${c.name} isn’t running. Start it to open a terminal.`, 409)
        if (flavour(c.image) === 'collector') throw new ApiError('This image has no shell (/bin/sh not found).', 404)
        return createFakeShell(c, opts.shell, onData, onExit)
      },
    },

    compose: {
      async action(project, action) {
        await up()
        return Promise.all(containers.filter((c) => c.project === project).map((c) => act(c, action)))
      },
      async remove(project) {
        return removeContainers(containers.filter((c) => c.project === project).map((c) => c.id), true)
      },
    },

    images: {
      async list() {
        await up()
        refreshUsage()
        return structuredClone(images)
      },
      async inspect(id) {
        await up()
        const image = images.find((i) => i.id === id)
        if (!image) throw new ApiError(`No such image: ${id}`, 404)
        const f = flavour(image.tags[0] ?? '')
        return {
          image: structuredClone(image),
          layers: seedLayers(image),
          env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
          cmd: { nginx: 'nginx -g "daemon off;"', node: 'node', postgres: 'postgres', redis: 'redis-server' }[f] ?? '/bin/sh',
          exposedPorts: { nginx: ['80/tcp'], postgres: ['5432/tcp'], redis: ['6379/tcp'] }[f] ?? [],
        }
      },
      async diskUsage() {
        await up(400)
        refreshUsage()
        const total = images.reduce((s, i) => s + i.size, 0)
        // Base layers are shared between some images, so reclaim < sum of sizes.
        const sharedSize = Object.fromEntries(images.map((i) => [i.id, i.tags.some((t) => /node|python|migrate|worker/.test(t)) ? Math.round(i.size * 0.3) : 0]))
        const reclaimable = images.filter((i) => !i.inUse).reduce((s, i) => s + i.size - sharedSize[i.id], 0)
        return { imagesTotal: total, imagesReclaimable: reclaimable, sharedSize }
      },
      pull(reference, onProgress) {
        const ref = reference.includes(':') || reference.includes('@') ? reference : `${reference}:latest`
        const pullId = rid()
        // A second pull of the same reference joins the first (pull_history_one_active).
        const existing = activePullByRef.get(ref)
        if (existing) return { pullId: existing, done: Promise.reject(new ApiError(`${ref} is already being pulled.`, 409)) }
        activePullByRef.set(ref, pullId)
        let cancelled = false
        pulls.set(pullId, { cancel: () => (cancelled = true) })
        const done = (async () => {
          try {
            await up(300)
            if (!/^[a-z0-9]+([._\/-][a-z0-9]+)*(:[\w][\w.-]{0,127}|@sha256:[a-f0-9]{8,})$/.test(ref)) throw new ApiError(`“${reference}” isn’t a valid image reference.`, 400)
            if (/doesnotexist|ngnix|notfound/.test(ref)) throw new ApiError(`No image called ${ref} exists in the registry.`, 404)
            if (ref.startsWith('private/') && !logins.has('docker.io')) throw new ApiError(`${ref} needs a login. Add one for docker.io in Settings › Registries, then try again.`, 401)
            const n = 3 + Math.floor(Math.random() * 3)
            const layers: LayerProgress[] = Array.from({ length: n }, () => ({ id: rid().slice(0, 12), status: 'waiting' as const, total: Math.round((5 + Math.random() * 40) * 1e6), current: 0 }))
            onProgress(structuredClone(layers))
            while (layers.some((l) => l.status !== 'done')) {
              await sleep(180)
              if (cancelled) throw new ApiError('Pull cancelled.', 499)
              // Like the engine: up to three layers download at once, the rest wait.
              const active = layers.filter((l) => l.status === 'downloading').length
              let slots = 3 - active
              for (const l of layers) {
                if (l.status === 'waiting' && slots > 0) {
                  l.status = 'downloading'
                  slots--
                } else if (l.status === 'downloading') {
                  l.current = Math.min(l.total!, (l.current ?? 0) + l.total! * (0.12 + Math.random() * 0.2))
                  if (l.current >= l.total!) l.status = 'extracting'
                } else if (l.status === 'extracting' && Math.random() < 0.5) l.status = 'done'
              }
              onProgress(structuredClone(layers))
            }
            const size = layers.reduce((s, l) => s + (l.total ?? 0), 0)
            const existingImg = images.find((i) => i.tags.includes(ref))
            if (existingImg) existingImg.createdAt = now()
            else images.unshift({ id: 'sha256:' + rid(), tags: [ref], size, createdAt: now(), arch: 'amd64', emulated: false, inUse: false, dangling: false })
            emit({ type: 'image', action: 'pull', id: ref })
            notify({ kind: 'success', title: `Pulled ${ref}`, body: `${n} layers, ${(size / 1e6).toFixed(1)} MB` })
          } finally {
            pulls.delete(pullId)
            activePullByRef.delete(ref)
          }
        })()
        return { pullId, done }
      },
      async cancelPull(pullId) {
        pulls.get(pullId)?.cancel()
      },
      async tag(id, reference) {
        await up(200)
        const img = images.find((i) => i.id === id || i.tags.includes(id))
        if (!img) throw new ApiError(`No such image: ${id}`, 404)
        const { repo, tag } = splitRef(reference)
        const full = `${repo}:${tag}`
        for (const other of images) other.tags = other.tags.filter((t) => t !== full)
        img.tags = [...img.tags, full]
        img.dangling = false
        emit({ type: 'image', action: 'tag', id: img.id })
      },
      push(reference, progress) {
        const pushId = rid()
        let cancelled = false
        pulls.set(pushId, { cancel: () => (cancelled = true) })
        const done = (async () => {
          try {
            await up(300)
            const { repo, tag } = splitRef(reference)
            const full = `${repo}:${tag}`
            const img = images.find((i) => i.tags.includes(full))
            if (!img) throw new ApiError(`There is no image called ${full} on this machine. Tag it first.`, 404)
            const reg = registryOf(repo)
            const login = logins.get(reg)
            if (!login && reg !== 'localhost:5000') throw new ApiError(`Pushing to ${reg} needs a login. Add one in Settings › Registries, then try again.`, 401)
            if (login && reg === 'docker.io' && !repo.startsWith(`${login.username}/`))
              throw new ApiError(`The registry refused the push. The login for ${reg} may not be allowed to write to ${repo}.`, 401)
            const layers: LayerProgress[] = seedLayers(img)
              .filter((l) => l.size > 0)
              .map((l, i) => ({ id: rid().slice(0, 12), status: i === 0 ? ('done' as const) : ('waiting' as const), total: l.size, current: i === 0 ? l.size : 0 }))
            progress(structuredClone(layers))
            while (layers.some((l) => l.status !== 'done')) {
              await sleep(160)
              if (cancelled) throw new ApiError('Push cancelled.', 499)
              for (const l of layers) {
                if (l.status === 'waiting') l.status = 'downloading'
                else if (l.status === 'downloading') {
                  l.current = Math.min(l.total!, (l.current ?? 0) + l.total! * 0.35)
                  if (l.current >= l.total!) l.status = 'done'
                }
              }
              progress(structuredClone(layers))
            }
            notify({ kind: 'success', title: `Pushed ${full}` })
          } finally {
            pulls.delete(pushId)
          }
        })()
        return { pullId: pushId, done }
      },
      async cancelPush(pushId) {
        pulls.get(pushId)?.cancel()
      },
      scan(reference, onPhase) {
        const scanId = rid()
        let cancelled = false
        pulls.set(scanId, { cancel: () => (cancelled = true) })
        const done = (async () => {
          try {
            await up(200)
            const img = images.find((i) => i.tags.includes(reference) || i.id === reference)
            if (!img) throw new ApiError(`No such image: ${reference}`, 404)
            for (const phase of ['scanner', 'database', 'scanning'] as const) {
              onPhase(phase)
              await sleep(phase === 'scanning' ? 500 : 250)
              if (cancelled) throw new ApiError('Scan cancelled.', 499)
            }
            // Made-up findings, so every screen state can be built; IDs follow the CVE format but mean nothing.
            const clean = /busybox|alpine|distroless/.test(reference)
            const v = (id: string, pkg: string, installed: string, severity: Severity, fixed?: string, target = 'debian 12.7 (os)'): Vulnerability => ({
              id, pkg, installed, fixed, severity, target, title: `Example finding in ${pkg}`, url: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
            })
            const vulnerabilities = clean
              ? []
              : [
                  v('CVE-2099-0001', 'openssl', '3.0.14-1', 'CRITICAL', '3.0.15-1'),
                  v('CVE-2099-0002', 'libexpat1', '2.5.0-1', 'HIGH', '2.5.0-1+deb12u1'),
                  v('CVE-2099-0003', 'zlib1g', '1:1.2.13', 'HIGH'),
                  v('CVE-2099-0004', 'curl', '7.88.1-10', 'MEDIUM', '7.88.1-10+deb12u8'),
                  v('CVE-2099-0005', 'tar', '1.34', 'LOW'),
                  v('CVE-2099-0006', 'braces', '3.0.2', 'HIGH', '3.0.3', 'app/package-lock.json'),
                  v('CVE-2099-0007', 'perl-base', '5.36.0-7', 'UNKNOWN'),
                ]
            const order: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']
            const counts = Object.fromEntries(order.map((x) => [x, vulnerabilities.filter((y) => y.severity === x).length])) as Record<Severity, number>
            return { image: reference, scannedAt: now(), scanner: 'aquasec/trivy:0.57.1', vulnerabilities, counts }
          } finally {
            pulls.delete(scanId)
          }
        })()
        return { scanId, done }
      },
      async cancelScan(scanId) {
        pulls.get(scanId)?.cancel()
      },
      async openAdvisory() {
        // The browser build has nowhere to open it.
      },
      async remove(ids, force) {
        await up(300)
        refreshUsage()
        return ids.map((id) => {
          const img = images.find((i) => i.id === id)
          if (!img) return { id, ok: true }
          if (img.inUse && !force) {
            const users = containers.filter((c) => c.imageId === id).map((c) => c.name)
            return { id, ok: false, error: `In use by ${users.join(', ')}. Remove ${users.length > 1 ? 'those containers' : 'that container'} first.` }
          }
          images = images.filter((i) => i !== img)
          emit({ type: 'image', action: 'delete', id })
          return { id, ok: true }
        })
      },
      async prune(scope) {
        await up(600)
        refreshUsage()
        const gone = images.filter((i) => (scope === 'dangling' ? i.dangling : !i.inUse))
        images = images.filter((i) => !gone.includes(i))
        if (gone.length) emit(...gone.map((i) => ({ type: 'image' as const, action: 'delete', id: i.id })))
        return { deleted: gone.map((i) => i.tags[0] ?? i.id.slice(7, 19)), spaceReclaimed: gone.reduce((s, i) => s + i.size, 0) }
      },
      async run(spec) {
        await up(500)
        const img = images.find((i) => i.tags.includes(spec.image) || i.id === spec.image)
        if (!img) throw new ApiError(`Image ${spec.image} isn’t on this machine. Pull it first.`, 404)
        const name = spec.name?.trim() || `${(img.tags[0] ?? 'container').split(/[/:]/).slice(-2, -1)[0] ?? 'container'}-${rid().slice(0, 4)}`
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new ApiError('Names can use letters, digits, dots, dashes and underscores, and must start with a letter or digit.', 400)
        if (containers.some((c) => c.name === name)) throw new ApiError(`A container called ${name} already exists.`, 409)
        for (const p of spec.ports) {
          const taken = containers.find((c) => c.state === 'running' && c.ports.some((q) => String(q.publicPort) === p.host))
          if (taken) throw new ApiError(`Host port ${p.host} is already used by ${taken.name}.`, 409)
        }
        const c: ContainerRow = {
          id: rid() + rid(),
          name,
          image: img.tags[0] ?? img.id,
          imageId: img.id,
          command: '/docker-entrypoint.sh',
          state: 'running',
          createdAt: now(),
          startedAt: now(),
          ports: spec.ports.map((p) => ({ privatePort: Number(p.container), publicPort: Number(p.host), hostIp: '0.0.0.0', protocol: 'tcp' })),
          mounts: spec.volumes.map((v) => ({ type: /[\\/:]/.test(v.source) ? 'bind' : 'volume', source: v.source, destination: v.target, rw: true })),
          env: spec.env.map((e) => `${e.key}=${e.value}`),
          labels: {},
        }
        for (const v of spec.volumes) {
          if (!/[\\/:]/.test(v.source) && !volumes.some((x) => x.name === v.source)) {
            volumes.push({ name: v.source, driver: 'local', createdAt: now(), size: 0, usedBy: [] })
            emit({ type: 'volume', action: 'create', id: v.source })
          }
        }
        containers.unshift(c)
        refreshUsage()
        pushLog(c.id, (bootLines[flavour(c.image)] ?? bootLines.default).map((text) => ({ ts: now(), stream: 'stdout', text })))
        emit({ type: 'container', action: 'create', id: c.id }, { type: 'container', action: 'start', id: c.id })
        return { containerId: c.id }
      },
    },

    volumes: {
      async list() {
        await up()
        refreshUsage()
        return structuredClone(volumes)
      },
      async create(name) {
        await up(250)
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) throw new ApiError('Use at least two characters: letters, digits, dots, dashes or underscores, starting with a letter or digit.', 400)
        if (volumes.some((v) => v.name === name)) throw new ApiError(`A volume called ${name} already exists.`, 409)
        const v = { name, driver: 'local', createdAt: now(), size: 0, usedBy: [] }
        volumes.unshift(v)
        emit({ type: 'volume', action: 'create', id: name })
        return v
      },
      async remove(names) {
        await up(300)
        refreshUsage()
        return names.map((name) => {
          const v = volumes.find((x) => x.name === name)
          if (!v) return { id: name, ok: true }
          if (v.usedBy.length) return { id: name, ok: false, usedBy: v.usedBy, error: `In use by ${v.usedBy.join(', ')}.` }
          volumes = volumes.filter((x) => x !== v)
          emit({ type: 'volume', action: 'destroy', id: name })
          return { id: name, ok: true }
        })
      },
      async exportTo(name) {
        await up(400)
        const v = volumes.find((x) => x.name === name)
        if (!v) throw new ApiError(`There is no volume called ${name}.`, 404)
        return { file: `${String.raw`C:\Users\you\Documents`}\\${name}-${now().slice(0, 10)}.tar.gz`, bytes: Math.round(v.size * 0.35) }
      },
      async restoreFrom(name) {
        await up(500)
        refreshUsage()
        const busy = containers.filter((c) => (c.state === 'running' || c.state === 'paused' || c.state === 'restarting') && c.mounts.some((m) => m.type === 'volume' && m.source === name))
        if (busy.length) throw new ApiError(`${busy.map((c) => c.name).join(', ')} ${busy.length === 1 ? 'is' : 'are'} using ${name}. Stop ${busy.length === 1 ? 'it' : 'them'} first, then restore.`, 409)
        let v = volumes.find((x) => x.name === name)
        if (!v) {
          v = { name, driver: 'local', createdAt: now(), size: 0, usedBy: [] }
          volumes.unshift(v)
          emit({ type: 'volume', action: 'create', id: name })
        }
        v.size += 48_000_000
        return { file: `${String.raw`C:\Users\you\Documents`}\\${name}-backup.tar.gz` }
      },
      async usage(name) {
        await up()
        return containers
          .filter((c) => c.mounts.some((m) => m.type === 'volume' && m.source === name))
          .map((c) => ({
            containerId: c.id,
            containerName: c.name,
            image: c.image,
            target: c.mounts.find((m) => m.source === name)!.destination,
            ports: c.ports.map((p) => (p.publicPort ? `${p.publicPort}:${p.privatePort}` : String(p.privatePort))).join(', '),
          }))
      },
    },

    composeFiles: {
      async list() {
        await up()
        const running = new Set(containers.map((c) => c.project).filter(Boolean))
        const paths = Object.entries(composeDefs)
          .filter(([path, d]) => savedCompose.has(path) || running.has(d.project))
          .map(([path]) => path)
        return paths.map(describeCompose)
      },
      async get(path) {
        await up()
        return describeCompose(path)
      },
      async add() {
        await up(150)
        const path = String.raw`C:\code\shop\compose.yaml`
        savedCompose.add(path)
        return describeCompose(path)
      },
      async forget(path) {
        await up(100)
        savedCompose.delete(path)
      },
      run(path, command, service, onLines) {
        const runId = rid()
        let cancelled = false
        pulls.set(runId, { cancel: () => (cancelled = true) })
        const done = (async () => {
          try {
            await up(200)
            const def = composeDefs[path]
            if (!def) throw new ApiError('The file isn’t there any more.', 404)
            if (command === 'down' && service) throw new ApiError('Down takes the whole project. To remove one service, stop it.', 400)
            const names = service ? [service] : Object.keys(def.services)
            const say = async (...lines: string[]) => {
              await sleep(140)
              if (cancelled) throw new ApiError('Stopped.', 499)
              onLines(lines)
            }
            const cname = (n: string) => `${def.project}-${n}-1`
            for (const n of names) {
              const sv = def.services[n]
              if (!sv) throw new ApiError(`no such service: ${n}`, 422)
              const existing = containers.filter((c) => c.project === def.project && c.service === n)
              const imageRef = sv.image ?? `${def.project}-${n}:latest`
              if (command === 'pull') {
                if (!sv.image) await say(` ${n} Skipped - No image to be pulled`)
                else {
                  await say(` ${n} Pulling`)
                  if (!images.some((i) => i.tags.includes(imageRef))) {
                    images.unshift({ id: 'sha256:' + rid(), tags: [imageRef], size: 400_000_000, createdAt: now(), arch: 'amd64', emulated: false, inUse: false, dangling: false })
                    emit({ type: 'image', action: 'pull', id: imageRef })
                  }
                  await say(` ${n} Pulled`)
                }
              } else if (command === 'build') {
                if (!sv.build) await say(` ${n} Skipped - No build section`)
                else {
                  await say(`#1 [${n} internal] load build definition from Dockerfile`, `#5 [${n} 2/3] RUN npm ci`, `#5 DONE 1.4s`)
                  if (!images.some((i) => i.tags.includes(imageRef))) images.unshift({ id: 'sha256:' + rid(), tags: [imageRef], size: 180_000_000, createdAt: now(), arch: 'amd64', emulated: false, inUse: false, dangling: false })
                  emit({ type: 'image', action: 'build', id: imageRef })
                  await say(` Service ${n}  Built`)
                }
              } else if (command === 'up') {
                if (!existing.length) {
                  if (!images.some((i) => i.tags.includes(imageRef))) {
                    await say(` ${n} Pulling`)
                    images.unshift({ id: 'sha256:' + rid(), tags: [imageRef], size: 300_000_000, createdAt: now(), arch: 'amd64', emulated: false, inUse: false, dangling: false })
                    await say(` ${n} Pulled`)
                  }
                  const img = images.find((i) => i.tags.includes(imageRef))!
                  const c: ContainerRow = {
                    id: rid() + rid(),
                    name: cname(n),
                    image: imageRef,
                    imageId: img.id,
                    command: sv.command,
                    state: 'running',
                    createdAt: now(),
                    startedAt: now(),
                    ports: sv.ports.map((x) => {
                      const [pub, priv] = x.split(':')
                      return { privatePort: Number(priv), publicPort: Number(pub), hostIp: '0.0.0.0', protocol: 'tcp' as const }
                    }),
                    mounts: [],
                    env: [],
                    labels: { 'com.docker.compose.project': def.project, 'com.docker.compose.service': n, 'com.docker.compose.project.config_files': path },
                    project: def.project,
                    service: n,
                  }
                  containers.unshift(c)
                  await say(` Container ${c.name}  Created`, ` Container ${c.name}  Starting`, ` Container ${c.name}  Started`)
                  emit({ type: 'container', action: 'create', id: c.id }, { type: 'container', action: 'start', id: c.id })
                } else {
                  for (const c of existing) {
                    if (c.state !== 'running') {
                      c.state = 'running'
                      c.startedAt = now()
                      await say(` Container ${c.name}  Starting`, ` Container ${c.name}  Started`)
                      emit({ type: 'container', action: 'start', id: c.id })
                    } else await say(` Container ${c.name}  Running`)
                  }
                }
              } else if (command === 'stop' || command === 'down') {
                for (const c of existing) {
                  if (c.state === 'running' || c.state === 'paused') {
                    await say(` Container ${c.name}  Stopping`)
                    c.state = 'exited'
                    c.exitCode = 0
                    await say(` Container ${c.name}  Stopped`)
                    emit({ type: 'container', action: 'die', id: c.id })
                  }
                  if (command === 'down') {
                    containers = containers.filter((x) => x !== c)
                    await say(` Container ${c.name}  Removed`)
                    emit({ type: 'container', action: 'destroy', id: c.id })
                  }
                }
              } else if (command === 'restart') {
                for (const c of existing) {
                  await say(` Container ${c.name}  Restarting`)
                  c.state = 'running'
                  c.startedAt = now()
                  await say(` Container ${c.name}  Started`)
                  emit({ type: 'container', action: 'restart', id: c.id })
                }
                if (!existing.length) await say(` ${n} has no container yet. Use Up to create it.`)
              }
            }
            if (command === 'down') await say(` Network ${def.project}_default  Removed`)
            refreshUsage()
          } finally {
            pulls.delete(runId)
          }
        })()
        return { runId, done }
      },
      async cancel(runId) {
        pulls.get(runId)?.cancel()
      },
      async readEnv(path) {
        await up()
        return envFiles.get(path) ?? ''
      },
      async writeEnv(path, text) {
        await up(150)
        if (!composeDefs[path]) throw new ApiError('The compose file isn’t there any more.', 404)
        envFiles.set(path, text)
      },
    },

    builds: {
      async pickContext() {
        await up(150)
        return { path: String.raw`C:\code\shop`, dockerfiles: ['Dockerfile', 'Dockerfile.dev', 'worker.Dockerfile'] }
      },
      start(spec, onEvent) {
        const buildId = rid()
        let cancelled = false
        pulls.set(buildId, { cancel: () => (cancelled = true) })
        const plan: [string, string[]][] = [
          ['[internal] load build definition from ' + spec.dockerfile, ['transferring dockerfile: 412B done']],
          ['[internal] load .dockerignore', ['transferring context: 2B done']],
          ['[internal] load metadata for docker.io/library/node:22-alpine', []],
          ['[1/5] FROM docker.io/library/node:22-alpine', ['resolve docker.io/library/node:22-alpine done']],
          ['[2/5] WORKDIR /app', []],
          ['[3/5] COPY package*.json ./', []],
          ['[4/5] RUN npm ci --omit=dev', ['added 214 packages, and audited 215 packages in 6s', '41 packages are looking for funding', 'found 0 vulnerabilities']],
          ['[5/5] COPY . .', []],
          ['exporting to image', ['exporting layers 0.4s done', 'writing image sha256:' + rid() + rid() + ' done', ...(spec.tag ? [`naming to docker.io/${spec.tag} done`] : [])]],
        ]
        const failing = /fail/.test(spec.tag ?? '')
        const done = (async () => {
          try {
            await up(200)
            const steps: BuildStep[] = []
            for (let i = 0; i < plan.length; i++) {
              const [name, out] = plan[i]
              const id = String(i + 1)
              const step: BuildStep = { id, name, status: 'running' }
              steps.push(step)
              onEvent({ type: 'log', lines: [`#${id} ${name}`] })
              onEvent({ type: 'steps', steps: structuredClone(steps) })
              await sleep(name.startsWith('[4/5]') ? 700 : 160)
              if (cancelled) throw new ApiError('Build cancelled.', 499)
              const cached = !spec.noCache && /^\[(2|3)\/5\]/.test(name)
              if (failing && name.startsWith('[4/5]')) {
                step.status = 'error'
                const msg = 'process "/bin/sh -c npm ci --omit=dev" did not complete successfully: exit code: 1'
                onEvent({ type: 'log', lines: [`#${id} 2.113 npm ERR! missing script: build`, `#${id} ERROR: ${msg}`] })
                onEvent({ type: 'steps', steps: structuredClone(steps) })
                throw new ApiError(msg, 422)
              }
              step.status = cached ? 'cached' : 'done'
              step.seconds = cached ? undefined : Math.round(Math.random() * 30) / 10
              onEvent({ type: 'log', lines: [...out.map((o, n) => `#${id} ${(n * 0.21).toFixed(3)} ${o}`), cached ? `#${id} CACHED` : `#${id} DONE ${step.seconds}s`] })
              onEvent({ type: 'steps', steps: structuredClone(steps) })
            }
            const imageId = 'sha256:' + rid()
            const tag = spec.tag ? (/:[^/]+$/.test(spec.tag) ? spec.tag : `${spec.tag}:latest`) : undefined
            for (const other of images) if (tag) other.tags = other.tags.filter((t) => t !== tag)
            images.unshift({ id: imageId, tags: tag ? [tag] : [], size: 182_000_000, createdAt: now(), arch: 'amd64', emulated: false, inUse: false, dangling: !tag })
            emit({ type: 'image', action: 'build', id: imageId })
            notify({ kind: 'success', title: tag ? `Built ${tag}` : 'Build finished' })
            return { imageId }
          } finally {
            pulls.delete(buildId)
          }
        })()
        return { buildId, done }
      },
      async cancel(buildId) {
        pulls.get(buildId)?.cancel()
      },
    },

    tunnels: {
      async list() {
        await up()
        tunnels = tunnels.filter((t) => containers.some((c) => c.id === t.containerId))
        for (const t of tunnels) if (containers.find((c) => c.id === t.containerId)?.state !== 'running') t.state = 'stopped'
        return structuredClone(tunnels)
      },
      async open(containerId, port) {
        await up(300)
        const c = byId(containerId)
        if (c.state !== 'running') throw new ApiError(`${c.name} isn’t running. Start it, then share it.`, 409)
        const same = tunnels.find((t) => t.containerId === c.id && t.port === port && t.state !== 'stopped')
        if (same) return structuredClone(same)
        await sleep(900)
        const words = ['amber', 'river', 'quiet', 'falcon', 'meadow', 'copper', 'lantern', 'orbit']
        const pick = () => words[Math.floor(Math.random() * words.length)]
        const t: Tunnel = { id: rid() + rid(), containerId: c.id, containerName: c.name, port, url: `https://${pick()}-${pick()}-${pick()}-${rid().slice(0, 4)}.trycloudflare.com`, state: 'open', startedAt: now() }
        tunnels.push(t)
        return structuredClone(t)
      },
      async close(id) {
        await up(200)
        tunnels = tunnels.filter((t) => t.id !== id)
      },
      async visit() {
        // The browser build has nowhere to open it.
      },
    },

    files: {
      async list(id, path) {
        await up()
        const c = byId(id)
        const p = path.replace(/\/+$/, '') || '/'
        const t = (name: string, type: FileEntry['type'], size = 0): FileEntry => ({ name, type, size, modifiedAt: c.createdAt })
        const tree: Record<string, FileEntry[]> = {
          '/': ['app', 'bin', 'etc', 'home', 'lib', 'proc', 'root', 'tmp', 'usr', 'var'].map((n) => t(n, 'dir')).concat([t('.dockerenv', 'file')]),
          '/app': [t('node_modules', 'dir'), t('src', 'dir'), t('package.json', 'file', 812), t('server.js', 'file', 4210), t('.env.example', 'file', 96)],
          '/app/src': [t('routes.js', 'file', 2380), t('db.js', 'file', 1120)],
          '/etc': [t('hosts', 'file', 174), t('hostname', 'file', 13), t('os-release', 'file', 267), t('nginx', 'dir')],
          '/tmp': [...(uploaded.get(c.id) ?? []).map((n) => t(n, 'file', 1024))],
        }
        const entries = tree[p]
        if (!entries) {
          if (/\.\w+$/.test(p)) throw new ApiError(`${p} isn’t a folder in this container.`, 404)
          return { path: p, entries: [], truncated: false, via: c.state === 'running' ? 'exec' : 'archive' }
        }
        return { path: p, entries: structuredClone(entries).sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name)), truncated: false, via: c.state === 'running' ? 'exec' : 'archive' }
      },
      async download(id, path, isDir) {
        await up(200)
        byId(id)
        const name = path.split('/').pop() ?? 'file'
        return `${String.raw`C:\Users\you\Downloads`}\\${isDir ? `${name}.tar` : name}`
      },
      async upload(id, dir) {
        await up(200)
        const c = byId(id)
        if (dir !== '/tmp') throw new ApiError(`${dir} is read-only in this container.`, 403)
        uploaded.set(c.id, [...(uploaded.get(c.id) ?? []), 'notes.txt'])
        return 1
      },
      async changes(id) {
        await up()
        const c = byId(id)
        if (c.state === 'created') return []
        return [
          { path: '/app/node_modules/.cache', kind: 'added' },
          { path: '/etc/hosts', kind: 'changed' },
          { path: '/tmp/server.pid', kind: 'added' },
          { path: '/usr/share/doc', kind: 'deleted' },
          ...(uploaded.get(c.id) ?? []).map((n) => ({ path: `/tmp/${n}`, kind: 'added' as const })),
        ]
      },
    },

    registries: {
      async list() {
        await up()
        return [...logins.values()]
      },
      async login(address, username, password) {
        await up(500)
        const key = server(address)
        if (!/^[a-z0-9.-]+(:[0-9]+)?$/.test(key)) throw new ApiError('Use an address like ghcr.io or myregistry.example:5000.', 400)
        if (password === 'wrong') throw new ApiError(`${key} didn’t accept that user name and password.`, 401)
        if (key.endsWith('.invalid')) throw new ApiError(`The engine couldn’t reach ${key}. Check the address.`, 502)
        const l = { server: key, username, savedAt: now() }
        logins.set(key, l)
        return l
      },
      async logout(address) {
        await up(150)
        logins.delete(server(address))
      },
    },

    networks: {
      async list() {
        await up()
        refreshUsage()
        return structuredClone(networks)
      },
      async create(spec) {
        await up(250)
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(spec.name)) throw new ApiError('Use at least two characters: letters, digits, dots, dashes or underscores, starting with a letter or digit.', 400)
        if (networks.some((n) => n.name === spec.name)) throw new ApiError(`A network called ${spec.name} already exists.`, 409)
        if (spec.gateway && !spec.subnet) throw new ApiError('A gateway needs a subnet.', 400)
        const clash = spec.subnet ? networks.find((n) => n.subnet === spec.subnet) : undefined
        if (clash) throw new ApiError(`${spec.subnet} overlaps ${clash.name}, which already uses it. Pick another range.`, 403)
        const subnet = spec.subnet ?? `172.${20 + networks.length}.0.0/16`
        const n: NetworkRow = {
          id: rid() + rid(),
          name: spec.name,
          driver: 'bridge',
          scope: 'local',
          internal: spec.internal,
          ipv6: false,
          subnet,
          gateway: spec.gateway ?? subnet.replace(/\.0\/\d+$/, '.1'),
          createdAt: now(),
          builtIn: false,
          usedBy: [],
        }
        networks.unshift(n)
        emit({ type: 'network', action: 'create', id: n.id })
        return structuredClone(n)
      },
      async remove(ids) {
        await up(300)
        refreshUsage()
        return ids.map((id) => {
          const n = networks.find((x) => x.id === id)
          if (!n) return { id, ok: true }
          if (n.builtIn) return { id, ok: false, error: `${n.name} is built into Docker and cannot be removed.` }
          if (n.usedBy.length) return { id, ok: false, usedBy: n.usedBy, error: `In use by ${n.usedBy.join(', ')}.` }
          networks = networks.filter((x) => x !== n)
          emit({ type: 'network', action: 'destroy', id })
          return { id, ok: true }
        })
      },
      async members(id) {
        await up()
        const n = netById(id)
        return containers
          .filter((c) => netsOf(c).includes(n.id))
          .map((c): NetworkMember => {
            const live = c.state === 'running' || c.state === 'paused'
            return {
              containerId: c.id,
              containerName: c.name,
              image: c.image,
              state: c.state,
              ipv4: live ? addressIn(n, c) : undefined,
              mac: live && n.subnet ? `02:42:${c.id.slice(0, 8).match(/../g)!.join(':')}` : undefined,
              aliases: c.service ? [c.service, c.name] : [],
            }
          })
      },
      async connect(id, containerId) {
        await up(250)
        const n = netById(id)
        const c = byId(containerId)
        if (n.driver === 'host' || n.driver === 'null') throw new ApiError(`A container is put on ${n.name} when it is created; it can’t join later.`, 400)
        const current = netsOf(c)
        if (current.includes(n.id)) throw new ApiError(`${c.name} is already on ${n.name}.`, 403)
        attachments.set(c.id, [...current, n.id])
        refreshUsage()
        emit({ type: 'network', action: 'connect', id: n.id })
      },
      async disconnect(id, containerId) {
        await up(250)
        const n = netById(id)
        const c = byId(containerId)
        const current = netsOf(c)
        if (!current.includes(n.id)) throw new ApiError(`${c.name} isn’t on ${n.name}.`, 404)
        attachments.set(c.id, current.filter((x) => x !== n.id))
        addresses.delete(`${n.id}:${c.id}`)
        refreshUsage()
        emit({ type: 'network', action: 'disconnect', id: n.id })
      },
    },

    settings: {
      async get() {
        return { ...settings }
      },
      async set(key, value) {
        settings[key] = value
      },
    },
    grid: {
      async get(view) {
        return structuredClone(grid[view])
      },
      async set(view, prefs) {
        grid[view] = structuredClone(prefs)
      },
    },
    notifications: {
      async list() {
        return structuredClone(notifications)
      },
      async markRead(ids) {
        for (const n of notifications) if (ids.includes(n.id) && !n.readAt) n.readAt = now()
      },
      onNew(cb) {
        notifSubs.add(cb)
        return () => notifSubs.delete(cb)
      },
    },
    search: {
      async recent() {
        return recents.slice(0, 6)
      },
      async recordUse(item) {
        recents = [item, ...recents.filter((r) => !(r.type === item.type && r.id === item.id))]
      },
    },
  }

  // Test hooks for engine states (S01). Only exist in the fake.
  ;(window as unknown as { __tenderFake: unknown }).__tenderFake = {
    setEngine: (state: EngineStatus['state'], error?: string, repair?: string, wslStuck?: boolean) => setEngine({ state, error, repair, wslStuck }),
    setKubeBroken: (on: boolean) => (fakeKubeBroken = on),
  }

  return api
}
