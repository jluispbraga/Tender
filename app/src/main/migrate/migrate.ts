import { existsSync } from 'node:fs'
import { Agent } from 'node:http'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import Docker from 'dockerode'
import type { MigrationCheck, MigrationEvent, MigrationItem, MigrationPlan, MigrationStep } from '../../renderer/src/api/types'
import { toApiError } from '../engine/engine'
import { engineOs, pipeExists, runningDistros, WslBridge } from '../engine/wsl'

// Windows only. Moves containers, images, volumes and networks from Docker
// Desktop's engine into the Docker Engine inside a WSL distribution, so the
// user can stop using Docker Desktop. Tender never starts, stops or changes
// Docker Desktop: the user opens it for the move, and nothing is deleted from it.
//
// Both engines are open at once and data streams straight from one to the
// other: images through /images/get -> /images/load, volume content through
// the archive API of two helper containers. Nothing is written to disk.

const DESKTOP_PIPE = 'dockerDesktopLinuxEngine'
/** Small image whose containers carry volumes during the copy; it is moved first. */
const HELPER = 'busybox:1.36'

export function dockerDesktopInstalled(env = process.env): boolean {
  return [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files'].some((root) => !!root && existsSync(join(root, 'Docker', 'Docker', 'Docker Desktop.exe')))
}

const source = () => new Docker({ socketPath: `//./pipe/${DESKTOP_PIPE}` })

async function openTarget(distro: string) {
  const bridge = await WslBridge.open(distro)
  const docker = new Docker({ socketPath: bridge.pipe, agent: new Agent({ keepAlive: true, maxFreeSockets: 8 }) } as Docker.DockerOptions)
  return { docker, close: () => bridge.close() }
}

const msg = (e: unknown) => toApiError(e).message

// ---- check ------------------------------------------------------------------------------

export async function check(): Promise<MigrationCheck> {
  const desktopInstalled = dockerDesktopInstalled()

  let src: MigrationCheck['source']
  if (!pipeExists(DESKTOP_PIPE)) {
    src = { ok: false, reason: desktopInstalled ? 'Docker Desktop is closed. Open it and wait until its engine is running.' : 'Docker Desktop is not installed, so there is nothing to move.' }
  } else {
    try {
      const info = await source().info()
      src = { ok: true, version: info.ServerVersion, containers: info.Containers }
    } catch (e) {
      src = { ok: false, reason: `Docker Desktop is open but its engine does not answer yet (${msg(e)}).` }
    }
  }

  const distros = await runningDistros()
  let tgt: MigrationCheck['target'] = { ok: false, reason: 'No WSL distribution is running. Start the one with Docker Engine (for example: wsl -d Ubuntu).' }
  const misses: string[] = []
  for (const d of distros) {
    const r = await engineOs(d)
    if (r.ok && /docker desktop/i.test(r.os)) {
      // Docker Desktop's WSL integration answers in place of the distribution's own engine.
      if (!tgt.hijacked) tgt = { ok: false, distro: d, hijacked: d, reason: `In ${d}, docker answers as Docker Desktop (its WSL integration).` }
      continue
    }
    if (r.ok) {
      tgt = { ok: true, distro: d, version: r.version }
      break
    }
    if (r.lostSocket && !tgt.hijacked && !tgt.lost) tgt = { ok: false, distro: d, lost: d, reason: `Docker in ${d} is running but lost its socket: Docker Desktop removes it when it quits or restarts.` }
    misses.push(`${d}: ${r.reason}`)
  }
  if (!tgt.ok && !tgt.hijacked && !tgt.lost && distros.length) tgt = { ok: false, reason: `No Docker Engine answers in WSL (${misses.join('; ')}).` }
  return { desktopInstalled, source: src, target: tgt }
}

// ---- plan -------------------------------------------------------------------------------

type DfVolume = { Name: string; UsageData?: { Size: number } }

export async function plan(distro: string): Promise<MigrationPlan> {
  const src = source()
  const [list, images, df] = await Promise.all([src.listContainers({ all: true }), src.listImages(), src.df() as Promise<{ Volumes?: DfVolume[] }>])
  const imgSize = new Map(images.map((i) => [i.Id, i.Size]))
  const volSize = new Map((df.Volumes ?? []).map((v) => [v.Name, Math.max(0, v.UsageData?.Size ?? 0)]))

  // Names already taken in the target: those are left alone, so say it up front.
  const t = await openTarget(distro)
  let takenContainers: Set<string>, takenVolumes: Set<string>
  try {
    takenContainers = new Set((await t.docker.listContainers({ all: true })).flatMap((c) => c.Names.map((n) => n.replace(/^\//, ''))))
    takenVolumes = new Set(((await t.docker.listVolumes()).Volumes ?? []).map((v) => v.Name))
  } finally {
    t.close()
  }

  const groups = new Map<string, MigrationItem>()
  const usedImages = new Set<string>()
  const usedVolumes = new Set<string>()
  for (const c of list) {
    const name = c.Names[0].replace(/^\//, '')
    const project = c.Labels?.['com.docker.compose.project']
    const id = project ? `project:${project}` : `container:${name}`
    const item = groups.get(id) ?? { id, kind: project ? 'project' : 'container', label: project ?? name, containers: [], images: [], volumes: [], bytes: 0, running: 0, conflicts: [] }
    item.containers.push(name)
    if (!item.images.includes(c.ImageID)) item.images.push(c.ImageID)
    for (const m of c.Mounts ?? []) if (m.Type === 'volume' && m.Name && !item.volumes.includes(m.Name)) item.volumes.push(m.Name)
    if (c.State === 'running') item.running++
    if (takenContainers.has(name)) item.conflicts.push(name)
    usedImages.add(c.ImageID)
    groups.set(id, item)
  }
  for (const item of groups.values()) {
    for (const v of item.volumes) {
      usedVolumes.add(v)
      if (takenVolumes.has(v)) item.conflicts.push(v)
    }
    item.bytes = item.images.reduce((n, i) => n + (imgSize.get(i) ?? 0), 0) + item.volumes.reduce((n, v) => n + (volSize.get(v) ?? 0), 0)
  }

  const items = [...groups.values()].sort((a, b) => Number(b.kind === 'project') - Number(a.kind === 'project') || a.label.localeCompare(b.label))
  const spareImages = images.filter((i) => !usedImages.has(i.Id) && (i.RepoTags ?? []).some((t) => t !== '<none>:<none>'))
  if (spareImages.length) {
    items.push({ id: 'unused-images', kind: 'unused-images', label: `Images no container uses (${spareImages.length})`, containers: [], images: spareImages.map((i) => i.Id), volumes: [], bytes: spareImages.reduce((n, i) => n + i.Size, 0), running: 0, conflicts: [] })
  }
  const spareVolumes = [...volSize.keys()].filter((v) => !usedVolumes.has(v))
  if (spareVolumes.length) {
    items.push({ id: 'unused-volumes', kind: 'unused-volumes', label: `Volumes no container uses (${spareVolumes.length})`, containers: [], images: [], volumes: spareVolumes, bytes: spareVolumes.reduce((n, v) => n + (volSize.get(v) ?? 0), 0), running: 0, conflicts: spareVolumes.filter((v) => takenVolumes.has(v)) })
  }
  return { items }
}

// ---- moving -----------------------------------------------------------------------------

/** Bind sources as Docker Desktop reports them -> the same folder seen from WSL. */
export function hostPathToWsl(p: string): string {
  let m = /^\/run\/desktop\/mnt\/host\/([a-z])\/(.*)$/.exec(p) ?? /^\/host_mnt\/([a-z])\/(.*)$/.exec(p)
  if (m) return `/mnt/${m[1]}/${m[2]}`
  m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
  // Docker Desktop's proxy to its own engine: the plain engine's socket is the equivalent.
  if (p === '/run/host-services/docker.proxy.sock') return '/var/run/docker.sock'
  return p
}

type Inspect = Docker.ContainerInspectInfo & { Config: Record<string, any>; HostConfig: Record<string, any> }

/** A container's inspect output -> the body that recreates it on another engine. */
export function createBody(c: Inspect, idToName: Map<string, string>, image: string) {
  const cfg: Record<string, any> = { ...c.Config, Image: image }
  // The old ID as hostname would follow the container around; let the engine pick, unless it was set on purpose.
  if (cfg.Hostname && c.Id.startsWith(cfg.Hostname)) delete cfg.Hostname

  const hc: Record<string, any> = structuredClone(c.HostConfig)
  if (Array.isArray(hc.Binds)) {
    hc.Binds = hc.Binds.map((b: string) => {
      const m = /^(.+?):(\/.*)$/.exec(b)
      return m ? `${hostPathToWsl(m[1])}:${m[2]}` : b
    })
  }
  for (const m of hc.Mounts ?? []) if (m.Type === 'bind') m.Source = hostPathToWsl(m.Source)
  const linked = /^container:(.+)$/.exec(hc.NetworkMode ?? '')
  if (linked && idToName.has(linked[1])) hc.NetworkMode = `container:${idToName.get(linked[1])}`
  delete hc.ContainerIDFile
  // Docker Desktop answers host.docker.internal by itself; a plain engine needs it spelled out.
  const hosts: string[] = (hc.ExtraHosts ?? []).filter(Boolean)
  if (!hosts.some((h) => h.startsWith('host.docker.internal:'))) hosts.push('host.docker.internal:host-gateway')
  hc.ExtraHosts = hosts

  const networks = Object.entries(c.NetworkSettings?.Networks ?? {}).map(([name, e]: [string, any]) => {
    const endpoint: Record<string, unknown> = {}
    const aliases = (e.Aliases ?? []).filter((a: string) => !c.Id.startsWith(a))
    if (aliases.length) endpoint.Aliases = aliases
    if (e.IPAMConfig) endpoint.IPAMConfig = e.IPAMConfig
    if (e.Links) endpoint.Links = e.Links
    return { name, endpoint }
  })
  const ownNetwork = !/^(container:|host$|none$)/.test(hc.NetworkMode ?? '')
  const first = ownNetwork ? networks[0] : undefined
  const body = { ...cfg, HostConfig: hc, ...(first ? { NetworkingConfig: { EndpointsConfig: { [first.name]: first.endpoint } } } : {}) }
  return { body, extraNetworks: ownNetwork ? networks.slice(1) : [] }
}

/** Counts bytes passing through, for progress. */
function counter(onBytes: (n: number) => void) {
  let n = 0
  let last = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length
      if (n - last > 4 * 1024 * 1024) ((last = n), onBytes(n))
      cb(null, chunk)
    },
    flush(cb) {
      onBytes(n)
      cb()
    },
  })
}

/** Reads a JSON-lines progress stream (pull, load) to its end; throws on the first error line, else returns its messages. */
function drain(stream: Readable): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buf = ''
    let failure: string | null = null
    const said: string[] = []
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) {
        try {
          const j = JSON.parse(l)
          if (j.error || j.errorDetail) failure ??= j.errorDetail?.message ?? j.error
          else if (typeof j.stream === 'string') said.push(j.stream.trim())
        } catch {
          // not JSON: ignore
        }
      }
    })
    stream.on('end', () => (failure ? reject(new Error(failure)) : resolve(said)))
    stream.on('error', reject)
  })
}

