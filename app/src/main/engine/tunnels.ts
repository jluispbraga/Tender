import type { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { ApiError, type Tunnel } from '../../renderer/src/api/types'

// Temporary public links with Cloudflare's Quick Tunnels: no account, a random
// https://….trycloudflare.com address that lasts until the tunnel stops.
// cloudflared runs as a helper container on the same engine and joins the
// target container's network, so the port doesn't even need to be published.
// Tender closes every tunnel it opened when it quits.

/** Pinned, like the scanner: the tunnel client shouldn't change under people. */
export const CLOUDFLARED = 'cloudflare/cloudflared:2024.11.1'
const LABEL = 'io.github.tender.helper'
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

const urls = new Map<string, string>()

const nameOf = (c: { Names?: string[]; Name?: string; Id: string }) => (c.Names?.[0] ?? c.Name ?? c.Id).replace(/^\//, '')

async function ensureImage(d: Docker) {
  if (await d.getImage(CLOUDFLARED).inspect().catch(() => null)) return
  const s = (await d.pull(CLOUDFLARED)) as unknown as Readable
  await new Promise<void>((resolve, reject) => d.modem.followProgress(s, (err: unknown) => (err ? reject(err) : resolve())))
}

/** Reads the helper's log until cloudflared prints its address, or gives up. */
async function waitForUrl(d: Docker, helperId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const c = d.getContainer(helperId)
    const info = await c.inspect().catch(() => null)
    const raw = ((await c.logs({ stdout: true, stderr: true, tail: 200 }).catch(() => Buffer.alloc(0))) as Buffer).toString('utf8')
    const m = URL_RE.exec(raw)
    if (m) return m[0]
    if (!info?.State.Running) {
      const reason = raw.split('\n').filter((l) => /ERR|error|failed/i.test(l)).pop()?.replace(/^.*?(ERR|error)\s*/i, '')
      throw new ApiError(reason ? `The tunnel stopped: ${reason.trim()}` : 'The tunnel stopped before it got an address.', 502)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new ApiError('Cloudflare didn’t answer in time. Check the internet connection and try again.', 504)
}

export async function list(d: Docker): Promise<Tunnel[]> {
  const helpers = await d.listContainers({ all: true, filters: { label: [`${LABEL}=tunnel`] } })
  return Promise.all(
    helpers.map(async (h) => {
      let url = urls.get(h.Id)
      if (!url && h.State === 'running') {
        const raw = ((await d.getContainer(h.Id).logs({ stdout: true, stderr: true, tail: 200 }).catch(() => Buffer.alloc(0))) as Buffer).toString('utf8')
        url = URL_RE.exec(raw)?.[0]
        if (url) urls.set(h.Id, url)
      }
      return {
        id: h.Id,
        containerId: h.Labels['io.github.tender.tunnel-target'] ?? '',
        containerName: h.Labels['io.github.tender.tunnel-target-name'] ?? '',
        port: Number(h.Labels['io.github.tender.tunnel-port'] ?? 0),
        url,
        state: h.State === 'running' ? (url ? 'open' : 'starting') : 'stopped',
        startedAt: new Date(h.Created * 1000).toISOString(),
      } satisfies Tunnel
    }),
  )
}

export async function open(d: Docker, containerId: string, port: number): Promise<Tunnel> {
  const target = await d
    .getContainer(containerId)
    .inspect()
    .catch(() => {
      throw new ApiError('That container no longer exists.', 404)
    })
  const name = nameOf(target)
  if (!target.State.Running) throw new ApiError(`${name} isn’t running. Start it, then share it.`, 409)
  const existing = (await list(d)).find((t) => t.containerId === target.Id && t.port === port && t.state !== 'stopped')
  if (existing) return existing

  // Where cloudflared reaches the app: the target's address on a network they
  // share. host networking means the app is on the engine host's localhost.
  const mode = target.HostConfig.NetworkMode ?? 'default'
  let network: string
  let origin: string
  if (mode === 'host') {
    network = 'host'
    origin = `http://localhost:${port}`
  } else if (mode === 'none' || mode.startsWith('container:')) {
    throw new ApiError(`${name} has no network of its own, so it can’t be shared.`, 409)
  } else {
    const nets = Object.entries(target.NetworkSettings.Networks ?? {})
    const [netName, ep] = nets.find(([, e]) => e.IPAddress) ?? []
    if (!netName || !ep?.IPAddress) throw new ApiError(`${name} has no IP address yet. Try again in a moment.`, 409)
    network = netName
    origin = `http://${ep.IPAddress}:${port}`
  }

  await ensureImage(d)
  const helper = await d.createContainer({
    Image: CLOUDFLARED,
    Cmd: ['tunnel', '--no-autoupdate', '--url', origin],
    Labels: {
      [LABEL]: 'tunnel',
      'io.github.tender.tunnel-target': target.Id,
      'io.github.tender.tunnel-target-name': name,
      'io.github.tender.tunnel-port': String(port),
    },
    HostConfig: { NetworkMode: network, AutoRemove: false },
  })
  await helper.start()
  try {
    const url = await waitForUrl(d, helper.id, 45_000)
    urls.set(helper.id, url)
    return { id: helper.id, containerId: target.Id, containerName: name, port, url, state: 'open', startedAt: new Date().toISOString() }
  } catch (e) {
    await helper.remove({ force: true }).catch(() => undefined)
    throw e
  }
}

export async function close(d: Docker, id: string) {
  urls.delete(id)
  const c = d.getContainer(id)
  const info = await c.inspect().catch(() => null)
  // Only ever remove Tender's own tunnel helpers.
  if (!info || info.Config.Labels?.[LABEL] !== 'tunnel') return
  await c.remove({ force: true }).catch(() => undefined)
}

export async function closeAll(d: Docker) {
  const helpers = await d.listContainers({ all: true, filters: { label: [`${LABEL}=tunnel`] } }).catch(() => [])
  await Promise.all(helpers.map((h) => close(d, h.Id)))
}
