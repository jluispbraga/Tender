import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError, type LocalCluster, type LocalClusterTool } from '../../renderer/src/api/types'

// Local Kubernetes clusters that run as containers on the same engine: kind,
// k3d and minikube (docker driver). Tender only runs their own CLIs, pointed
// at its engine; each one adds its context to ~/.kube/config, where the
// Kubernetes page picks it up.

const TOOLS: LocalClusterTool[] = ['kind', 'k3d', 'minikube']

function find(tool: string): string | null {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(process.platform === 'win32' ? ';' : ':')) if (dir && existsSync(join(dir, exe))) return join(dir, exe)
  return null
}

export const tools = () => TOOLS.filter((t) => find(t))

const env = (host: string): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: host, NO_COLOR: '1', MINIKUBE_IN_STYLE: 'false' }
  delete e.DOCKER_CONTEXT
  return e
}

function run(tool: string, args: string[], host: string, timeout = 20_000): Promise<{ code: number; out: string }> {
  const bin = find(tool)
  if (!bin) return Promise.resolve({ code: -1, out: '' })
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: env(host), windowsHide: true })
    let out = ''
    const t = setTimeout(() => child.kill(), timeout)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', () => (clearTimeout(t), resolve({ code: -1, out })))
    child.on('close', (code) => (clearTimeout(t), resolve({ code: code ?? -1, out })))
  })
}

export async function list(host: string): Promise<LocalCluster[]> {
  const found = tools()
  const lists = await Promise.all(
    found.map(async (tool): Promise<LocalCluster[]> => {
      if (tool === 'kind') {
        const r = await run('kind', ['get', 'clusters'], host)
        return r.code === 0 ? r.out.split(/\r?\n/).filter((l) => l && !/^No kind clusters/.test(l)).map((name) => ({ tool, name, context: `kind-${name}` })) : []
      }
      if (tool === 'k3d') {
        const r = await run('k3d', ['cluster', 'list', '-o', 'json'], host)
        try {
          return (JSON.parse(r.out || '[]') as { name: string; serversRunning?: number; serversCount?: number }[]).map((c) => ({ tool, name: c.name, context: `k3d-${c.name}`, running: (c.serversRunning ?? 0) > 0 }))
        } catch {
          return []
        }
      }
      const r = await run('minikube', ['profile', 'list', '-o', 'json'], host)
      try {
        const j = JSON.parse(r.out || '{}') as { valid?: { Name: string; Status?: string }[] }
        return (j.valid ?? []).map((p) => ({ tool, name: p.Name, context: p.Name, running: p.Status === 'Running' }))
      } catch {
        return []
      }
    }),
  )
  return lists.flat()
}

const ARGS: Record<LocalClusterTool, { create: (n: string) => string[]; remove: (n: string) => string[] }> = {
  kind: { create: (n) => ['create', 'cluster', '--name', n, '--wait', '120s'], remove: (n) => ['delete', 'cluster', '--name', n] },
  k3d: { create: (n) => ['cluster', 'create', n, '--wait'], remove: (n) => ['cluster', 'delete', n] },
  minikube: { create: (n) => ['start', '-p', n, '--driver=docker'], remove: (n) => ['delete', '-p', n] },
}

/** Creates or deletes a cluster, streaming the tool's output line by line. */
export function command(tool: LocalClusterTool, action: 'create' | 'remove', name: string, host: string, onLines: (lines: string[]) => void) {
  const bin = find(tool)
  if (!bin) throw new ApiError(`${tool} isn’t installed. Install it (winget install ${tool === 'kind' ? 'Kubernetes.kind' : tool === 'k3d' ? 'k3d.k3d' : 'Kubernetes.minikube'}) and open Tender again.`, 424)
  const child = spawn(bin, ARGS[tool][action](name), { env: env(host), windowsHide: true })
  let buf = ''
  let last = ''
  const feed = (d: Buffer) => {
    buf += d.toString('utf8')
    const parts = buf.split(/\r?\n/)
    buf = parts.pop() ?? ''
    const lines = parts.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).filter((l) => l.trim())
    if (lines.length) (onLines(lines), (last = lines[lines.length - 1]))
  }
  child.stdout.on('data', feed)
  child.stderr.on('data', feed)
  let cancelled = false
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new ApiError(`Couldn’t run ${tool}: ${e.message}`)))
    child.on('close', (code) => {
      if (buf.trim()) onLines([buf])
      if (cancelled) reject(new ApiError('Stopped.', 499))
      else if (code === 0) resolve()
      else reject(new ApiError(last.replace(/^(ERROR|✖|❌|X)\s*:?\s*/i, '') || `${tool} stopped with exit code ${code}.`, 422))
    })
  })
  return { done, cancel: () => ((cancelled = true), child.kill()) }
}
