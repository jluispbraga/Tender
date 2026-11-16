import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Docker from 'dockerode'
import { ApiError, type ComposeCommand, type ComposeFile, type ComposeService } from '../../renderer/src/api/types'

// Compose projects from their file, not only from running containers: up a
// project that is down, pull or build its services, edit its .env. Every
// command is the Compose CLI's own (`docker compose -f … -p …`), pointed at
// the engine Tender is connected to.

const savedFile = () => join(app.getPath('userData'), 'compose-files.json')

function saved(): string[] {
  try {
    const v = JSON.parse(readFileSync(savedFile(), 'utf8'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const save = (paths: string[]) => writeFileSync(savedFile(), JSON.stringify([...new Set(paths)], null, 2))

export const addPath = (path: string) => save([...saved(), path])
export const removePath = (path: string) => save(saved().filter((p) => p !== path))

const env = (host: string): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: host, COMPOSE_PROGRESS: 'plain', COMPOSE_ANSI: 'never', DOCKER_CLI_HINTS: 'false' }
  delete e.DOCKER_CONTEXT
  return e
}

function run(docker: string, args: string[], host: string, cwd: string, timeout = 30_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(docker, args, { env: env(host), cwd, windowsHide: true })
    let out = ''
    let err = ''
    const t = setTimeout(() => child.kill(), timeout)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', (e) => (clearTimeout(t), resolve({ code: -1, out, err: e.message })))
    child.on('close', (code) => (clearTimeout(t), resolve({ code: code ?? -1, out, err })))
  })
}

/** `config --format json` resolves includes, extends, profiles and .env: the file as Compose sees it. */
const configCache = new Map<string, { mtime: number; envMtime: number; value: { name: string; services: Record<string, any> } | { error: string } }>()

async function config(docker: string, host: string, path: string) {
  const mtime = statSync(path).mtimeMs
  const envPath = join(dirname(path), '.env')
  const envMtime = existsSync(envPath) ? statSync(envPath).mtimeMs : 0
  const hit = configCache.get(path)
  if (hit && hit.mtime === mtime && hit.envMtime === envMtime) return hit.value
  const r = await run(docker, ['compose', '-f', path, 'config', '--format', 'json'], host, dirname(path))
  let value: { name: string; services: Record<string, any> } | { error: string }
  if (r.code !== 0) value = { error: r.err.trim().split(/\r?\n/).pop() || 'Compose couldn’t read this file.' }
  else {
    try {
      const j = JSON.parse(r.out)
      value = { name: j.name, services: j.services ?? {} }
    } catch {
      value = { error: 'Compose printed something Tender couldn’t read. Is the Compose plugin up to date?' }
    }
  }
  configCache.set(path, { mtime, envMtime, value })
  return value
}

/** Files saved here, plus the ones running projects were started from (if this machine can open them). */
export async function list(docker: string | null, host: string, containers: Docker.ContainerInfo[]): Promise<ComposeFile[]> {
  const fromLabels = containers.map((c) => c.Labels?.['com.docker.compose.project.config_files']?.split(',')[0]).filter((p): p is string => !!p && existsSync(p))
  const paths = [...new Set([...saved(), ...fromLabels])]
  return Promise.all(paths.map((p) => describe(docker, host, p, containers)))
}

export async function describe(docker: string | null, host: string, path: string, containers: Docker.ContainerInfo[]): Promise<ComposeFile> {
  const base: ComposeFile = { path, project: '', services: [], saved: saved().includes(path), hasEnv: existsSync(join(dirname(path), '.env')) }
  if (!existsSync(path)) return { ...base, error: 'The file isn’t there any more.' }
  if (!docker) return { ...base, error: 'Compose files need the Docker CLI with Compose. Install it in Settings › General › Windows tools.' }
  const c = await config(docker, host, path)
  if ('error' in c) return { ...base, error: c.error }
  const mine = containers.filter((x) => x.Labels?.['com.docker.compose.project'] === c.name)
  const services: ComposeService[] = Object.entries(c.services)
    .map(([name, s]) => {
      const running = mine.filter((x) => x.Labels?.['com.docker.compose.service'] === name)
      const states = running.map((x) => x.State)
      return {
        name,
        image: typeof s.image === 'string' ? s.image : undefined,
        build: !!s.build,
        ports: (Array.isArray(s.ports) ? s.ports : []).map((p: any) => (p.published ? `${p.published}:${p.target}` : String(p.target ?? p))),
        state: !running.length ? 'missing' : states.includes('running') ? 'running' : states.includes('restarting') ? 'restarting' : states.includes('paused') ? 'paused' : 'exited',
        containerIds: running.map((x) => x.Id),
      } satisfies ComposeService
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ...base, project: c.name, services }
}

const ARGS: Record<ComposeCommand, string[]> = {
  up: ['up', '--detach', '--wait-timeout', '120'],
  down: ['down'],
  pull: ['pull'],
  build: ['build'],
  restart: ['restart'],
  stop: ['stop'],
}

/** Runs one Compose command; every output line goes to `onLine`. */
export function command(docker: string, host: string, path: string, cmd: ComposeCommand, service: string | undefined, onLine: (lines: string[]) => void) {
  if (!existsSync(path)) throw new ApiError('The file isn’t there any more.', 404)
  if (cmd === 'down' && service) throw new ApiError('Down takes the whole project. To remove one service, stop it.', 400)
  const args = ['compose', '-f', path, ...ARGS[cmd], ...(service ? [service] : [])]
  const child = spawn(docker, args, { env: env(host), cwd: dirname(path), windowsHide: true })
  let buf = ''
  let last = ''
  let pending: string[] = []
  let timer: NodeJS.Timeout | undefined
  const flush = () => {
    timer = undefined
    if (pending.length) onLine(pending)
    pending = []
  }
  const feed = (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    const parts = buf.split(/\r?\n/)
    buf = parts.pop() ?? ''
    for (const p of parts) if (p.trim()) (pending.push(p), (last = p))
    timer ??= setTimeout(flush, 100)
  }
  child.stdout.on('data', feed)
  child.stderr.on('data', feed)
  let cancelled = false
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new ApiError(`Couldn’t run Docker Compose: ${e.message}`)))
    child.on('close', (code) => {
      if (buf.trim()) (pending.push(buf), (last = buf))
      clearTimeout(timer)
      flush()
      configCache.delete(path)
      if (cancelled) reject(new ApiError('Stopped.', 499))
      else if (code === 0) resolve()
      else reject(new ApiError(last.replace(/^(Error response from daemon|error):\s*/i, '') || `Compose stopped with exit code ${code}.`, 422))
    })
  })
  return { done, cancel: () => ((cancelled = true), child.kill()) }
}

const MAX_ENV = 256 * 1024

export function readEnv(path: string): string {
  const p = join(dirname(path), '.env')
  return existsSync(p) ? readFileSync(p, 'utf8').slice(0, MAX_ENV) : ''
}

export function writeEnv(path: string, text: string) {
  if (!existsSync(path)) throw new ApiError('The compose file isn’t there any more.', 404)
  writeFileSync(join(dirname(path), '.env'), text)
  configCache.delete(path)
}
