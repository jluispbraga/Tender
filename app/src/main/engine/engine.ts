import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import Docker from 'dockerode'
import {
  ApiError,
  type ActionResult,
  type ContainerAction,
  type ContainerRow,
  type ContainerState,
  type DiskUsage,
  type EngineEvent,
  type EngineStatus,
  type ImageDetail,
  type ImageRow,
  type LayerProgress,
  type LogLine,
  type Mount,
  type PortBinding,
  type RunSpec,
  type ScanPhase,
  type StatsSample,
  type NetworkMember,
  type NetworkRow,
  type NetworkSpec,
  type VolumeRow,
  type VolumeUsage,
} from '../../renderer/src/api/types'
import { dockerOptions, resolveEndpoint, WINDOWS_PIPE, type Endpoint } from './endpoint'
import { findWslEngine, listDistros, pipeExists, repairSocket, restartWsl, WslBridge } from './wsl'
import { authFor, engineAddress, registryOf } from './registries'
import { scan } from './scan'
import * as files from './files'
import * as tunnels from './tunnels'
import * as snapshots from './snapshots'
import { AUTO, endpointFor } from './engines'

// The WSL distribution whose engine answered last, so Tender can boot it after a restart.
const wslMemo = () => join(app.getPath('userData'), 'wsl-engine')
function lastWslDistro(): string | null {
  try {
    const d = readFileSync(wslMemo(), 'utf8').trim()
    return /^[A-Za-z0-9._-]{1,64}$/.test(d) ? d : null
  } catch {
    return null
  }
}
function rememberWslDistro(d: string) {
  try {
    if (lastWslDistro() !== d) writeFileSync(wslMemo(), d)
  } catch {
    // Not remembering only means guessing the default distribution next time.
  }
}

type Listener<T> = (v: T) => void

