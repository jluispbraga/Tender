import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EngineOption } from '../../renderer/src/api/types'
import { resolveEndpoint, type Endpoint } from './endpoint'
import { listDistros } from './wsl'

// Which engine Tender talks to. "auto" is what the Docker CLI would pick
// (DOCKER_HOST, the current context, the default pipe or socket, then WSL).
// Anything else is a choice the person made in Settings: a WSL distribution
// (wsl://Ubuntu), a Docker context (context://name) or an address.

import { ADDRESS, AUTO } from './engine-choice'

export { AUTO }

/** Docker contexts from ~/.docker/contexts/meta/<hash>/meta.json: name and host. Read only. */
export function dockerContexts(dockerDir = process.env.DOCKER_CONFIG || join(homedir(), '.docker')): { name: string; host: string }[] {
  const meta = join(dockerDir, 'contexts', 'meta')
  if (!existsSync(meta)) return []
  return readdirSync(meta).flatMap((d) => {
    try {
      const j = JSON.parse(readFileSync(join(meta, d, 'meta.json'), 'utf8')) as { Name?: string; Endpoints?: { docker?: { Host?: string } } }
      const host = j.Endpoints?.docker?.Host
      return j.Name && host ? [{ name: j.Name, host }] : []
    } catch {
      return []
    }
  })
}

const kindOf = (address: string): Endpoint['kind'] => (address.startsWith('npipe:') ? 'npipe' : address.startsWith('unix:') ? 'unix' : address.startsWith('ssh:') ? 'ssh' : 'tcp')

/**
 * The endpoint for a choice. A WSL choice comes back as a npipe endpoint with
 * the distro in the address; the engine opens the bridge for it.
 */
export function endpointFor(choice: string): Endpoint {
  if (!choice || choice === AUTO) return resolveEndpoint()
  if (choice.startsWith('wsl://')) return { name: `wsl:${choice.slice(6)}`, kind: 'npipe', address: choice, source: `Docker in WSL (${choice.slice(6)}), chosen in Settings` }
  if (choice.startsWith('context://')) {
    const name = choice.slice('context://'.length)
    const c = dockerContexts().find((x) => x.name === name)
    if (c) return { name, kind: kindOf(c.host), address: c.host, source: `the Docker context “${name}”, chosen in Settings` }
    return { name, kind: 'tcp', address: 'tcp://context-not-found:0', source: `the Docker context “${name}”, which no longer exists` }
  }
  if (ADDRESS.test(choice)) return { name: 'custom', kind: kindOf(choice), address: choice, source: 'the address chosen in Settings' }
  return resolveEndpoint()
}

/** Everything worth offering: automatic, each WSL 2 distribution, each Docker context, the current custom address. */
export async function options(current: string): Promise<EngineOption[]> {
  const auto = resolveEndpoint()
  const out: EngineOption[] = [{ choice: AUTO, label: 'Automatic', detail: `Like the Docker CLI: now ${auto.address}, with WSL as a fallback on Windows` }]
  if (process.platform === 'win32') {
    for (const d of await listDistros().catch(() => [])) {
      if (d.version !== 2 || /^docker-desktop/.test(d.name)) continue
      out.push({ choice: `wsl://${d.name}`, label: `WSL: ${d.name}`, detail: d.running ? 'Docker inside this distribution' : 'Docker inside this distribution (not running now; Tender starts it)' })
    }
  }
  for (const c of dockerContexts()) out.push({ choice: `context://${c.name}`, label: `Context: ${c.name}`, detail: c.host })
  if (ADDRESS.test(current) && !out.some((o) => o.choice === current)) out.push({ choice: current, label: 'Custom address', detail: current })
  return out
}
