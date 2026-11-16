import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError, type BuildContext, type BuildEvent, type BuildSpec, type BuildStep } from '../../renderer/src/api/types'
import type { Endpoint } from './endpoint'
import { binDir } from '../tools/windows-tools'

// Builds run through the Docker CLI, not the engine API: the CLI reads
// .dockerignore, speaks BuildKit (RUN --mount, heredocs, cache mounts) and is
// what `docker build` in a terminal would do. Tender only points it at the
// engine it is already connected to.

/** The docker CLI a terminal would run: on PATH first, then the copy Tender installs on Windows. */
export function findDockerCli(): string | null {
  const exe = process.platform === 'win32' ? 'docker.exe' : 'docker'
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe)
  }
  if (process.platform === 'win32' && existsSync(join(binDir(), exe))) return join(binDir(), exe)
  return null
}

/** DOCKER_HOST for the CLI, so it builds on the engine Tender shows, whatever its own context says. */
export function cliHost(e: Endpoint): string {
  if (e.socketPath) return process.platform === 'win32' ? `npipe://${e.socketPath.replace(/\\/g, '/')}` : `unix://${e.socketPath}`
  return e.address
}

/** Dockerfiles in a folder's top level: Dockerfile, Dockerfile.dev, api.Dockerfile, Containerfile. */
export function inspectContext(path: string): BuildContext {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new ApiError(`${path} isn’t a folder.`, 400)
  const dockerfiles = readdirSync(path, { withFileTypes: true })
    .filter((f) => f.isFile() && /^(dockerfile|containerfile)(\..+)?$|\.dockerfile$/i.test(f.name))
    .map((f) => f.name)
    .sort((a, b) => (/^dockerfile$/i.test(a) ? -1 : /^dockerfile$/i.test(b) ? 1 : a.localeCompare(b)))
  return { path, dockerfiles }
}

/** Plain BuildKit progress: "#5 [2/4] RUN npm ci", "#5 CACHED", "#5 DONE 3.2s", "#5 ERROR: …". */
const STEP = /^#(\d+) (.*)$/
const LEGACY = /^Step (\d+)\/(\d+) : (.*)$/

export function build(docker: string, host: string, spec: BuildSpec, on: (e: BuildEvent) => void): { done: Promise<{ imageId: string }>; cancel: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'tender-build-'))
  const iid = join(tmp, 'iid')
  const args = ['build', '--progress=plain', '--iidfile', iid, '-f', join(spec.context, spec.dockerfile)]
  if (spec.tag) args.push('-t', spec.tag)
  if (spec.target) args.push('--target', spec.target)
  if (spec.noCache) args.push('--no-cache')
  if (spec.pull) args.push('--pull')
  for (const a of spec.buildArgs) args.push('--build-arg', `${a.key}=${a.value}`)
  args.push(spec.context)

  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: host, BUILDKIT_PROGRESS: 'plain', DOCKER_CLI_HINTS: 'false' }
  delete env.DOCKER_CONTEXT
  const child = spawn(docker, args, { env, windowsHide: true })

  const steps = new Map<string, BuildStep>()
  let pending: string[] = []
  let lastError = ''
  let flushTimer: NodeJS.Timeout | undefined
  const flush = () => {
    flushTimer = undefined
    if (pending.length) on({ type: 'log', lines: pending })
    pending = []
    on({ type: 'steps', steps: [...steps.values()] })
  }
  const line = (raw: string) => {
    const text = raw.replace(/\r$/, '')
    if (!text) return
    pending.push(text)
    const m = STEP.exec(text)
    if (m) {
      const [, id, rest] = m
      const s = steps.get(id)
      if (!s && /^\[/.test(rest)) steps.set(id, { id, name: rest, status: 'running' })
      else if (s) {
        if (rest === 'CACHED') s.status = 'cached'
        else if (/^DONE /.test(rest)) (s.status = 'done'), (s.seconds = Number(rest.slice(5).replace(/s$/, '')) || undefined)
        else if (/^ERROR/.test(rest)) (s.status = 'error'), (lastError = rest.replace(/^ERROR:?\s*/, ''))
      }
    }
    const l = LEGACY.exec(text)
    if (l) {
      for (const s of steps.values()) if (s.status === 'running') s.status = 'done'
      steps.set(`legacy-${l[1]}`, { id: `legacy-${l[1]}`, name: `[${l[1]}/${l[2]}] ${l[3]}`, status: 'running' })
    }
    if (/^ERROR:|^error:/i.test(text) && !m) lastError = text.replace(/^ERROR:\s*/i, '')
    flushTimer ??= setTimeout(flush, 120)
  }
  let buf = ''
  const feed = (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    parts.forEach(line)
  }
  child.stdout.on('data', feed)
  child.stderr.on('data', feed)

  let cancelled = false
  const done = new Promise<{ imageId: string }>((resolve, reject) => {
    child.on('error', (e) => reject(new ApiError(`Couldn’t run the Docker CLI: ${e.message}`)))
    child.on('close', (code) => {
      if (buf) line(buf)
      clearTimeout(flushTimer)
      flush()
      try {
        if (cancelled) return reject(new ApiError('Build cancelled.', 499))
        if (code !== 0) return reject(new ApiError(lastError || `The build stopped with exit code ${code}.`, 422))
        const imageId = existsSync(iid) ? readFileSync(iid, 'utf8').trim() : ''
        resolve({ imageId })
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  })
  return {
    done,
    cancel: () => {
      cancelled = true
      child.kill()
    },
  }
}
