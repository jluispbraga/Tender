// The renderer's whole view of the outside world. It mirrors the IPC surface
// in replica/architecture.md. Two implementations: the fake engine in
// ./fake (now) and window.tender from the Electron preload (replica-backend).
// Screens import `api` from ./index and never know which one they got.

export type EngineState = 'running' | 'starting' | 'stopped' | 'error'

export interface EngineStatus {
  state: EngineState
  endpoint: string
  version?: string
  apiVersion?: string
  os?: 'linux' | 'windows'
  ncpu?: number
  memTotal?: number
  containersRunning?: number
  error?: string
  /** Windows: this WSL distribution's engine runs but lost its socket; it can be repaired. */
  repair?: string
  /** Windows: WSL's own service is wedged (Wsl/Service/E_UNEXPECTED); restarting WSL clears it. */
  wslStuck?: boolean
}

export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'exited' | 'dead'

export interface PortBinding {
  privatePort: number
  publicPort?: number
  hostIp?: string
  protocol: 'tcp' | 'udp'
}

export interface Mount {
  type: 'bind' | 'volume' | 'tmpfs'
  source: string
  destination: string
  rw: boolean
}

export interface ContainerRow {
  id: string
  name: string
  image: string
  imageId: string
  command: string
  state: ContainerState
  exitCode?: number
  createdAt: string
  startedAt?: string
  ports: PortBinding[]
  mounts: Mount[]
  env: string[]
  labels: Record<string, string>
  /** From com.docker.compose.project / .service labels. */
  project?: string
  service?: string
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause'

export interface ActionResult {
  id: string
  ok: boolean
  error?: string
}

export interface LogLine {
  ts: string
  stream: 'stdout' | 'stderr'
  text: string
  source?: string
}

export interface StatsSample {
  id: string
  at: number
  cpuPercent: number
  memUsage: number
  memLimit: number
  netRx: number
  netTx: number
  blkRead: number
  blkWrite: number
  pids: number
}

export interface ExecSession {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

export interface ImageRow {
  id: string
  tags: string[]
  size: number
  createdAt: string
  arch: string
  emulated: boolean
  inUse: boolean
  dangling: boolean
}

export interface ImageLayer {
  id: string
  createdBy: string
  size: number
  createdAt: string
}

export interface ImageDetail {
  image: ImageRow
  layers: ImageLayer[]
  env: string[]
  cmd: string
  exposedPorts: string[]
}

export interface DiskUsage {
  imagesTotal: number
  imagesReclaimable: number
  /** id -> bytes shared with other images */
  sharedSize: Record<string, number>
}

export interface LayerProgress {
  id: string
  status: 'waiting' | 'downloading' | 'extracting' | 'done' | 'error'
  current?: number
  total?: number
}

export interface PullHandle {
  pullId: string
  done: Promise<void>
}

export interface RunSpec {
  image: string
  name?: string
  ports: { host: string; container: string }[]
  volumes: { source: string; target: string }[]
  env: { key: string; value: string }[]
}

export interface VolumeRow {
  name: string
  driver: string
  createdAt: string
  size: number
  usedBy: string[]
}

export interface VolumeUsage {
  containerId: string
  containerName: string
  image: string
  target: string
  ports: string
}

export interface EngineEvent {
  type: 'container' | 'image' | 'volume'
  action: string
  id: string
}

export interface Notification {
  id: string
  kind: 'info' | 'success' | 'error'
  title: string
  body?: string
  createdAt: string
  readAt?: string
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  start_on_login: boolean
  open_on_start: boolean
  only_running: boolean
  exec_default_shell: string
  log_tail_lines: number
  tray_enabled: boolean
  /** Windows: serve //./pipe/docker_engine from the engine in WSL, for docker.exe, IDEs and other tools. */
  share_docker_pipe: boolean
  /** Look for new versions on GitHub and download them in the background. */
  check_updates: boolean
  /** Kubeconfig files and folders to read besides ~/.kube/config (or KUBECONFIG). */
  kube_sources: string[]
  /** The user's name and environment per context, by KubeContext.key. The kubeconfig is never edited. */
  kube_labels: Record<string, { name?: string; env?: KubeEnv }>
  /** Port forwards to start again when Tender opens. */
  kube_forwards: KubeForwardSpec[]
}

/** Settings › Kubernetes: what each kubeconfig source brings in. */
export interface KubeSourceReport {
  /** ~/.kube/config, or each KUBECONFIG entry; always read. */
  base: { file: string; contexts: string[]; error?: string }[]
  fromEnv: boolean
  /** The paths the user added, in order. */
  added: { path: string; folder: boolean; files: { file: string; contexts: string[]; error?: string }[]; error?: string }[]
}

export interface KubeConfigProblem {
  path: string
  problem: string
  hint: string
}

export interface UpdateStatus {
  /** The Windows installer and the AppImage update themselves; the portable .exe and the .deb do not. */
  supported: boolean
  current: string
  state: 'idle' | 'off' | 'checking' | 'none' | 'downloading' | 'ready' | 'error'
  /** The new version, while downloading or once ready. */
  version?: string
  percent?: number
  error?: string
  checkedAt?: string
  releases: string
}

export type GridView = 'containers' | 'images' | 'volumes'

export interface GridPrefs {
  hidden: string[]
}

export interface RecentItem {
  type: 'container' | 'image' | 'volume'
  id: string
  label: string
}

type Unsub = () => void

export interface TenderApi {
  /** 'fake' while there is no Electron main process. */
  kind: 'fake' | 'ipc'
  /** The host OS Tender runs on (not the engine's): picks wording and hints. */
  platform: 'win32' | 'linux' | 'darwin' | (string & {})
  engine: {
    status(): Promise<EngineStatus>
    reconnect(): Promise<EngineStatus>
    /** Windows: restart Docker in a WSL distribution whose engine lost its socket, then reconnect. */
    repairWsl(distro: string): Promise<EngineStatus>
    /** Windows: wsl --shutdown, then reconnect (Tender boots the distribution with Docker again). */
    restartWsl(): Promise<EngineStatus>
    onStatus(cb: (s: EngineStatus) => void): Unsub
    onEvents(cb: (events: EngineEvent[]) => void): Unsub
  }
  containers: {
    list(): Promise<ContainerRow[]>
    inspect(id: string): Promise<Record<string, unknown>>
    action(ids: string[], action: ContainerAction): Promise<ActionResult[]>
    remove(ids: string[], force?: boolean): Promise<ActionResult[]>
    runCommand(id: string): Promise<string>
    openPort(p: PortBinding): Promise<void>
  }
  logs: {
    subscribe(id: string, opts: { tail: number }, cb: (lines: LogLine[]) => void): Unsub
  }
  stats: {
    subscribe(ids: string[], cb: (samples: StatsSample[]) => void): Unsub
  }
  exec: {
    open(id: string, opts: { shell: string; cols: number; rows: number }, onData: (d: string) => void, onExit: (code: number) => void): Promise<ExecSession>
  }
  compose: {
    action(project: string, action: ContainerAction): Promise<ActionResult[]>
    remove(project: string): Promise<ActionResult[]>
  }
  images: {
    list(): Promise<ImageRow[]>
    inspect(id: string): Promise<ImageDetail>
    diskUsage(): Promise<DiskUsage>
    pull(reference: string, onProgress: (layers: LayerProgress[]) => void): PullHandle
    cancelPull(pullId: string): Promise<void>
    remove(ids: string[], force?: boolean): Promise<ActionResult[]>
    prune(scope: 'dangling' | 'unused'): Promise<{ deleted: string[]; spaceReclaimed: number }>
    run(spec: RunSpec): Promise<{ containerId: string }>
  }
  volumes: {
    list(): Promise<VolumeRow[]>
    create(name: string): Promise<VolumeRow>
    remove(names: string[]): Promise<(ActionResult & { usedBy?: string[] })[]>
    usage(name: string): Promise<VolumeUsage[]>
  }
  settings: {
    get(): Promise<Settings>
    set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>
  }
  grid: {
    get(view: GridView): Promise<GridPrefs>
    set(view: GridView, prefs: GridPrefs): Promise<void>
  }
  notifications: {
    list(): Promise<Notification[]>
    markRead(ids: string[]): Promise<void>
    onNew(cb: (n: Notification) => void): Unsub
  }
  search: {
    recent(): Promise<RecentItem[]>
    recordUse(item: RecentItem): Promise<void>
  }
  /** New versions from GitHub Releases. */
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    /** Quits Tender and runs the downloaded update, which opens Tender again. */
    install(): Promise<void>
    /** Opens the GitHub Releases page in the browser. */
    openReleases(): Promise<void>
  }
  /** The Kubernetes clusters in the user's kubeconfig: browse, read logs, restart, scale, delete. */
  kube: {
    contexts(): Promise<KubeContext[]>
    /** When there are no contexts: whether the kubeconfig is broken, and how to fix it. */
    configProblem(): Promise<KubeConfigProblem | null>
    namespaces(context: string): Promise<string[]>
    overview(context: string, namespace: string): Promise<KubeOverview>
    /** Follows a container's log; with previous, the run before its last restart (kubectl logs --previous). */
    logs(context: string, namespace: string, pod: string, container: string, onEvent: (e: { type: 'lines'; lines: string[] } | { type: 'error'; message: string }) => void, opts?: { previous?: boolean }): Unsub
    /** What ~/.kube/config and each added file or folder bring in. */
    sources(): Promise<KubeSourceReport>
    /** The system picker, opened in ~/.kube. */
    pickSource(kind: 'file' | 'folder'): Promise<string | null>
    /** kubectl describe pod, the useful part: containers, conditions, recent events. */
    podDetails(context: string, namespace: string, pod: string): Promise<KubePodDetails>
    /** A shell in a pod's container (same session shape as a container terminal). */
    exec(context: string, namespace: string, pod: string, container: string, opts: { shell: 'auto' | '/bin/sh' | '/bin/bash'; cols: number; rows: number }, onData: (d: string) => void, onExit: (code: number) => void): Promise<ExecSession>
    /** Port forwards running now (saved: they start again when Tender opens). */
    forwards(): Promise<KubeForward[]>
    /** Listens on 127.0.0.1:localPort (0: any free port) and tunnels to the pod or service port. */
    startForward(context: string, target: { kind: 'pod' | 'service'; namespace: string; name: string; port: number }, localPort: number): Promise<KubeForward>
    stopForward(id: string): Promise<void>
    /** Opens http://localhost:<its local port> in the browser. */
    openForward(id: string): Promise<void>
    /** Restarts, scales or deletes one object; resolves with what happened. */
    act(context: string, action: KubeAction): Promise<string>
    /** StatefulSets, jobs, cronjobs, ingresses, configmaps or secrets of one namespace, or of all ('*'). */
    list(context: string, namespace: string, kind: KubeKind): Promise<KubeItem[]>
    /** The keys of a ConfigMap (with values) or a Secret (names and sizes only). */
    data(context: string, namespace: string, kind: 'configmaps' | 'secrets', name: string): Promise<KubeData>
    /** kubectl get -o yaml, without managedFields; a Secret's values are blanked. */
    yaml(context: string, kind: 'pods' | 'deployments' | 'services' | KubeKind, namespace: string, name: string): Promise<string>
  }
  /** Windows: WSL's memory and disks, and the settings that keep them in check. */
  resources: {
    status(): Promise<WslResources>
    act(a: ResourceAction): Promise<string>
  }
  /** Everything Tender depends on, checked, each problem with its fix. */
  doctor: {
    check(): Promise<DoctorCheck[]>
    fix(id: DoctorFix['id'], distro?: string): Promise<string>
  }
  /** Windows: install Docker Engine inside a WSL distribution. */
  setup: {
    distros(): Promise<WslDistro[]>
    inspect(distro: string): Promise<WslDistroDetail>
    install(distro: string, onEvent: (e: WslSetupEvent) => void): Unsub
  }
  /** Windows: what Docker tools on Windows need (the standard pipe, the CLI). */
  tools: {
    status(): Promise<WindowsTools>
    installCli(onStep: (s: ToolInstallEvent) => void): Unsub
    useDefaultContext(): Promise<void>
  }
  /** Windows: move containers, images and volumes out of Docker Desktop into the engine inside WSL. */
  migrate: {
    check(): Promise<MigrationCheck>
    plan(distro: string): Promise<MigrationPlan>
    run(distro: string, itemIds: string[], opts: { start: boolean }, onEvent: (e: MigrationEvent) => void): Unsub
    /** Gives the distribution's socket back to its own engine (restarts Docker there, as root through WSL). */
    repairSocket(distro: string): Promise<void>
  }
}

// ---- Kubernetes ----------------------------------------------------------------------

/** What a cluster is for, as the user marks it (or as Tender guesses from its names). */
export type KubeEnv = 'local' | 'dev' | 'qa' | 'prod'

export interface KubeContext {
  /** Unique id for API calls: the context name, plus its file name when two kubeconfig files reuse it. */
  name: string
  /** The context's own name inside its kubeconfig (often a default such as microk8s). */
  context: string
  /** Stable key for the user's name and environment: file + context name. */
  key: string
  /** What to call it when the user has not named it: the file name for added files ("flake-prod"), else the context name. */
  defaultLabel: string
  /** Tender's guess from the file and context names; the user's choice wins. */
  guessedEnv?: KubeEnv
  cluster: string
  server: string
  namespace: string
  current: boolean
  /** The kubeconfig file it comes from (~/.kube/config, ~/.kube/prod/..., or a KUBECONFIG entry). */
  file?: string
}

export interface KubePodDetails {
  node?: string
  ip?: string
  startedAt?: string
  conditions: { type: string; ok: boolean; reason?: string; message?: string }[]
  containers: {
    name: string
    image: string
    ready: boolean
    restarts: number
    /** "running", "waiting: CrashLoopBackOff", "terminated: Error (exit 1)" */
    state: string
    message?: string
    lastTermination?: { reason: string; exitCode: number; finishedAt?: string }
    ports: { port: number; name?: string; protocol: string }[]
  }[]
  /** Newest first. */
  events: { type: string; reason: string; message: string; count: number; lastSeen?: string }[]
}

export interface KubeForward {
  id: string
  context: string
  kind: 'pod' | 'service'
  namespace: string
  name: string
  /** The pod or service port. */
  port: number
  /** Where it listens on this computer (127.0.0.1). */
  localPort: number
  startedAt: string
}

/** What a port forward needs to start again: the target and the local port. */
export interface KubeForwardSpec {
  context: string
  kind: 'pod' | 'service'
  namespace: string
  name: string
  port: number
  localPort: number
}

export type KubeAction =
  | { kind: 'delete-pod' | 'delete-deployment' | 'delete-service' | 'restart-deployment'; namespace: string; name: string }
  | { kind: 'scale-deployment'; namespace: string; name: string; replicas: number }
  | { kind: 'delete'; resource: KubeKind; namespace: string; name: string }
  | { kind: 'restart-statefulset' | 'run-cronjob'; namespace: string; name: string }
  | { kind: 'scale-statefulset'; namespace: string; name: string; replicas: number }
  | { kind: 'suspend-cronjob'; namespace: string; name: string; suspend: boolean }

/** The kinds listed on demand, one tab at a time (pods, deployments and services come with the overview). */
export type KubeKind = 'statefulsets' | 'jobs' | 'cronjobs' | 'ingresses' | 'configmaps' | 'secrets'

export interface KubeItem {
  name: string
  namespace: string
  createdAt?: string
  /** The columns of that kind's table, already formatted. */
  fields: Record<string, string>
  /** StatefulSets: the replicas asked for. */
  replicas?: number
  /** CronJobs: paused. */
  suspended?: boolean
}

/** A ConfigMap's or Secret's keys. Secret values never leave the main process. */
export interface KubeData {
  entries: { key: string; bytes: number; /** ConfigMaps only. */ value?: string }[]
  /** Secrets: their type, e.g. kubernetes.io/tls. */
  type?: string
}

export interface KubeOverview {
  pods: { name: string; namespace: string; status: string; ready: string; restarts: number; node?: string; containers: string[]; /** Declared container ports, for forwarding. */ ports: number[]; createdAt?: string; /** What made it: a Job, ReplicaSet, StatefulSet... */ owner?: { kind: string; name: string } }[]
  deployments: { name: string; namespace: string; ready: string; replicas: number; upToDate: number; images: string[]; createdAt?: string }[]
  services: { name: string; namespace: string; type: string; clusterIP: string; ports: string[]; /** Plain port numbers, for forwarding. */ portNumbers: number[] }[]
}

// ---- WSL memory and disk -----------------------------------------------------------

export interface WslResources {
  memory: {
    /** What the WSL VM holds right now (vmmemWSL). */
    vmBytes: number
    hostBytes: number
    /** [wsl2] memory in .wslconfig, e.g. "8GB"; null: WSL's default (half the RAM). */
    limit: string | null
    reclaim: 'gradual' | 'dropCache' | 'disabled'
  }
  disks: { distro: string; path: string; fileBytes: number; usedBytes?: number; sparse: boolean; running: boolean; version: number }[]
  sparseByDefault: boolean
  buildCache: { total: number; reclaimable: number } | null
  wslconfig: string
}

export type ResourceAction =
  | { kind: 'reclaim'; mode: 'gradual' | 'dropCache' | 'disabled' }
  | { kind: 'limit'; gb: number | null }
  | { kind: 'sparse-default'; on: boolean }
  | { kind: 'make-sparse'; distro: string }
  | { kind: 'trim'; distro: string }
  | { kind: 'prune-build-cache' }

// ---- the Doctor ------------------------------------------------------------------

export interface DoctorFix {
  id: 'wsl-update' | 'restart-wsl' | 'start-distro' | 'repair-socket' | 'start-docker' | 'docker-group' | 'dns-tunneling' | 'default-context'
  label: string
  distro?: string
  /** What the fix does that the user should know first. */
  note?: string
}

export interface DoctorCheck {
  id: string
  area: 'wsl' | 'engine' | 'network' | 'windows'
  title: string
  status: 'ok' | 'warn' | 'fail' | 'info'
  detail?: string
  /** What to do by hand, when there is no button for it. */
  hint?: string
  fix?: DoctorFix
  link?: { label: string; route: string }
}

// ---- Docker Engine inside WSL -----------------------------------------------------

export interface WslDistro {
  name: string
  isDefault: boolean
  running: boolean
  /** WSL 1 or 2 */
  version: number
}

export interface WslDistroDetail {
  name: string
  os: string
  /** Debian or Ubuntu family: Docker's apt repository serves it */
  supported: boolean
  systemd: boolean
  /** desktop-cli: only Docker Desktop's integration CLI */
  docker: 'none' | 'cli-only' | 'desktop-cli' | 'installed' | 'running'
  user: string
}

export type WslSetupStep = 'systemd' | 'packages' | 'group' | 'service' | 'check'

export type WslSetupEvent =
  | { type: 'step'; step: WslSetupStep; status: 'working' | 'done' | 'failed'; detail?: string }
  | { type: 'line'; line: string }
  | { type: 'done'; alreadyInstalled?: boolean }
  | { type: 'error'; message: string }

// ---- Docker tools on Windows ------------------------------------------------------

export interface WindowsTools {
  /** serving: Tender answers on //./pipe/docker_engine; taken: something else does (Docker Desktop); waiting: no WSL engine yet. */
  pipe: { state: 'off' | 'serving' | 'taken' | 'waiting'; distro?: string }
  cli: { path: string; version: string; /** installed by Tender */ own: boolean } | null
  compose: string | null
  buildx: string | null
  /** The Docker CLI's current context. */
  context: string
  contextUsesPipe: boolean
  binOnPath: boolean
}

export type ToolInstallEvent =
  | { type: 'step'; step: 'cli' | 'compose' | 'buildx' | 'path'; status: 'working' | 'done' | 'failed'; detail?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// ---- moving from Docker Desktop (Windows) ----------------------------------------

export interface MigrationCheck {
  desktopInstalled: boolean
  /** Docker Desktop's engine: where the containers are now. */
  source: { ok: boolean; version?: string; containers?: number; reason?: string }
  /** The Docker Engine inside WSL: where they go. */
  target: { ok: boolean; distro?: string; version?: string; reason?: string; /** docker in this distribution answers as Docker Desktop (its WSL integration). */ hijacked?: string; /** the distribution's engine runs but lost its socket */ lost?: string }
}

export interface MigrationItem {
  id: string
  kind: 'project' | 'container' | 'unused-images' | 'unused-volumes'
  label: string
  containers: string[]
  images: string[]
  volumes: string[]
  /** Approximate: images shared between items count in each. */
  bytes: number
  running: number
  /** Names that already exist in the target and will be left alone. */
  conflicts: string[]
}

export interface MigrationPlan {
  items: MigrationItem[]
}

export type MigrationStep = 'prepare' | 'images' | 'networks' | 'volumes' | 'containers' | 'start'

export type MigrationEvent =
  | { type: 'step'; step: MigrationStep; total: number }
  | { type: 'item'; step: MigrationStep; name: string; status: 'working' | 'done' | 'skipped' | 'failed'; message?: string }
  | { type: 'bytes'; name: string; done: number; total: number }
  | { type: 'done'; moved: number; skipped: number; failed: number; cancelled?: boolean }
  | { type: 'error'; message: string }

/** Errors crossing the API carry the engine's HTTP status when there was one. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message)
  }
}
