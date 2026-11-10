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
