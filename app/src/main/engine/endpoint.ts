import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DockerOptions } from 'dockerode'

export interface Endpoint {
  /** Context name, "DOCKER_HOST" or "default". */
  name: string
  kind: 'npipe' | 'tcp' | 'ssh'
  /** As the Docker CLI writes it, e.g. npipe:////./pipe/docker_engine */
  address: string
  /** Where the address came from, shown on S01 and S23. */
  source: string
}

const DEFAULT = 'npipe:////./pipe/docker_engine'

/**
 * Finds the engine the same way the Docker CLI does: DOCKER_HOST, then
 * DOCKER_CONTEXT or the current context in ~/.docker/config.json, then the
 * default named pipe. Only reads files; never writes Docker's config.
 */
export function resolveEndpoint(env = process.env, dockerDir = join(homedir(), '.docker')): Endpoint {
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
    if (existsSync(meta)) {
      try {
        const host = JSON.parse(readFileSync(meta, 'utf8'))?.Endpoints?.docker?.Host
        if (typeof host === 'string' && host) return make(context, host, `the Docker context “${context}”`)
      } catch {
        // Unreadable context: fall through.
      }
    }
  }
  return make('default', DEFAULT, 'the default pipe')
}

function make(name: string, address: string, source: string): Endpoint {
  const kind = address.startsWith('npipe:') ? 'npipe' : address.startsWith('ssh:') ? 'ssh' : 'tcp'
  return { name, kind, address, source }
}

/** Address → dockerode options. TLS follows DOCKER_TLS_VERIFY / DOCKER_CERT_PATH like the CLI. */
export function dockerOptions(e: Endpoint, env = process.env): DockerOptions {
  if (e.kind === 'npipe') return { socketPath: e.address.replace(/^npipe:\/\//, '') }
  const url = new URL(e.address)
  if (e.kind === 'ssh') return { protocol: 'ssh', host: url.hostname, port: url.port ? Number(url.port) : 22, username: url.username || undefined }
  if (url.protocol === 'unix:') return { socketPath: url.pathname }
  const tls = env.DOCKER_TLS_VERIFY === '1'
  const certs = env.DOCKER_CERT_PATH
  return {
    protocol: tls ? 'https' : 'http',
    host: url.hostname,
    port: Number(url.port || (tls ? 2376 : 2375)),
    ...(tls && certs ? { ca: readFileSync(join(certs, 'ca.pem')), cert: readFileSync(join(certs, 'cert.pem')), key: readFileSync(join(certs, 'key.pem')) } : {}),
  }
}