/** Turns a dockerode error into an ApiError carrying the engine's message and HTTP status. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  const err = e as { statusCode?: number; json?: { message?: string } | null; reason?: string; message?: string }
  const msg = err?.json?.message ?? (typeof err?.json === 'string' ? err.json : undefined) ?? err?.message ?? err?.reason ?? String(e)
  return new ApiError(String(msg).replace(/^\(HTTP code \d+\) [a-z ]+- /, '').trim(), err?.statusCode)
}

const normArch = (a?: string) => (a === 'x86_64' ? 'amd64' : a === 'aarch64' ? 'arm64' : (a ?? 'unknown'))

const stateOf = (s: string): ContainerState => (['created', 'running', 'paused', 'restarting', 'exited', 'dead'].includes(s) ? (s as ContainerState) : s === 'removing' ? 'exited' : 'dead')

/** Docker lists each port twice when bound on both 0.0.0.0 and ::. Keep one. */
function dedupePorts(ports: Docker.Port[]): PortBinding[] {
  const seen = new Set<string>()
  const out: PortBinding[] = []
  for (const p of ports) {
    const key = `${p.PrivatePort}/${p.Type}/${p.PublicPort ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ privatePort: p.PrivatePort, publicPort: p.PublicPort || undefined, hostIp: p.IP === '::' ? '0.0.0.0' : p.IP, protocol: p.Type === 'udp' ? 'udp' : 'tcp' })
  }
  return out.sort((a, b) => a.privatePort - b.privatePort)
}

/**
 * Everything Tender asks of Docker Engine, over its public API (dockerode).
 * One instance per app. Keeps the connection healthy (ping job), relays the
 * engine's event stream, and owns every long-lived stream (logs, stats,
 * exec, pulls) so they can be torn down when the renderer goes away.
 */
export class Engine {
  private docker: Docker | null = null
  /** 'auto', or the engine chosen in Settings (wsl://…, context://…, an address). */
  private choice = AUTO
  private endpoint: Endpoint = resolveEndpoint()
  private status: EngineStatus = { state: 'starting', endpoint: this.endpoint.address }
  private pingTimer: NodeJS.Timeout | undefined
  private failures = 0
  private eventStream: Readable | null = null
  /** When the event stream last delivered anything, and what `docker info` counted at the last ping. */
  private lastEventAt = 0
  private lastPing: { at: number; shape: string } | null = null
  private statusListeners = new Set<Listener<EngineStatus>>()
  private eventListeners = new Set<Listener<EngineEvent[]>>()
  private dieListeners = new Set<Listener<{ id: string; name: string; exitCode: number }>>()
  private signalListeners = new Set<Listener<{ kind: 'oom' | 'die'; id: string; name: string; exitCode: number; expected: boolean }>>()
  /** Containers Tender itself is stopping: their exit is expected, not a notification. */
  private stopping = new Set<string>()
  private hostArch = 'amd64'
  /** Windows: the relay to a Docker Engine inside WSL, when that is what answered. */
  private bridge: WslBridge | null = null
  /** Why the WSL fallback found nothing, added to the unreachable message. */
  private wslMiss: string | null = null
  /** A distribution whose engine runs but lost its socket: the gate offers to repair it. */
  private wslLost: string | null = null
  /** WSL's own service is wedged (E_UNEXPECTED): the gate offers to restart WSL. */
  private wslStuck = false
  private discovering: Promise<void> | null = null
  /** The pipe the WSL bridge stands in for: when it comes back (Docker Desktop started), switch back to it. */
  private bridged: string | null = null
  /** A pipe Tender itself serves (docker_engine, for Windows tools): never mistaken for an engine. */
  servedPipe: string | null = null

  /** A named pipe with an engine behind it, other than the one Tender serves itself. */
  private pipeUp(name: string) {
    return name !== this.servedPipe && pipeExists(name)
  }

  /** The WSL distribution Tender is talking to, when it bridges to one and the engine answers. */
  get wslDistro(): string | null {
    return this.endpoint.name.startsWith('wsl:') && this.status.state === 'running' ? this.endpoint.name.slice(4) : null
  }

  /** The engine's own container list, labels included, for code that reads Compose labels. */
  async rawContainers(): Promise<Docker.ContainerInfo[]> {
    return this.call((d) => d.listContainers({ all: true }))
  }

  /** Every container die and out-of-memory kill, for alerts. `expected`: Tender stopped it. */
  onContainerSignal(fn: Listener<{ kind: 'oom' | 'die'; id: string; name: string; exitCode: number; expected: boolean }>) {
    this.signalListeners.add(fn)
    return () => void this.signalListeners.delete(fn)
  }

  /** Uses another engine: 'auto', wsl://Distro, context://name or an address. Reconnects unless told not to. */
  async useEngine(choice: string, reconnect = true): Promise<EngineStatus> {
    this.choice = choice || AUTO
    this.endpoint = endpointFor(this.choice)
    return reconnect ? this.reconnect() : this.status
  }

  get engineChoice() {
    return this.choice
  }

  get currentEndpoint() {
    return this.endpoint
  }

  getStatus(): EngineStatus {
    return this.status
  }

  onStatus(fn: Listener<EngineStatus>) {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  onEvents(fn: Listener<EngineEvent[]>) {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  /** An unexpected container exit (non-zero code, not a stop Tender asked for). */
  onUnexpectedExit(fn: Listener<{ id: string; name: string; exitCode: number }>) {
    this.dieListeners.add(fn)
    return () => this.dieListeners.delete(fn)
  }

  // ---- connection -----------------------------------------------------------

  start() {
    void this.connect()
  }

  stop() {
    clearTimeout(this.pingTimer)
    this.eventStream?.destroy()
    this.closeBridge()
  }

  private closeBridge() {
    this.bridge?.close()
    this.bridge = null
    this.bridged = null
  }

  /**
   * Windows only: when the engine should be behind a named pipe that does not
   * exist (the default pipe, or a context Docker Desktop left behind after it
   * quit or was uninstalled), look for a Docker Engine inside a running WSL
   * distribution and bridge to it. An explicit DOCKER_HOST is never second-guessed.
   */
  private async discoverWsl() {
    // A distribution chosen in Settings: bridge to it, no searching.
    if (process.platform === 'win32' && this.endpoint.address.startsWith('wsl://') && !this.endpoint.socketPath) {
      this.bridge = await WslBridge.open(this.endpoint.address.slice('wsl://'.length))
      this.endpoint = { ...this.endpoint, socketPath: this.bridge.pipe }
      return
    }
    // Only Automatic falls back to WSL; an engine the person picked is never second-guessed.
    if (this.choice !== AUTO) return
    if (process.platform !== 'win32' || this.endpoint.kind !== 'npipe' || this.endpoint.name === 'DOCKER_HOST' || this.endpoint.socketPath) return
    // Dev only: pretend the default pipe is missing, to exercise this path next to Docker Desktop.
    if (this.endpoint.address === WINDOWS_PIPE && !app.isPackaged && process.env.TENDER_DEFAULT_PIPE) this.endpoint = { ...this.endpoint, address: `npipe:////./pipe/${process.env.TENDER_DEFAULT_PIPE}` }
    const pipe = this.endpoint.address.replace(/^npipe:\/\/\/\/\.\/pipe\//, '')
    if (this.pipeUp(pipe)) return
    const r = await findWslEngine(await this.toBoot())
    if (!r.found) {
      this.wslMiss = r.why
      this.wslLost = r.lost ?? null
      this.wslStuck = !!r.stuck
      return
    }
    this.wslMiss = null
    this.wslLost = null
    this.wslStuck = false
    rememberWslDistro(r.found.distro)
    this.bridge = await WslBridge.open(r.found.distro)
    this.bridged = pipe
    this.endpoint = { name: `wsl:${r.found.distro}`, kind: 'npipe', address: `wsl://${r.found.distro}`, source: `Docker in WSL (${r.found.distro}), since ${this.endpoint.address} is missing`, socketPath: this.bridge.pipe }
  }

  /**
   * Stopped distributions worth booting: the one whose engine Tender used last, or,
   * before there is one, the default distribution, tried once. At most once a minute,
   * so a distribution whose Docker is gone is not booted every few seconds.
   */
  private async toBoot(): Promise<string[]> {
    if (Date.now() - this.lastBoot < 60_000) return []
    const last = lastWslDistro()
    if (!last && this.triedDefault) return []
    this.lastBoot = Date.now()
    if (last) return [last]
    this.triedDefault = true
    const d = (await listDistros()).find((x) => x.isDefault)
    return d ? [d.name] : []
  }
  private lastBoot = 0
  private triedDefault = false

  /** The user asked to restart a wedged WSL; the distribution with Docker is booted again right after. */
  async restartWsl(): Promise<EngineStatus> {
    this.closeBridge()
    await restartWsl()
    this.wslStuck = false
    this.lastBoot = 0
    return this.reconnect()
  }

  /** The user asked to give a WSL distribution's engine its socket back (S01). */
  async repairWsl(distro: string): Promise<EngineStatus> {
    await repairSocket(distro)
    this.wslLost = null
    return this.reconnect()
  }

  async reconnect(): Promise<EngineStatus> {
    clearTimeout(this.pingTimer)
    this.eventStream?.destroy()
    this.eventStream = null
    this.lastPing = null
    this.docker = null
    this.closeBridge()
    this.endpoint = endpointFor(this.choice)
    this.setStatus({ state: 'starting', endpoint: this.endpoint.address })
    await this.connect()
    return this.status
  }

  private setStatus(s: EngineStatus) {
    const changed = s.state !== this.status.state || s.error !== this.status.error || s.repair !== this.status.repair || s.wslStuck !== this.status.wslStuck
    this.status = s
    if (changed) this.statusListeners.forEach((fn) => fn(s))
  }

  private async connect() {
    clearTimeout(this.pingTimer)
    try {
      if (!this.docker && !this.bridge) {
        // One discovery at a time: failed calls also trigger connect().
        this.discovering ??= this.discoverWsl().finally(() => (this.discovering = null))
        await this.discovering
      }
      const docker = this.docker ?? new Docker(dockerOptions(this.endpoint))
      await docker.ping()
      const [version, info] = await Promise.all([docker.version(), docker.info()])
      this.docker = docker
      this.hostArch = normArch(info.Architecture)
      this.failures = 0
      this.setStatus({
        state: 'running',
        endpoint: this.endpoint.address,
        version: version.Version,
        apiVersion: version.ApiVersion,
        os: info.OSType === 'windows' ? 'windows' : 'linux',
        ncpu: info.NCPU,
        memTotal: info.MemTotal,
        containersRunning: info.ContainersRunning,
      })
      // The stream can die without a word (sleep/resume, the engine's backend restarting behind
      // the pipe): the engine changed since the last ping yet nothing came through, so resubscribe.
      const shape = `${info.Containers}/${info.ContainersRunning}/${info.ContainersPaused}/${info.Images}`
      if (this.eventStream && this.lastPing && this.lastPing.shape !== shape && this.lastEventAt < this.lastPing.at) {
        this.eventStream.destroy()
        this.eventStream = null
      }
      this.lastPing = { at: Date.now(), shape }
      if (!this.eventStream) void this.watchEvents()
      // The engine Tender was told to use is back: prefer it over the WSL stand-in.
      if (this.bridged && this.pipeUp(this.bridged)) void this.reconnect()
      else this.schedulePing(15_000)
    } catch (e) {
      this.docker = null
      this.eventStream?.destroy()
      this.eventStream = null
      this.failures++
      const wsl = this.wslMiss ? `; also looked in WSL: ${this.wslMiss}` : ''
      this.setStatus({ state: 'error', endpoint: this.endpoint.address, error: `${toApiError(e).message} (from ${this.endpoint.source}${wsl})`, ...(this.wslLost ? { repair: this.wslLost } : {}), ...(this.wslStuck ? { wslStuck: true } : {}) })
      // The distribution went away: drop the bridge so the next try looks again from the start.
      if (this.bridge) {
        this.closeBridge()
        this.endpoint = endpointFor(this.choice)
      }
      // 2 s, 4 s, 8 s, then every 10 s while unreachable.
      this.schedulePing(Math.min(10_000, 1000 * 2 ** this.failures))
    }
  }

  private schedulePing(ms: number) {
    clearTimeout(this.pingTimer)
    this.pingTimer = setTimeout(() => void this.connect(), ms)
  }

  private api(): Docker {
    if (!this.docker || this.status.state !== 'running') throw new ApiError(`Can’t reach the engine at ${this.endpoint.address}`, 503)
    return this.docker
  }

  private async call<T>(fn: (d: Docker) => Promise<T>): Promise<T> {
    try {
      return await fn(this.api())
    } catch (e) {
      const err = toApiError(e)
      // A broken pipe mid-call means the engine went away: check now instead of waiting for the ping.
      if (!err.status || err.status === 503) void this.connect()
      throw err
    }
  }

  // ---- events (one long-lived stream) --------------------------------------------

  private async watchEvents() {
    const docker = this.docker
    if (!docker) return
    try {
      const stream = (await docker.getEvents({ filters: { type: ['container', 'image', 'volume', 'network'] } })) as unknown as Readable
      this.eventStream = stream
      this.lastEventAt = Date.now()
      // Whatever happened while no stream was open is lost: have every list refetch once.
      this.eventListeners.forEach((fn) => fn((['container', 'image', 'volume', 'network'] as const).map((type) => ({ type, action: 'resync', id: '' }))))
      let buf = ''
      stream.on('data', (chunk: Buffer) => {
        this.lastEventAt = Date.now()
        buf += chunk.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        const batch: EngineEvent[] = []
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as { Type: string; Action: string; Actor?: { ID: string; Attributes?: Record<string, string> } }
            // exec_* and health checks fire constantly and change nothing the lists show.
            if (ev.Action.startsWith('exec_') || ev.Action.startsWith('health_status') || ev.Action === 'mount' || ev.Action === 'unmount') continue
            const id = ev.Actor?.ID ?? ''
            batch.push({ type: ev.Type as EngineEvent['type'], action: ev.Action, id })
            if (ev.Type === 'container' && ev.Action === 'die') {
              const code = Number(ev.Actor?.Attributes?.exitCode ?? 0)
              // 130/137/143: stopped on purpose (docker stop, compose down, Ctrl+C), not a crash.
              const expected = this.stopping.has(id) || code === 0 || code === 130 || code === 137 || code === 143
              if (!expected) this.dieListeners.forEach((fn) => fn({ id, name: ev.Actor?.Attributes?.name ?? id.slice(0, 12), exitCode: code }))
              this.signalListeners.forEach((fn) => fn({ kind: 'die', id, name: ev.Actor?.Attributes?.name ?? id.slice(0, 12), exitCode: code, expected: this.stopping.has(id) }))
            }
            if (ev.Type === 'container' && ev.Action === 'oom') {
              this.signalListeners.forEach((fn) => fn({ kind: 'oom', id, name: ev.Actor?.Attributes?.name ?? id.slice(0, 12), exitCode: 137, expected: false }))
            }
          } catch {
            // A partial or unknown line: skip it.
          }
        }
        if (batch.length) this.eventListeners.forEach((fn) => fn(batch))
      })
      const restart = () => {
        if (this.eventStream !== stream) return
        this.eventStream = null
        // Stream dropped: the ping job will notice an outage; if the engine is fine, resubscribe.
        if (this.status.state === 'running') setTimeout(() => void this.watchEvents(), 1000)
      }
      stream.on('end', restart)
      stream.on('error', restart)
      stream.on('close', restart)
    } catch {
      setTimeout(() => this.status.state === 'running' && !this.eventStream && void this.watchEvents(), 2000)
    }
  }

  // ---- containers ---------------------------------------------------------------

  /** Start time and exit code per container, filled in by inspect; keyed by state so it refreshes on change. */
  private detailCache = new Map<string, { key: string; startedAt?: string; exitCode?: number; env: string[] }>()
  private filling = false

  async listContainers(): Promise<ContainerRow[]> {
    return this.call(async (d) => {
      // Tunnel helpers are shown as tunnels, not as containers of their own.
      const list = (await d.listContainers({ all: true })).filter((c) => c.Labels?.['io.github.tender.helper'] !== 'tunnel')
      const missing = list.filter((c) => this.detailCache.get(c.Id)?.key !== c.State)
      // Inspecting every container serially over the pipe takes seconds; answer
      // now and fill start times in behind, then tell the renderer to refetch.
      if (missing.length) void this.fillDetails(d, missing)
      return list.map((c): ContainerRow => {
        const cached = this.detailCache.get(c.Id)
        const labels = c.Labels ?? {}
        const mounts: Mount[] = (c.Mounts ?? []).map((m) => ({
          type: m.Type === 'volume' ? 'volume' : m.Type === 'tmpfs' ? 'tmpfs' : 'bind',
          source: m.Type === 'volume' ? (m.Name ?? m.Source) : m.Source,
          destination: m.Destination,
          rw: m.RW,
        }))
        const exit = /Exited \((\d+)\)/.exec(c.Status)
        return {
          id: c.Id,
          name: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
          image: c.Image.startsWith('sha256:') ? c.Image.slice(7, 19) : c.Image,
          imageId: c.ImageID,
          command: c.Command,
          state: stateOf(c.State),
          exitCode: exit ? Number(exit[1]) || undefined : cached?.exitCode,
          createdAt: new Date(c.Created * 1000).toISOString(),
          startedAt: cached?.key === c.State ? cached.startedAt : undefined,
          ports: dedupePorts(c.Ports ?? []),
          mounts,
          env: cached?.env ?? [],
          labels,
          project: labels['com.docker.compose.project'],
          service: labels['com.docker.compose.service'],
        }
      })
    })
  }

  private async fillDetails(d: Docker, list: Docker.ContainerInfo[]) {
    if (this.filling) return
    this.filling = true
    try {
      for (let i = 0; i < list.length; i += 6) {
        await Promise.all(
          list.slice(i, i + 6).map(async (c) => {
            const info = await d.getContainer(c.Id).inspect().catch(() => null)
            if (!info) return
            const started = info.State?.StartedAt
            this.detailCache.set(c.Id, { key: c.State, startedAt: started && !started.startsWith('0001') ? started : undefined, exitCode: info.State?.ExitCode || undefined, env: info.Config?.Env ?? [] })
          }),
        )
      }
      // Same path as a real event: the renderer refetches the list once.
      this.eventListeners.forEach((fn) => fn([{ type: 'container', action: 'details', id: '' }]))
    } finally {
      this.filling = false
    }
  }

  inspectContainer(id: string) {
    return this.call((d) => d.getContainer(id).inspect() as unknown as Promise<Record<string, unknown>>)
  }

  async containerAction(ids: string[], action: ContainerAction): Promise<ActionResult[]> {
    const d = this.api()
    const run = async (id: string): Promise<ActionResult> => {
      const c = d.getContainer(id)
      try {
        if (action === 'stop') this.stopping.add(id)
        if (action === 'restart') this.stopping.add(id)
        if (action === 'start') await c.start()
        else if (action === 'stop') await c.stop()
        else if (action === 'restart') await c.restart()
        else if (action === 'pause') await c.pause()
        else await c.unpause()
        return { id, ok: true }
      } catch (e) {
        const err = toApiError(e)
        // 304: already in that state. 404: gone. Both count as done.
        if (err.status === 304 || err.status === 404) return { id, ok: true }
        return { id, ok: false, error: err.message }
      } finally {
        // The die event arrives shortly after; forget the id once it has.
        setTimeout(() => this.stopping.delete(id), 15_000)
      }
    }
    // A few at a time: a Compose project can have many services.
    const out: ActionResult[] = []
    for (let i = 0; i < ids.length; i += 4) out.push(...(await Promise.all(ids.slice(i, i + 4).map(run))))
    return out
  }

  async removeContainers(ids: string[], force = false): Promise<ActionResult[]> {
    const d = this.api()
    return Promise.all(
      ids.map(async (id) => {
        try {
          this.stopping.add(id)
          await d.getContainer(id).remove({ force, v: false })
          return { id, ok: true }
        } catch (e) {
          const err = toApiError(e)
          if (err.status === 404) return { id, ok: true }
          return { id, ok: false, error: err.status === 409 ? 'It’s running. Stop it first.' : err.message }
        }
      }),
    )
  }

  async runCommand(id: string): Promise<string> {
    const info = (await this.inspectContainer(id)) as unknown as Docker.ContainerInspectInfo
    const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`)
    const parts = ['docker run -d', `--name ${q(info.Name.replace(/^\//, ''))}`]
    for (const [port, binds] of Object.entries(info.HostConfig.PortBindings ?? {})) {
      for (const b of (binds as { HostIp?: string; HostPort?: string }[]) ?? []) {
        const [p, proto] = port.split('/')
        parts.push(`-p ${b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '' ? b.HostIp + ':' : ''}${b.HostPort}:${p}${proto === 'udp' ? '/udp' : ''}`)
      }
    }
    for (const m of info.Mounts ?? []) parts.push(`-v ${q(`${m.Type === 'volume' ? m.Name : m.Source}:${m.Destination}${m.RW ? '' : ':ro'}`)}`)
    // Image defaults (PATH etc.) are left out; only what this container set.
    const imageEnv = new Set(((await this.call((d) => d.getImage(info.Image).inspect()).catch(() => null))?.Config?.Env as string[] | undefined) ?? [])
    for (const e of info.Config.Env ?? []) if (!imageEnv.has(e)) parts.push(`-e ${q(e)}`)
    if (info.HostConfig.RestartPolicy?.Name && info.HostConfig.RestartPolicy.Name !== 'no') parts.push(`--restart ${info.HostConfig.RestartPolicy.Name}`)
    parts.push(q(info.Config.Image))
    return parts.join(' \\\n  ')
  }

  // ---- logs -----------------------------------------------------------------------

  /**
   * Streams a container's logs: the last `tail` lines, then new ones as they
   * come. Lines are batched for 50 ms so a chatty container can't flood IPC.
   */
  subscribeLogs(id: string, tail: number, cb: (lines: LogLine[]) => void): () => void {
    let closed = false
    let source: Readable | null = null
    let pending: LogLine[] = []
    let timer: NodeJS.Timeout | undefined
    const flush = () => {
      timer = undefined
      if (pending.length && !closed) cb(pending)
      pending = []
    }
    const push = (stream: LogLine['stream']) => {
      let partial = ''
      return (chunk: Buffer) => {
        const lines = (partial + chunk.toString('utf8')).split('\n')
        partial = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '')
          const sp = line.indexOf(' ')
          // With timestamps=1 every line starts with an RFC3339Nano time.
          const ts = sp > 0 && /^\d{4}-\d\d-\d\dT/.test(line) ? line.slice(0, sp) : new Date().toISOString()
          pending.push({ ts, stream, text: sp > 0 && line.startsWith(ts) ? line.slice(sp + 1) : line })
        }
        if (pending.length > 2000) flush()
        else timer ??= setTimeout(flush, 50)
      }
    }
    void (async () => {
      try {
        const d = this.api()
        const c = d.getContainer(id)
        const info = await c.inspect()
        const s = (await c.logs({ follow: true, stdout: true, stderr: true, tail, timestamps: true })) as unknown as Readable
        if (closed) return s.destroy()
        source = s
        if (info.Config.Tty) {
          // TTY containers send one raw stream.
          s.on('data', push('stdout'))
        } else {
          const out = new PassThrough()
          const err = new PassThrough()
          d.modem.demuxStream(s, out, err)
          out.on('data', push('stdout'))
          err.on('data', push('stderr'))
        }
        // An empty history still answers, so the UI can leave "Loading".
        setTimeout(() => !closed && pending.length === 0 && cb([]), 300)
      } catch (e) {
        if (!closed) cb([{ ts: new Date().toISOString(), stream: 'stderr', text: `Tender couldn’t read these logs: ${toApiError(e).message}` }])
      }
    })()
    return () => {
      closed = true
      clearTimeout(timer)
      source?.destroy()
    }
  }

  // ---- stats (one stream per container, shared between subscribers) ------------------

  private statStreams = new Map<string, { stream: Readable | null; subs: Set<(s: StatsSample) => void>; closed: boolean }>()

  subscribeStats(ids: string[], cb: (samples: StatsSample[]) => void): () => void {
    const each = (s: StatsSample) => cb([s])
    for (const id of ids) {
      let entry = this.statStreams.get(id)
      if (!entry) {
        entry = { stream: null, subs: new Set(), closed: false }
        this.statStreams.set(id, entry)
        void this.openStats(id, entry)
      }
      entry.subs.add(each)
    }
    return () => {
      for (const id of ids) {
        const entry = this.statStreams.get(id)
        if (!entry) continue
        entry.subs.delete(each)
        if (!entry.subs.size) {
          entry.closed = true
          entry.stream?.destroy()
          this.statStreams.delete(id)
        }
      }
    }
  }

  private async openStats(id: string, entry: { stream: Readable | null; subs: Set<(s: StatsSample) => void>; closed: boolean }) {
    try {
      const s = (await this.api().getContainer(id).stats({ stream: true })) as unknown as Readable
      if (entry.closed) return s.destroy()
      entry.stream = s
      let buf = ''
      s.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const sample = toSample(id, JSON.parse(line))
            if (sample) entry.subs.forEach((fn) => fn(sample))
          } catch {
            // ignore partial JSON
          }
        }
      })
      s.on('error', () => undefined)
    } catch {
      // Container stopped or gone: the stats tab shows its own message.
    }
  }

  // ---- exec ---------------------------------------------------------------------------

  async openExec(id: string, shell: string, cols: number, rows: number, onData: (d: string) => void, onExit: (code: number) => void) {
    if (shell === 'debug') return this.openDebug(id, cols, rows, onData, onExit)
    const d = this.api()
    const c = d.getContainer(id)
    const info = await c.inspect().catch((e) => {
      throw toApiError(e)
    })
    if (!info.State.Running) throw new ApiError(`${info.Name.replace(/^\//, '')} isn’t running. Start it to open a terminal.`, 409)
    if (info.State.Paused) throw new ApiError('The container is paused. Resume it to open a terminal.', 409)
    const exec = await c
      .exec({ Cmd: [shell], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Env: [`COLUMNS=${cols}`, `LINES=${rows}`, 'TERM=xterm-256color'] })
      .catch((e) => {
        throw toApiError(e)
      })
    const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as NodeJS.ReadWriteStream & { destroy(): void }
    let ended = false
    const startedAt = Date.now()
    let firstOutput = ''
    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (Date.now() - startedAt < 2000) firstOutput += text
      onData(text)
    })
    stream.on('end', async () => {
      if (ended) return
      ended = true
      const code = (await exec.inspect().catch(() => null))?.ExitCode ?? 0
      onExit(code ?? 0)
    })
    await exec.resize({ h: rows, w: cols }).catch(() => undefined)
    // A missing shell shows up as a quick exit with "executable file not found".
    setTimeout(() => {
      if (ended && /executable file not found|no such file/i.test(firstOutput)) onData(`\r\n\x1b[33mThis image has no ${shell}. Pick “Debug shell (BusyBox)” from the list: it works even when the image has no shell at all.\x1b[0m\r\n`)
    }, 600)
    return {
      write: (data: string) => !ended && stream.write(data),
      resize: (c2: number, r2: number) => void exec.resize({ h: r2, w: c2 }).catch(() => undefined),
      close: () => {
        ended = true
        stream.destroy()
      },
    }
  }

  /**
   * A shell for a container that has none (distroless, scratch images). A
   * BusyBox helper joins the container's process and network namespaces: its
   * processes show in ps, its files are under /proc/1/root, its network is the
   * helper's. The container itself is not changed, and the helper is removed
   * when the shell ends.
   */
  private async openDebug(id: string, cols: number, rows: number, onData: (d: string) => void, onExit: (code: number) => void) {
    const d = this.api()
    const info = await d
      .getContainer(id)
      .inspect()
      .catch((e) => {
        throw toApiError(e)
      })
    const name = info.Name.replace(/^\//, '')
    if (!info.State.Running) throw new ApiError(`${name} isn’t running. Start it to debug it.`, 409)
    if (info.State.Paused) throw new ApiError('The container is paused. Resume it to debug it.', 409)
    const image = 'busybox:1.36'
    if (!(await d.getImage(image).inspect().catch(() => null))) {
      onData(`Getting ${image} for the debug shell…\r\n`)
      const s = (await d.pull(image)) as unknown as Readable
      await new Promise<void>((resolve, reject) => {
        s.on('data', () => undefined)
        s.on('end', resolve)
        s.on('error', reject)
      })
    }
    const banner = [
      `Debug shell for ${name} (BusyBox).`,
      'Its processes: ps.  Its files: /proc/1/root (you are there).  Its network: this one.',
      'Nothing here changes the container; this helper goes away when you exit.',
      '',
    ].join('\r\n')
    const helper = await d.createContainer({
      Image: image,
      Cmd: ['sh', '-c', 'cd /proc/1/root 2>/dev/null; printf "%s\\r\\n" "$BANNER"; exec sh'],
      Env: [`BANNER=${banner}`, 'TERM=xterm-256color', `COLUMNS=${cols}`, `LINES=${rows}`, 'PS1=debug:\\w# '],
      Tty: true,
      OpenStdin: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Labels: { 'io.github.tender.helper': 'debug', 'io.github.tender.debug-target': info.Id },
      HostConfig: {
        PidMode: `container:${info.Id}`,
        NetworkMode: info.HostConfig.NetworkMode === 'host' ? 'host' : `container:${info.Id}`,
        // Reading another process's /proc/<pid>/root needs ptrace rights.
        CapAdd: ['SYS_PTRACE'],
        AutoRemove: true,
      },
    })
    const stream = (await helper.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true })) as unknown as NodeJS.ReadWriteStream & { destroy(): void }
    let ended = false
    stream.on('data', (chunk: Buffer) => onData(chunk.toString('utf8')))
    stream.on('end', async () => {
      if (ended) return
      ended = true
      const code = (await helper.inspect().catch(() => null))?.State?.ExitCode ?? 0
      onExit(code)
    })
    await helper.start()
    await helper.resize({ h: rows, w: cols }).catch(() => undefined)
    return {
      write: (data: string) => !ended && stream.write(data),
      resize: (c2: number, r2: number) => void helper.resize({ h: r2, w: c2 }).catch(() => undefined),
      close: () => {
        ended = true
        stream.destroy()
        void helper.remove({ force: true }).catch(() => undefined)
      },
    }
  }

  // ---- Compose projects (by label) -------------------------------------------------------

  private async projectIds(project: string) {
    const list = await this.call((d) => d.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${project}`] } }))
    return list.map((c) => c.Id)
  }

  async composeAction(project: string, action: ContainerAction) {
    return this.containerAction(await this.projectIds(project), action)
  }

  async composeRemove(project: string) {
    return this.removeContainers(await this.projectIds(project), true)
  }

  // ---- images -----------------------------------------------------------------------------

  private archCache = new Map<string, string>()

  async listImages(): Promise<ImageRow[]> {
    return this.call(async (d) => {
      const [images, containers] = await Promise.all([d.listImages({ all: false }), d.listContainers({ all: true })])
      const used = new Set(containers.map((c) => c.ImageID))
      // An image ID never changes its architecture: inspect each one once.
      const archs = await Promise.all(
        images.map(async (i) => {
          if (!this.archCache.has(i.Id)) this.archCache.set(i.Id, await d.getImage(i.Id).inspect().then((x) => normArch(x.Architecture)).catch(() => 'unknown'))
          return this.archCache.get(i.Id)!
        }),
      )
      return images.map((i, n) => {
        const tags = (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>')
        return {
          id: i.Id,
          tags,
          size: i.Size,
          createdAt: new Date(i.Created * 1000).toISOString(),
          arch: archs[n],
          emulated: archs[n] !== 'unknown' && archs[n] !== this.hostArch,
          inUse: used.has(i.Id),
          dangling: tags.length === 0,
        }
      })
    })
  }

  async inspectImage(id: string): Promise<ImageDetail> {
    return this.call(async (d) => {
      const img = d.getImage(id)
      const [info, history] = await Promise.all([img.inspect(), img.history() as Promise<{ Id: string; Created: number; CreatedBy: string; Size: number }[]>])
      const containers = await d.listContainers({ all: true, filters: { ancestor: [id] } })
      const tags = (info.RepoTags ?? []).filter((t) => t !== '<none>:<none>')
      const arch = normArch(info.Architecture)
      return {
        image: { id: info.Id, tags, size: info.Size, createdAt: info.Created, arch, emulated: arch !== this.hostArch, inUse: containers.length > 0, dangling: !tags.length },
        // history is newest first; show build order.
        layers: history
          .slice()
          .reverse()
          .map((h) => ({ id: h.Id, createdBy: h.CreatedBy.replace(/^\/bin\/sh -c #\(nop\)\s+/, '').trim(), size: h.Size, createdAt: new Date(h.Created * 1000).toISOString() })),
        env: info.Config?.Env ?? [],
        cmd: [...(info.Config?.Entrypoint ?? []), ...(info.Config?.Cmd ?? [])].join(' ') || '—',
        exposedPorts: Object.keys(info.Config?.ExposedPorts ?? {}),
      }
    })
  }

  private dfCache: { at: number; value: Promise<any> } | null = null

  /** /system/df is slow (seconds); share one answer for 20 s between the images and volumes screens. */
  private systemDf(d: Docker): Promise<any> {
    if (!this.dfCache || Date.now() - this.dfCache.at > 20_000) {
      const value = d.df()
      this.dfCache = { at: Date.now(), value }
      value.catch(() => (this.dfCache = null))
    }
    return this.dfCache.value
  }

  /** Build cache: total, and how much is not in use (what pruning frees). */
  async buildCache(): Promise<{ total: number; reclaimable: number }> {
    return this.call(async (d) => {
      const df = (await this.systemDf(d)) as { BuildCache?: { Size: number; InUse: boolean; Shared: boolean }[] }
      const c = df.BuildCache ?? []
      return { total: c.reduce((n, x) => n + (x.Shared ? 0 : x.Size), 0), reclaimable: c.filter((x) => !x.InUse && !x.Shared).reduce((n, x) => n + x.Size, 0) }
    })
  }

  async pruneBuildCache(): Promise<number> {
    return this.call(async (d) => {
      const r = (await d.pruneBuilder()) as { SpaceReclaimed?: number }
      this.dfCache = null
      return r.SpaceReclaimed ?? 0
    })
  }

  async diskUsage(): Promise<DiskUsage> {
    return this.call(async (d) => {
      const df = (await this.systemDf(d)) as { LayersSize?: number; Images?: { Id: string; Size: number; SharedSize: number; Containers: number }[] }
      const images = df.Images ?? []
      const sharedSize = Object.fromEntries(images.map((i) => [i.Id, Math.max(0, i.SharedSize)]))
      const reclaimable = images.filter((i) => i.Containers === 0).reduce((s, i) => s + i.Size - Math.max(0, i.SharedSize), 0)
      return { imagesTotal: df.LayersSize ?? images.reduce((s, i) => s + i.Size, 0), imagesReclaimable: reclaimable, sharedSize }
    })
  }

  /**
   * Pulls an image, reporting per-layer progress. Resolves when done, rejects
   * with the registry's message (not found, auth required) or when cancelled.
   * Uses the login saved in Settings › Registries for the image's registry, if any.
   */
  pull(reference: string, onProgress: (layers: LayerProgress[]) => void): { done: Promise<void>; cancel: () => void } {
    let stream: Readable | null = null
    let cancelled = false
    const layers = new Map<string, LayerProgress>()
    const done = (async () => {
      const d = this.api()
      const ref = /[:@]/.test(reference.split('/').pop() ?? '') ? reference : `${reference}:latest`
      try {
        const authconfig = authFor(registryOf(ref))
        stream = (await d.pull(ref, authconfig ? { authconfig } : {})) as unknown as Readable
      } catch (e) {
        const err = toApiError(e)
        if (err.status === 404 || /not found|manifest unknown|repository does not exist/i.test(err.message)) throw new ApiError(`No image called ${ref} was found. Check the name and tag.`, 404)
        if (/unauthorized|denied|authentication required/i.test(err.message)) throw new ApiError(`${ref} needs a login. Add one for ${registryOf(ref)} in Settings › Registries, then try again.`, 401)
        throw err
      }
      if (cancelled) {
        stream.destroy()
        throw new ApiError('Pull cancelled.', 499)
      }
      let last = 0
      await new Promise<void>((resolve, reject) => {
        d.modem.followProgress(
          stream!,
          (err: unknown, output: { error?: string; errorDetail?: { message?: string } }[]) => {
            if (cancelled) return reject(new ApiError('Pull cancelled.', 499))
            const failed = err ?? output?.find((o) => o.error)
            if (failed) {
              const msg = toApiError(err ?? new Error((failed as { error?: string }).error)).message
              return reject(/unauthorized|denied/i.test(msg) ? new ApiError(`${ref} needs a login. Add one for ${registryOf(ref)} in Settings › Registries, then try again.`, 401) : new ApiError(msg))
            }
            onProgress([...layers.values()].map((l) => ({ ...l, status: 'done' })))
            resolve()
          },
          (ev: { id?: string; status?: string; progressDetail?: { current?: number; total?: number } }) => {
            if (!ev.id || !ev.status || ev.id === ref.split(':').pop()) return
            const s = ev.status
            const prev = layers.get(ev.id) ?? { id: ev.id, status: 'waiting' as const }
            const status: LayerProgress['status'] = /pull complete|already exists/i.test(s)
              ? 'done'
              : /extracting|verifying|download complete/i.test(s)
                ? 'extracting'
                : /downloading/i.test(s)
                  ? 'downloading'
                  : prev.status
            layers.set(ev.id, { id: ev.id.slice(0, 12), status, current: ev.progressDetail?.current ?? prev.current, total: ev.progressDetail?.total ?? prev.total })
            // At most ~6 updates a second over IPC.
            if (Date.now() - last > 150) {
              last = Date.now()
              onProgress([...layers.values()])
            }
          },
        )
      })
    })()
    return {
      done,
      cancel: () => {
        cancelled = true
        stream?.destroy()
      },
    }
  }

  exportVolume(name: string, file: string) {
    return this.call((d) => snapshots.exportVolume(d, name, file))
  }

  restoreVolume(name: string, file: string) {
    return this.call((d) => snapshots.restoreVolume(d, name, file))
  }

  listTunnels() {
    return this.call((d) => tunnels.list(d))
  }

  openTunnel(containerId: string, port: number) {
    return this.call((d) => tunnels.open(d, containerId, port))
  }

  closeTunnel(id: string) {
    return this.call((d) => tunnels.close(d, id))
  }

  /** On quit: a temporary link must not outlive the app that made it. */
  async closeAllTunnels() {
    if (this.docker) await tunnels.closeAll(this.docker)
  }

  listFiles(id: string, path: string) {
    return this.call((d) => files.list(d, id, path))
  }

  downloadFile(id: string, path: string, isDir: boolean, choose: (name: string, folder: boolean) => Promise<string | null>) {
    return this.call((d) => files.download(d, id, path, isDir, choose))
  }

  uploadFiles(id: string, dir: string, paths: string[]) {
    return this.call((d) => files.upload(d, id, dir, paths))
  }

  containerChanges(id: string) {
    return this.call((d) => files.changes(d, id))
  }

  scanImage(reference: string, onPhase: (p: ScanPhase) => void) {
    return scan(this.api(), reference, onPhase)
  }

  async tagImage(id: string, reference: string): Promise<void> {
    const { repo, tag } = splitRef(reference)
    await this.call((d) => d.getImage(id).tag({ repo, tag }))
  }

  /** Pushes a tagged image. Progress is per layer, like a pull. */
  push(reference: string, onProgress: (layers: LayerProgress[]) => void): { done: Promise<void>; cancel: () => void } {
    let stream: Readable | null = null
    let cancelled = false
    const layers = new Map<string, LayerProgress>()
    const { repo, tag } = splitRef(reference)
    const registry = registryOf(repo)
    const needsLogin = () =>
      new ApiError(
        authFor(registry)
          ? `The registry refused the push. The login for ${registry} may not be allowed to write to ${repo}.`
          : `Pushing to ${registry} needs a login. Add one in Settings › Registries, then try again.`,
        401,
      )
    const denied = (m: string) => /unauthorized|denied|authentication required|insufficient_scope/i.test(m)
    const done = (async () => {
      const d = this.api()
      const authconfig = authFor(registry) ?? { serveraddress: engineAddress(registry) }
      try {
        stream = (await d.getImage(repo).push({ tag, authconfig })) as unknown as Readable
      } catch (e) {
        const err = toApiError(e)
        if (err.status === 404) throw new ApiError(`There is no image called ${repo}:${tag} on this machine. Tag it first.`, 404)
        if (denied(err.message)) throw needsLogin()
        throw err
      }
      if (cancelled) {
        stream.destroy()
        throw new ApiError('Push cancelled.', 499)
      }
      let last = 0
      await new Promise<void>((resolve, reject) => {
        d.modem.followProgress(
          stream!,
          (err: unknown, output: { error?: string }[]) => {
            if (cancelled) return reject(new ApiError('Push cancelled.', 499))
            const failed = err ?? output?.find((o) => o.error)
            if (failed) {
              const msg = toApiError(err ?? new Error((failed as { error?: string }).error)).message
              return reject(denied(msg) ? needsLogin() : new ApiError(msg))
            }
            onProgress([...layers.values()].map((l) => ({ ...l, status: 'done' })))
            resolve()
          },
          (ev: { id?: string; status?: string; progressDetail?: { current?: number; total?: number } }) => {
            if (!ev.id || !ev.status || ev.id === tag) return
            const prev = layers.get(ev.id) ?? { id: ev.id.slice(0, 12), status: 'waiting' as const }
            const status: LayerProgress['status'] = /pushed|already exists|mounted from/i.test(ev.status) ? 'done' : /pushing/i.test(ev.status) ? 'downloading' : prev.status
            layers.set(ev.id, { ...prev, status, current: ev.progressDetail?.current ?? prev.current, total: ev.progressDetail?.total ?? prev.total })
            if (Date.now() - last > 150) {
              last = Date.now()
              onProgress([...layers.values()])
            }
          },
        )
      })
    })()
    return {
      done,
      cancel: () => {
        cancelled = true
        stream?.destroy()
      },
    }
  }

  /** Asks the registry whether a login works, before Tender keeps it. */
  async checkLogin(server: string, username: string, password: string): Promise<void> {
    try {
      await this.call((d) => d.checkAuth({ username, password, serveraddress: engineAddress(server) }))
    } catch (e) {
      const err = toApiError(e)
      if (err.status === 401 || /unauthorized|incorrect|denied/i.test(err.message)) throw new ApiError(`${server} didn’t accept that user name and password.`, 401)
      if (/no such host|timeout|connection refused|dial tcp/i.test(err.message)) throw new ApiError(`The engine couldn’t reach ${server}. Check the address.`, 502)
      throw err
    }
  }

  async removeImages(ids: string[], force = false): Promise<ActionResult[]> {
    const d = this.api()
    const results: ActionResult[] = []
    for (const id of ids) {
      try {
        await d.getImage(id).remove({ force })
        results.push({ id, ok: true })
      } catch (e) {
        const err = toApiError(e)
        if (err.status === 404) results.push({ id, ok: true })
        else results.push({ id, ok: false, error: err.status === 409 ? `In use: ${err.message.replace(/^.*?(container [0-9a-f]+).*$/i, 'by $1')}. Remove that container first.` : err.message })
      }
    }
    return results
  }

  async pruneImages(scope: 'dangling' | 'unused') {
    return this.call(async (d) => {
      const r = (await d.pruneImages({ filters: { dangling: [scope === 'dangling' ? 'true' : 'false'] } })) as { ImagesDeleted?: { Untagged?: string; Deleted?: string }[]; SpaceReclaimed?: number }
      const deleted = (r.ImagesDeleted ?? []).map((x) => x.Untagged ?? x.Deleted ?? '').filter(Boolean)
      return { deleted, spaceReclaimed: r.SpaceReclaimed ?? 0 }
    })
  }

  async run(spec: RunSpec): Promise<{ containerId: string }> {
    return this.call(async (d) => {
      const ExposedPorts: Record<string, object> = {}
      const PortBindings: Record<string, { HostPort: string }[]> = {}
      for (const p of spec.ports) {
        ExposedPorts[`${p.container}/tcp`] = {}
        PortBindings[`${p.container}/tcp`] = [...(PortBindings[`${p.container}/tcp`] ?? []), { HostPort: p.host }]
      }
      let created: Docker.Container
      try {
        created = await d.createContainer({
          Image: spec.image,
          name: spec.name,
          Env: spec.env.map((e) => `${e.key}=${e.value}`),
          ExposedPorts,
          HostConfig: { PortBindings, Binds: spec.volumes.map((v) => `${v.source}:${v.target}`) },
        })
      } catch (e) {
        const err = toApiError(e)
        if (err.status === 409) throw new ApiError(`A container called ${spec.name} already exists.`, 409)
        if (err.status === 404) throw new ApiError(`Image ${spec.image} isn’t on this machine. Pull it first.`, 404)
        throw err
      }
      try {
        await created.start()
      } catch (e) {
        // Don't leave a half-made container behind (e.g. the host port was taken).
        await created.remove({ force: true }).catch(() => undefined)
        const err = toApiError(e)
        const port = err.message.match(/(?:Bind for|bind:? )[^:]*:(\d+)|port (\d+)|:(\d+) failed/i)
        if (/port is already allocated|address already in use|ports are not available/i.test(err.message)) {
          throw new ApiError(`A host port you chose is already in use${port ? ` (${port[1] ?? port[2] ?? port[3]})` : ''}. Pick another one.`, 409)
        }
        throw err
      }
      return { containerId: created.id }
    })
  }

  // ---- volumes ---------------------------------------------------------------------------------

  async listVolumes(): Promise<VolumeRow[]> {
    return this.call(async (d) => {
      const [{ Volumes }, containers, df] = await Promise.all([
        d.listVolumes(),
        d.listContainers({ all: true }),
        this.systemDf(d).catch(() => ({ Volumes: [] })) as Promise<{ Volumes?: { Name: string; UsageData?: { Size: number } }[] }>,
      ])
      const sizes = new Map((df.Volumes ?? []).map((v) => [v.Name, Math.max(0, v.UsageData?.Size ?? 0)]))
      return (Volumes ?? []).map((v) => ({
        name: v.Name,
        driver: v.Driver,
        createdAt: (v as { CreatedAt?: string }).CreatedAt ?? new Date(0).toISOString(),
        size: sizes.get(v.Name) ?? 0,
        usedBy: containers.filter((c) => c.Mounts?.some((m) => m.Type === 'volume' && m.Name === v.Name)).map((c) => (c.Names?.[0] ?? c.Id).replace(/^\//, '')),
      }))
    })
  }

  async createVolume(name: string): Promise<VolumeRow> {
    return this.call(async (d) => {
      const existing = await d.listVolumes({ filters: { name: [name] } })
      if (existing.Volumes?.some((v) => v.Name === name)) throw new ApiError(`A volume called ${name} already exists.`, 409)
      const v = (await d.createVolume({ Name: name })) as unknown as { Name: string; Driver: string; CreatedAt?: string }
      return { name: v.Name, driver: v.Driver, createdAt: v.CreatedAt ?? new Date().toISOString(), size: 0, usedBy: [] }
    })
  }

  async removeVolumes(names: string[]): Promise<(ActionResult & { usedBy?: string[] })[]> {
    const d = this.api()
    const containers = await this.call((x) => x.listContainers({ all: true }))
    return Promise.all(
      names.map(async (name) => {
        const usedBy = containers.filter((c) => c.Mounts?.some((m) => m.Type === 'volume' && m.Name === name)).map((c) => (c.Names?.[0] ?? c.Id).replace(/^\//, ''))
        if (usedBy.length) return { id: name, ok: false, usedBy, error: `In use by ${usedBy.join(', ')}.` }
        try {
          await d.getVolume(name).remove()
          return { id: name, ok: true }
        } catch (e) {
          const err = toApiError(e)
          if (err.status === 404) return { id: name, ok: true }
          return { id: name, ok: false, error: err.message }
        }
      }),
    )
  }

  async volumeUsage(name: string): Promise<VolumeUsage[]> {
    return this.call(async (d) => {
      const list = await d.listContainers({ all: true, filters: { volume: [name] } })
      return list.map((c) => ({
        containerId: c.Id,
        containerName: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
        image: c.Image,
        target: c.Mounts?.find((m) => m.Name === name)?.Destination ?? '',
        ports: dedupePorts(c.Ports ?? [])
          .map((p) => (p.publicPort ? `${p.publicPort}:${p.privatePort}` : String(p.privatePort)))
          .join(', '),
      }))
    })
  }
  // ---- networks --------------------------------------------------------------------------------

  async listNetworks(): Promise<NetworkRow[]> {
    return this.call(async (d) => {
      const [nets, containers] = await Promise.all([d.listNetworks(), d.listContainers({ all: true })])
      return nets.map((n) => toNetworkRow(n, containers)).sort(byNetwork)
    })
  }

  async createNetwork(spec: NetworkSpec): Promise<NetworkRow> {
    return this.call(async (d) => {
      const existing = await d.listNetworks({ filters: { name: [spec.name] } })
      if (existing.some((n) => n.Name === spec.name)) throw new ApiError(`A network called ${spec.name} already exists.`, 409)
      const created = await d.createNetwork({
        Name: spec.name,
        Driver: 'bridge',
        Internal: spec.internal,
        CheckDuplicate: true,
        ...(spec.subnet ? { IPAM: { Driver: 'default', Config: [{ Subnet: spec.subnet, ...(spec.gateway ? { Gateway: spec.gateway } : {}) }] } } : {}),
      })
      const info = (await created.inspect()) as Docker.NetworkInspectInfo
      return toNetworkRow(info, [])
    })
  }

  async removeNetworks(ids: string[]): Promise<(ActionResult & { usedBy?: string[] })[]> {
    const d = this.api()
    const [nets, containers] = await this.call((x) => Promise.all([x.listNetworks(), x.listContainers({ all: true })]))
    return Promise.all(
      ids.map(async (id) => {
        const n = nets.find((x) => x.Id === id)
        if (!n) return { id, ok: true }
        if (BUILT_IN_NETWORKS.has(n.Name)) return { id, ok: false, error: `${n.Name} is built into Docker and cannot be removed.` }
        // Docker only refuses while a running container is attached; a stopped one would then fail to start.
        const usedBy = attached(n.Id, containers)
        if (usedBy.length) return { id, ok: false, usedBy, error: `In use by ${usedBy.join(', ')}.` }
        try {
          await d.getNetwork(id).remove()
          return { id, ok: true }
        } catch (e) {
          const err = toApiError(e)
          if (err.status === 404) return { id, ok: true }
          return { id, ok: false, error: err.message }
        }
      }),
    )
  }

  async networkMembers(id: string): Promise<NetworkMember[]> {
    return this.call(async (d) => {
      const containers = await d.listContainers({ all: true })
      return containers.flatMap((c) => {
        const e = Object.values(c.NetworkSettings?.Networks ?? {}).find((x) => x.NetworkID === id)
        if (!e) return []
        return [
          {
            containerId: c.Id,
            containerName: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
            image: c.Image,
            state: c.State as ContainerState,
            ipv4: e.IPAddress || undefined,
            mac: e.MacAddress || undefined,
            aliases: (e.Aliases ?? []).filter((a: string) => !c.Id.startsWith(a)),
          },
        ]
      })
    })
  }

  async connectNetwork(id: string, containerId: string): Promise<void> {
    await this.call((d) => d.getNetwork(id).connect({ Container: containerId }))
  }

  async disconnectNetwork(id: string, containerId: string): Promise<void> {
    await this.call((d) => d.getNetwork(id).disconnect({ Container: containerId }))
  }
}

const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none'])

/** ghcr.io/me/app:1.2 → repo ghcr.io/me/app, tag 1.2. No tag means latest. A port is not a tag. */
export function splitRef(reference: string): { repo: string; tag: string } {
  const slash = reference.lastIndexOf('/')
  const colon = reference.lastIndexOf(':')
  return colon > slash ? { repo: reference.slice(0, colon), tag: reference.slice(colon + 1) } : { repo: reference, tag: 'latest' }
}

/** Container list entries carry their networks by id; a stopped container keeps them too. */
function attached(networkId: string, containers: Docker.ContainerInfo[]): string[] {
  return containers
    .filter((c) => Object.values(c.NetworkSettings?.Networks ?? {}).some((e) => e.NetworkID === networkId))
    .map((c) => (c.Names?.[0] ?? c.Id).replace(/^\//, ''))
}

function toNetworkRow(n: Docker.NetworkInspectInfo, containers: Docker.ContainerInfo[]): NetworkRow {
  const ipam = n.IPAM?.Config?.find((c) => c.Subnet && !c.Subnet.includes(':')) ?? n.IPAM?.Config?.[0]
  return {
    id: n.Id,
    name: n.Name,
    driver: n.Driver,
    scope: n.Scope,
    internal: !!n.Internal,
    ipv6: !!n.EnableIPv6,
    subnet: ipam?.Subnet || undefined,
    gateway: ipam?.Gateway || undefined,
    createdAt: n.Created ?? new Date(0).toISOString(),
    builtIn: BUILT_IN_NETWORKS.has(n.Name),
    project: n.Labels?.['com.docker.compose.project'],
    usedBy: attached(n.Id, containers),
  }
}

/** Built-in networks last: people come here for their own. */
const byNetwork = (a: NetworkRow, b: NetworkRow) => Number(a.builtIn) - Number(b.builtIn) || a.name.localeCompare(b.name)

/** One stats JSON object → a sample. CPU % follows `docker stats`: 100% = one core. */
function toSample(id: string, s: any): StatsSample | null {
  if (!s?.cpu_stats || !s?.memory_stats) return null
  const cpuDelta = (s.cpu_stats.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0)
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0)
  const cpus = s.cpu_stats.online_cpus ?? s.cpu_stats.cpu_usage?.percpu_usage?.length ?? 1
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0
  const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.total_inactive_file ?? s.memory_stats.stats?.cache ?? 0
  const nets = Object.values((s.networks ?? {}) as Record<string, { rx_bytes: number; tx_bytes: number }>)
  const blk = (s.blkio_stats?.io_service_bytes_recursive ?? []) as { op: string; value: number }[]
  const sum = (op: string) => blk.filter((b) => b.op.toLowerCase() === op).reduce((a, b) => a + b.value, 0)
  return {
    id,
    at: Date.parse(s.read) || Date.now(),
    cpuPercent,
    memUsage: Math.max(0, (s.memory_stats.usage ?? 0) - cache),
    memLimit: s.memory_stats.limit ?? 0,
    netRx: nets.reduce((a, n) => a + n.rx_bytes, 0),
    netTx: nets.reduce((a, n) => a + n.tx_bytes, 0),
    blkRead: sum('read'),
    blkWrite: sum('write'),
    pids: s.pids_stats?.current ?? 0,
  }
}
