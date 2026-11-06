import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { Agent } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DockerOptions } from 'dockerode'

export interface Endpoint {
  /** Context name, "DOCKER_HOST", "default" or "wsl:<distro>". */
  name: string
  kind: 'npipe' | 'unix' | 'tcp' | 'ssh'
  /** As the Docker CLI writes it, e.g. npipe:////./pipe/docker_engine, or wsl://Ubuntu for the WSL bridge. */
  address: string
  /** Where the address came from, shown on S01 and S23. */
  source: string
  /** Set when Tender itself relays the connection (the WSL bridge): the local pipe to dial. */
  socketPath?: string
}

export const WINDOWS_PIPE = 'npipe:////./pipe/docker_engine'

/**
 * Where a local engine listens when nothing says otherwise, most likely first.
 * Windows: the named pipe (Docker Desktop, or dockerd installed as a service).
 * Linux: the system socket, then rootless Docker, then Docker Desktop for Linux.
 * macOS: Docker Desktop, then the system socket, Colima, OrbStack and Rancher Desktop.
 */
export function localCandidates(platform: NodeJS.Platform = process.platform, env = process.env, home = homedir()): string[] {
  if (platform === 'win32') return [WINDOWS_PIPE]
  const rootless = env.XDG_RUNTIME_DIR ? [`unix://${env.XDG_RUNTIME_DIR}/docker.sock`] : []
  if (platform === 'darwin') {
    return [`unix://${home}/.docker/run/docker.sock`, 'unix:///var/run/docker.sock', `unix://${home}/.colima/default/docker.sock`, `unix://${home}/.orbstack/run/docker.sock`, `unix://${home}/.rd/docker.sock`]
  }
  return ['unix:///var/run/docker.sock', ...rootless, `unix://${home}/.docker/desktop/docker.sock`]
}

/**
 * Finds the engine the same way the Docker CLI does: DOCKER_HOST, then
 * DOCKER_CONTEXT or the current context in ~/.docker/config.json, then the
 * platform's default local endpoint. Only reads files; never writes Docker's config.
 */
export function resolveEndpoint(env = process.env, dockerDir = join(homedir(), '.docker'), platform: NodeJS.Platform = process.platform, exists = existsSync, home = homedir()): Endpoint {
  if (env.DOCKER_HOST) return make('DOCKER_HOST', env.DOCKER_HOST, 'the DOCKER_HOST environment variable')

  let context = env.DOCKER_CONTEXT
  if (!context) {
    try {
      context = JSON.parse(readFileSync(join(dockerDir, 'config.json'), 'utf8')).currentContext
    } catch {
      // No config.json: fall through to the default.
    }
  }
  if (context && context !== 'default') {
    // Context metadata lives in contexts/meta/<sha256 of the name>/meta.json.
    const meta = join(dockerDir, 'contexts', 'meta', createHash('sha256').update(context).digest('hex'), 'meta.json')
    if (exists(meta)) {
      try {
        const host = JSON.parse(readFileSync(meta, 'utf8'))?.Endpoints?.docker?.Host
        if (typeof host === 'string' && host) return make(context, host, `the Docker context “${context}”`)
      } catch {
        // Unreadable context: fall through.
      }
    }
  }
  const candidates = localCandidates(platform, env, home)
  // On Unix a socket is a file: take the first that exists. Named pipes are checked when connecting.
  const found = platform === 'win32' ? candidates[0] : (candidates.find((c) => exists(c.replace(/^unix:\/\//, ''))) ?? candidates[0])
  return make('default', found, platform === 'win32' ? 'the default pipe' : 'the default socket')
}

function make(name: string, address: string, source: string): Endpoint {
  const kind = address.startsWith('npipe:') ? 'npipe' : address.startsWith('unix:') ? 'unix' : address.startsWith('ssh:') ? 'ssh' : 'tcp'
  return { name, kind, address, source }
}

/** Address → dockerode options. TLS follows DOCKER_TLS_VERIFY / DOCKER_CERT_PATH like the CLI. */
export function dockerOptions(e: Endpoint, env = process.env): DockerOptions {
  // Each connection through the WSL bridge starts a process in the distro; keep a few open for reuse.
  if (e.socketPath) return { socketPath: e.socketPath, agent: new Agent({ keepAlive: true, maxFreeSockets: 16 }) } as DockerOptions
  if (e.kind === 'npipe') return { socketPath: e.address.replace(/^npipe:\/\//, '') }
  const url = new URL(e.address)
  if (e.kind === 'unix') return { socketPath: url.pathname }
  if (e.kind === 'ssh') return { protocol: 'ssh', host: url.hostname, port: url.port ? Number(url.port) : 22, username: url.username || undefined }
  const tls = env.DOCKER_TLS_VERIFY === '1'
  const certs = env.DOCKER_CERT_PATH
  return {
    protocol: tls ? 'https' : 'http',
    host: url.hostname,
    port: Number(url.port || (tls ? 2376 : 2375)),
    ...(tls && certs ? { ca: readFileSync(join(certs, 'ca.pem')), cert: readFileSync(join(certs, 'cert.pem')), key: readFileSync(join(certs, 'key.pem')) } : {}),
  }
}