const unique = <T>(xs: T[]) => [...new Set(xs)]

/** Runs the move; returns a function that cancels it. Events report every step and item. */
export function run(distro: string, itemIds: string[], opts: { start: boolean }, emit: (e: MigrationEvent) => void): () => void {
  let cancelled = false
  const active = new Set<{ destroy(): void }>()
  const track = <S extends { destroy(): void }>(s: S) => (active.add(s), s)

  void (async () => {
    let moved = 0
    let skipped = 0
    let failed = 0
    const item = (step: MigrationStep, name: string, status: 'working' | 'done' | 'skipped' | 'failed', message?: string) => {
      if (status === 'done') moved++
      if (status === 'skipped') skipped++
      if (status === 'failed') failed++
      emit({ type: 'item', step, name, status, message })
    }
    let target: Awaited<ReturnType<typeof openTarget>> | null = null
    try {
      emit({ type: 'step', step: 'prepare', total: 1 })
      const src = source()
      const p = await plan(distro)
      const sel = p.items.filter((i) => itemIds.includes(i.id))
      target = await openTarget(distro)
      const tgt = target.docker

      const names = unique(sel.flatMap((i) => i.containers))
      const inspected = (await Promise.all(names.map((n) => src.getContainer(n).inspect()))) as Inspect[]
      const volumes = unique(sel.flatMap((i) => i.volumes))
      const imageIds = unique(sel.flatMap((i) => i.images))
      const networks = unique(inspected.flatMap((c) => Object.keys(c.NetworkSettings?.Networks ?? {}))).filter((n) => !['bridge', 'host', 'none'].includes(n))

      if (volumes.length) {
        // The helper must exist in Docker Desktop to read volumes; it travels with the images.
        let helper = await src.getImage(HELPER).inspect().catch(() => null)
        if (!helper) {
          item('prepare', `Getting ${HELPER} to copy volumes`, 'working')
          await drain((await src.pull(HELPER)) as unknown as Readable)
          helper = await src.getImage(HELPER).inspect()
        }
        imageIds.unshift(helper.Id)
      }

      // -- images
      emit({ type: 'step', step: 'images', total: unique(imageIds).length })
      const srcImages = new Map((await src.listImages()).map((i) => [i.Id, i]))
      // Image IDs differ between engines (Docker Desktop's containerd store uses manifest
      // digests, a classic engine config digests), so images are matched by name, and
      // each source ID is mapped to the ID the target gave it.
      const tgtTags = new Set((await tgt.listImages()).flatMap((i) => i.RepoTags ?? []))
      const idMap = new Map<string, string>()
      for (const id of unique(imageIds)) {
        if (cancelled) break
        const info = srcImages.get(id)
        const tags = (info?.RepoTags ?? []).filter((t) => t !== '<none>:<none>')
        const name = tags[0] ?? id.replace('sha256:', '').slice(0, 12)
        if (tags.length && tags.every((t) => tgtTags.has(t))) {
          idMap.set(id, (await tgt.getImage(tags[0]).inspect()).Id)
          item('images', name, 'skipped', 'already there')
          continue
        }
        item('images', name, 'working')
        try {
          const out = track((await (src as unknown as { getImages(o: { names: string[] }): Promise<unknown> }).getImages({ names: tags.length ? tags : [id] })) as unknown as Readable)
          const total = info?.Size ?? 0
          const counted = out.pipe(counter((n) => emit({ type: 'bytes', name, done: n, total })))
          const said = await drain(track((await tgt.loadImage(counted)) as unknown as Readable))
          const loadedId = said.map((l) => /^Loaded image ID: (sha256:[0-9a-f]+)/.exec(l)?.[1]).find(Boolean)
          const tgtId = tags.length ? (await tgt.getImage(tags[0]).inspect()).Id : loadedId
          if (!tgtId) throw new Error('the engine did not say which image it loaded')
          idMap.set(id, tgtId)
          item('images', name, 'done')
        } catch (e) {
          item('images', name, 'failed', cancelled ? 'cancelled' : msg(e))
        }
      }

      // -- networks
      if (!cancelled && networks.length) {
        emit({ type: 'step', step: 'networks', total: networks.length })
        const have = new Set((await tgt.listNetworks()).map((n) => n.Name))
        for (const n of networks) {
          if (cancelled) break
          if (have.has(n)) {
            item('networks', n, 'skipped', 'already there')
            continue
          }
          try {
            const i = (await src.getNetwork(n).inspect()) as Record<string, any>
            await tgt.createNetwork({ Name: i.Name, Driver: i.Driver, Internal: i.Internal, Attachable: i.Attachable, EnableIPv6: i.EnableIPv6, Labels: i.Labels, Options: i.Options, ...(i.IPAM?.Config?.length ? { IPAM: { Driver: i.IPAM.Driver, Config: i.IPAM.Config } } : {}) })
            item('networks', n, 'done')
          } catch (e) {
            item('networks', n, 'failed', msg(e))
          }
        }
      }

      // -- volumes
      if (!cancelled && volumes.length) {
        emit({ type: 'step', step: 'volumes', total: volumes.length })
        const have = new Set(((await tgt.listVolumes()).Volumes ?? []).map((v) => v.Name))
        const sizes = new Map(((((await src.df()) as { Volumes?: DfVolume[] }).Volumes) ?? []).map((v) => [v.Name, Math.max(0, v.UsageData?.Size ?? 0)]))
        for (const v of volumes) {
          if (cancelled) break
          if (have.has(v)) {
            item('volumes', v, 'skipped', 'already there, content left as is')
            continue
          }
          item('volumes', v, 'working')
          let from: Docker.Container | null = null
          let to: Docker.Container | null = null
          try {
            const i = (await src.getVolume(v).inspect()) as Record<string, any>
            await tgt.createVolume({ Name: v, Driver: i.Driver, Labels: i.Labels ?? {}, DriverOpts: i.Options ?? {} })
            // Created, never started: the archive API reads and writes through their mounts.
            from = await src.createContainer({ Image: HELPER, Labels: { 'io.github.tender.helper': 'migrate' }, HostConfig: { Binds: [`${v}:/v:ro`] } })
            to = await tgt.createContainer({ Image: HELPER, Labels: { 'io.github.tender.helper': 'migrate' }, HostConfig: { Binds: [`${v}:/v`] } })
            const tar = track((await from.getArchive({ path: '/v' })) as unknown as Readable)
            const counted = tar.pipe(counter((n) => emit({ type: 'bytes', name: v, done: n, total: sizes.get(v) ?? 0 })))
            // The archive holds v/...; unpacked at / it lands in the volume, owners and modes kept.
            await to.putArchive(counted, { path: '/', copyUIDGID: true } as Record<string, unknown>)
            item('volumes', v, 'done')
          } catch (e) {
            item('volumes', v, 'failed', cancelled ? 'cancelled' : msg(e))
          } finally {
            await from?.remove({ force: true }).catch(() => undefined)
            await to?.remove({ force: true }).catch(() => undefined)
          }
        }
      }

      // -- containers
      const created: string[] = []
      if (!cancelled && inspected.length) {
        emit({ type: 'step', step: 'containers', total: inspected.length })
        const idToName = new Map(inspected.map((c) => [c.Id, c.Name.replace(/^\//, '')]))
        const have = new Set((await tgt.listContainers({ all: true })).flatMap((c) => c.Names.map((n) => n.replace(/^\//, ''))))
        const tgtImageIds = new Map((await tgt.listImages()).flatMap((i) => (i.RepoTags ?? []).map((t) => [t, i.Id] as const)))
        const withTag = (r: string) => (/:[^/]+$/.test(r) || r.includes('@') ? r : `${r}:latest`)
        for (const c of inspected) {
          if (cancelled) break
          const name = c.Name.replace(/^\//, '')
          if (have.has(name)) {
            item('containers', name, 'skipped', 'a container with this name is already there')
            continue
          }
          try {
            // Keep the image name when it points at the image that came across; else use its new ID.
            const moved = idMap.get(c.Image)
            if (!moved) throw new Error('its image did not come across')
            const ref = String(c.Config.Image)
            const { body, extraNetworks } = createBody(c, idToName, tgtImageIds.get(withTag(ref)) === moved ? ref : moved)
            await tgt.createContainer({ name, ...body } as Docker.ContainerCreateOptions)
            for (const n of extraNetworks) await tgt.getNetwork(n.name).connect({ Container: name, EndpointConfig: n.endpoint })
            const sources: string[] = [...(c.HostConfig.Mounts ?? []).map((m: { Source?: string }) => m.Source ?? ''), ...(c.HostConfig.Binds ?? []).map((b: string) => b.split(':')[0])]
            const desktopOnly = sources.some((s) => s.startsWith('/run/host-services/') && s !== '/run/host-services/docker.proxy.sock')
            item('containers', name, 'done', desktopOnly ? 'uses a Docker Desktop service (/run/host-services); check it before relying on it' : undefined)
            if (c.State.Running) created.push(name)
          } catch (e) {
            item('containers', name, 'failed', msg(e))
          }
        }
      }

      // -- start the ones that were running
      if (!cancelled && opts.start && created.length) {
        emit({ type: 'step', step: 'start', total: created.length })
        for (const name of created) {
          if (cancelled) break
          try {
            await tgt.getContainer(name).start()
            emit({ type: 'item', step: 'start', name, status: 'done' })
          } catch (e) {
            emit({ type: 'item', step: 'start', name, status: 'failed', message: msg(e) })
          }
        }
      }
      emit({ type: 'done', moved, skipped, failed, cancelled })
    } catch (e) {
      emit({ type: 'error', message: msg(e) })
    } finally {
      target?.close()
    }
  })()

  return () => {
    cancelled = true
    for (const s of active) s.destroy()
  }
}
