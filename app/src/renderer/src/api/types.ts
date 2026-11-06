// The renderer's whole view of the outside world. It mirrors the IPC surface
// in replica/architecture.md. Two implementations: the fake engine in
// ./fake (now) and window.harbor from the Electron preload (replica-backend).
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

export interface HarborApi {
  /** 'fake' while there is no Electron main process. */
  kind: 'fake' | 'ipc'
  engine: {
    status(): Promise<EngineStatus>
    reconnect(): Promise<EngineStatus>
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
}

/** Errors crossing the API carry the engine's HTTP status when there was one. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message)
  }
}
