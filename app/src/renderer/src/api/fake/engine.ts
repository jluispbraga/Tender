import {
  ApiError,
  type ActionResult,
  type ContainerRow,
  type EngineEvent,
  type EngineStatus,
  type GridPrefs,
  type KubeForward,
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
  type VolumeRow,
  type WindowsTools,
  type WslSetupEvent,
  type WslResources,
  type UpdateStatus,
} from '../types'
import { bootLines, chatter, flavour, seedContainers, seedImages, seedLayers, seedVolumes } from './seed'
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
    kube_sources: [],
    kube_labels: {},
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
  const fakeForwards: KubeForward[] = []
  let fakeForwardId = 1
  let fakeKubeBroken = false
  let fakeUpdate: UpdateStatus = { supported: true, current: '0.4.0', state: 'none', releases: 'https://github.com/jluispbraga/Tender/releases' }
  const fakeResources: WslResources = {
    memory: { vmBytes: 3_050_000_000, hostBytes: 16_600_000_000, limit: null, reclaim: 'disabled' },
    disks: [{ distro: 'Ubuntu', path: 'C:\Users\you\AppData\Local\Packages\Ubuntu\LocalState\ext4.vhdx', fileBytes: 59_000_000_000, usedBytes: 41_000_000_000, sparse: false, running: true, version: 2 }],
    sparseByDefault: false,
    buildCache: { total: 6_200_000_000, reclaimable: 5_900_000_000 },
    wslconfig: 'C:\Users\you\.wslconfig',
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
          { name: 'web-7d9f8b6c5-x2k4p', namespace: 'shop', status: 'Running', ready: '1/1', restarts: 0, node: 'kind-dev-control-plane', containers: ['web'], ports: [8080], createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
          { name: 'worker-5c6d7f8-abcde', namespace: 'shop', status: 'CrashLoopBackOff', ready: '0/1', restarts: 7, node: 'kind-dev-control-plane', containers: ['worker'], ports: [], createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
          { name: 'coredns-5d78c9869d-q8rlz', namespace: 'kube-system', status: 'Running', ready: '1/1', restarts: 0, node: 'kind-dev-control-plane', containers: ['coredns'], ports: [53], createdAt: new Date(Date.now() - 86400_000).toISOString() },
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
        fakeKubeDeleted.add(a.name)
        return `Deleted ${a.kind.slice(7)} ${a.name}.`
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
          fakeTools = { ...fakeTools, cli: { path: 'C:\Users\you\AppData\Local\Tender\bin\docker.exe', version: '29.4.3', own: true }, compose: '5.1.3', buildx: 'v0.30.1', binOnPath: true }
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
            if (ref.startsWith('private/')) throw new ApiError(`${ref} is private. Sign in to its registry with docker login, then pull again.`, 401)
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
