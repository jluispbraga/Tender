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
  type StatsSample,
  type VolumeRow,
  type VolumeUsage,
} from '../../renderer/src/api/types'
import { dockerOptions, resolveEndpoint, type Endpoint } from './endpoint'

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
 * Everything Harbor asks of Docker Engine, over its public API (dockerode).
 * One instance per app. Keeps the connection healthy (ping job), relays the
 * engine's event stream, and owns every long-lived stream (logs, stats,
 * exec, pulls) so they can be torn down when the renderer goes away.
 */
export class Engine {
  private docker: Docker | null = null
  private endpoint: Endpoint = resolveEndpoint()
  private status: EngineStatus = { state: 'starting', endpoint: this.endpoint.address }
  private pingTimer: NodeJS.Timeout | undefined
  private failures = 0
  private eventStream: Readable | null = null
  private statusListeners = new Set<Listener<EngineStatus>>()
  private eventListeners = new Set<Listener<EngineEvent[]>>()
  private dieListeners = new Set<Listener<{ id: string; name: string; exitCode: number }>>()
  /** Containers Harbor itself is stopping: their exit is expected, not a notification. */
  private stopping = new Set<string>()
  private hostArch = 'amd64'

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

  /** An unexpected container exit (non-zero code, not a stop Harbor asked for). */
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
  }

  async reconnect(): Promise<EngineStatus> {
    clearTimeout(this.pingTimer)
    this.eventStream?.destroy()
    this.eventStream = null
    this.docker = null
    this.endpoint = resolveEndpoint()
    this.setStatus({ state: 'starting', endpoint: this.endpoint.address })
    await this.connect()
    return this.status
  }

  private setStatus(s: EngineStatus) {
    const changed = s.state !== this.status.state || s.error !== this.status.error
    this.status = s
    if (changed) this.statusListeners.forEach((fn) => fn(s))
  }

  private async connect() {
    clearTimeout(this.pingTimer)
    try {
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
      if (!this.eventStream) void this.watchEvents()
      this.schedulePing(15_000)
    } catch (e) {
      this.docker = null
      this.eventStream?.destroy()
      this.eventStream = null
      this.failures++
      this.setStatus({ state: 'error', endpoint: this.endpoint.address, error: `${toApiError(e).message} (from ${this.endpoint.source})` })
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
      const stream = (await docker.getEvents({ filters: { type: ['container', 'image', 'volume'] } })) as unknown as Readable
      this.eventStream = stream
      let buf = ''
      stream.on('data', (chunk: Buffer) => {
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
      const list = await d.listContainers({ all: true })
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
        if (!closed) cb([{ ts: new Date().toISOString(), stream: 'stderr', text: `Harbor couldn’t read these logs: ${toApiError(e).message}` }])
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
      if (ended && /executable file not found|no such file/i.test(firstOutput)) onData(`\r\n\x1b[33mThis image has no ${shell}. Try another shell from the list.\x1b[0m\r\n`)
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
   * Public images only: Harbor doesn't read Docker's credential helpers.
   */
  pull(reference: string, onProgress: (layers: LayerProgress[]) => void): { done: Promise<void>; cancel: () => void } {
    let stream: Readable | null = null
    let cancelled = false
    const layers = new Map<string, LayerProgress>()
    const done = (async () => {
      const d = this.api()
      const ref = /[:@]/.test(reference.split('/').pop() ?? '') ? reference : `${reference}:latest`
      try {
        stream = (await d.pull(ref)) as unknown as Readable
      } catch (e) {
        const err = toApiError(e)
        if (err.status === 404 || /not found|manifest unknown|repository does not exist/i.test(err.message)) throw new ApiError(`No image called ${ref} was found. Check the name and tag.`, 404)
        if (/unauthorized|denied|authentication required/i.test(err.message)) throw new ApiError(`${ref} needs a login. Run docker login for its registry, then try again.`, 401)
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
              return reject(/unauthorized|denied/i.test(msg) ? new ApiError(`${ref} needs a login. Run docker login for its registry, then try again.`, 401) : new ApiError(msg))
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
}

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
