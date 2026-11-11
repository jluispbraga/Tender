import { execFile } from 'node:child_process'
import type { DoctorCheck, DoctorFix } from '../../renderer/src/api/types'
import type { Engine } from '../engine/engine'
import { decode, engineOs, probe, repairSocket, run as wsl, runningDistros, wslStuck } from '../engine/wsl'
import * as tools from './windows-tools'
import { inspect, listDistros } from './wsl-setup'
import { readWslconfig, setWslconfig, wslconfigPath } from './wslconfig'

// The Doctor: everything Tender depends on, checked in one place, each
// problem with the fix next to it. Docker Desktop's most common complaint is
// that it stops starting after an update; here every link in the chain can be
// seen and repaired on its own.

const cmd = (file: string, args: string[], timeout = 20_000): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout, encoding: 'buffer' }, (e, out) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: decode(out as Buffer) })))

/** Which distribution the checks are about: the one Tender uses, else the default running one. */
async function targetDistro(engine: Engine): Promise<string | null> {
  if (engine.wslDistro) return engine.wslDistro
  const running = await runningDistros()
  const all = await listDistros()
  return all.find((d) => d.isDefault && running.includes(d.name))?.name ?? running[0] ?? null
}

export async function check(engine: Engine, share: tools.PipeShare): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = []
  const status = engine.getStatus()

  if (process.platform !== 'win32') {
    out.push(
      status.state === 'running'
        ? { id: 'engine', area: 'engine', title: 'Docker Engine answers', status: 'ok', detail: `Docker ${status.version} at ${status.endpoint}` }
        : {
            id: 'engine',
            area: 'engine',
            title: 'Docker Engine does not answer',
            status: 'fail',
            detail: status.error,
            hint: /permission denied/i.test(status.error ?? '') ? 'Add your user to the docker group (sudo usermod -aG docker $USER), then sign out and in again.' : 'Start it: sudo systemctl start docker (rootless: systemctl --user start docker).',
          },
    )
    return out
  }

  // -- WSL itself
  const v = await wsl(['--version'], 15_000)
  const version = /(\d+\.\d+\.\d+)/.exec(decode(v.stdout))?.[1]
  if (v.code !== 0 || !version) {
    out.push({ id: 'wsl', area: 'wsl', title: 'WSL is not installed, or too old to say its version', status: 'fail', hint: 'Install it from a terminal opened as administrator: wsl --install, then restart Windows.' })
    return out
  }
  const major = Number(version.split('.')[0])
  out.push(
    major >= 2
      ? { id: 'wsl', area: 'wsl', title: 'WSL is up to date enough', status: 'ok', detail: `WSL ${version}` }
      : { id: 'wsl', area: 'wsl', title: 'WSL is old', status: 'warn', detail: `WSL ${version}; systemd and DNS tunneling need 2.0 or later.`, fix: { id: 'wsl-update', label: 'Update WSL', note: 'Runs wsl --update; Windows may ask for permission.' } },
  )

  const distro = await targetDistro(engine)
  // WSL's service can wedge (after sleep, or a long uptime): --list still works, every command fails.
  const alive = distro ? await wsl(['--distribution', distro, '--exec', 'true'], 20_000) : null
  if (status.wslStuck || (alive && wslStuck(alive))) {
    out.push({
      id: 'wsl-stuck',
      area: 'wsl',
      title: 'WSL is not responding',
      status: 'fail',
      detail: 'Every command in Linux fails with “Catastrophic failure” (Wsl/Service/E_UNEXPECTED).',
      fix: { id: 'restart-wsl', label: 'Restart WSL', note: 'Runs wsl --shutdown: every distribution stops for a moment; Tender then starts the one with Docker again.' },
    })
  } else if (!distro) {
    const all = await listDistros()
    const def = all.find((d) => d.isDefault) ?? all[0]
    out.push(
      def
        ? { id: 'distro', area: 'wsl', title: 'No WSL distribution is running', status: 'warn', detail: `${def.name} is installed but stopped.`, fix: { id: 'start-distro', label: `Start ${def.name}`, distro: def.name } }
        : { id: 'distro', area: 'wsl', title: 'No WSL distribution installed', status: 'fail', link: { label: 'Set up Docker in WSL', route: 'setup' } },
    )
  } else {
    const i = await inspect(distro)
    out.push({ id: 'distro', area: 'wsl', title: `${distro} is running`, status: 'ok', detail: i.os })
    out.push(
      i.systemd
        ? { id: 'systemd', area: 'wsl', title: 'systemd runs in ' + distro, status: 'ok', detail: 'Docker starts with the distribution.' }
        : { id: 'systemd', area: 'wsl', title: 'systemd is off in ' + distro, status: 'warn', detail: 'Without it Docker does not start by itself.', link: { label: 'Set up Docker in WSL', route: 'setup' } },
    )

    // -- the engine inside it
    const p = await probe(distro)
    if (p.ok) {
      const os = await engineOs(distro)
      if (os.ok && /docker desktop/i.test(os.os)) {
        out.push({ id: 'engine', area: 'engine', title: `docker in ${distro} answers as Docker Desktop`, status: 'warn', detail: 'Docker Desktop’s WSL integration takes over the distribution’s socket while it runs, and removes it when it quits.', hint: 'In Docker Desktop › Settings › Resources › WSL integration, turn off “Enable integration with my default WSL distro” and this distribution.' })
      } else {
        out.push({ id: 'engine', area: 'engine', title: `Docker Engine runs in ${distro}`, status: 'ok', detail: `Docker ${p.version}` })
      }
    } else if (p.lostSocket) {
      out.push({ id: 'engine', area: 'engine', title: `Docker in ${distro} lost its socket`, status: 'fail', detail: 'Docker Desktop removes /var/run/docker.sock when it quits.', fix: { id: 'repair-socket', label: `Repair Docker in ${distro}`, distro, note: 'Restarts Docker there; containers with a restart policy come back.' } })
    } else if (/permission denied/.test(p.reason)) {
      out.push({ id: 'engine', area: 'engine', title: `${i.user} may not use Docker in ${distro}`, status: 'fail', detail: p.reason, fix: { id: 'docker-group', label: `Add ${i.user} to the docker group`, distro } })
    } else if (i.docker === 'installed') {
      out.push({ id: 'engine', area: 'engine', title: `Docker is installed in ${distro} but stopped`, status: 'fail', fix: { id: 'start-docker', label: `Start Docker in ${distro}`, distro } })
    } else {
      out.push({ id: 'engine', area: 'engine', title: `No Docker Engine in ${distro}`, status: 'fail', detail: p.reason, link: { label: 'Set up Docker in WSL', route: 'setup' } })
    }

    // -- network from inside: can it resolve Docker Hub?
    const dns = await wsl(['--distribution', distro, '--exec', 'getent', 'hosts', 'registry-1.docker.io'], 15_000)
    const tunneling = readWslconfig().wsl2?.dnstunneling === 'true'
    out.push(
      dns.code === 0
        ? { id: 'dns', area: 'network', title: `${distro} resolves Docker Hub`, status: 'ok', detail: decode(dns.stdout).trim().split(/\s+/)[0] }
        : {
            id: 'dns',
            area: 'network',
            title: `${distro} cannot resolve Docker Hub`,
            status: 'fail',
            detail: 'Pulls will fail. This is common behind a VPN.',
            ...(tunneling ? { hint: 'DNS tunneling is already on; check your VPN or proxy settings.' } : { fix: { id: 'dns-tunneling', label: 'Turn on DNS tunneling', note: `Adds dnsTunneling=true to ${wslconfigPath()}; applies after WSL restarts (wsl --shutdown).` } }),
          },
    )
  }

  // -- Tender's own connection
  out.push(status.state === 'running' ? { id: 'tender', area: 'engine', title: 'Tender is connected', status: 'ok', detail: status.endpoint } : { id: 'tender', area: 'engine', title: 'Tender is not connected', status: 'fail', detail: status.error })

  // -- Docker tools on Windows
  const t = await tools.status(share)
  out.push(
    t.pipe.state === 'serving'
      ? { id: 'pipe', area: 'windows', title: 'Windows tools can reach the engine', status: 'ok', detail: `//./pipe/docker_engine → ${t.pipe.distro}` }
      : t.pipe.state === 'taken'
        ? { id: 'pipe', area: 'windows', title: 'Another program serves //./pipe/docker_engine', status: 'info', detail: 'Usually Docker Desktop. Windows tools talk to it, not to the engine in WSL.' }
        : { id: 'pipe', area: 'windows', title: 'Windows tools cannot reach the engine in WSL', status: 'warn', detail: t.pipe.state === 'off' ? 'Sharing is off in Settings.' : 'Starts once Tender is connected to Docker in WSL.', link: { label: 'Docker on Windows settings', route: 'settings' } },
  )
  out.push(
    t.cli
      ? { id: 'cli', area: 'windows', title: 'Docker CLI on Windows', status: 'ok', detail: `docker ${t.cli.version}${t.compose ? `, Compose ${t.compose}` : ''}` }
      : { id: 'cli', area: 'windows', title: 'No Docker CLI on Windows', status: 'info', detail: 'Only needed to run docker from a Windows terminal.', link: { label: 'Install it', route: 'settings' } },
  )
  if (t.cli && !t.contextUsesPipe) out.push({ id: 'context', area: 'windows', title: `The Docker CLI uses the context “${t.context}”`, status: 'warn', detail: 'It does not talk to this engine.', fix: { id: 'default-context', label: 'Switch to the default context' } })
  return out
}

export async function fix(engine: Engine, f: DoctorFix['id'], distro?: string): Promise<string> {
  switch (f) {
    case 'wsl-update': {
      const r = await cmd('wsl.exe', ['--update'], 10 * 60_000)
      if (r.code !== 0) throw new Error(`wsl --update failed: ${r.out.trim()}`)
      return 'WSL updated.'
    }
    case 'restart-wsl':
      await engine.restartWsl()
      return 'WSL restarted.'
    case 'start-distro':
      await wsl(['--distribution', distro!, '--exec', 'true'], 60_000)
      await engine.reconnect()
      return `${distro} started.`
    case 'repair-socket':
      await repairSocket(distro!)
      await engine.reconnect()
      return `Docker in ${distro} has its socket back.`
    case 'start-docker': {
      const r = await wsl(['--distribution', distro!, '--user', 'root', '--exec', 'systemctl', 'enable', '--now', 'docker.socket', 'docker'], 120_000)
      if (r.code !== 0) throw new Error(decode(r.stderr).trim() || 'systemctl failed')
      await engine.reconnect()
      return `Docker started in ${distro}.`
    }
    case 'docker-group': {
      const i = await inspect(distro!)
      const r = await wsl(['--distribution', distro!, '--user', 'root', '--exec', 'usermod', '-aG', 'docker', i.user], 30_000)
      if (r.code !== 0) throw new Error(decode(r.stderr).trim() || 'usermod failed')
      await engine.reconnect()
      return `${i.user} is in the docker group. Open terminals keep the old groups until you open new ones.`
    }
    case 'dns-tunneling':
      setWslconfig('wsl2', 'dnsTunneling', 'true')
      return 'DNS tunneling is on. It applies after WSL restarts: run wsl --shutdown (every distribution stops), then open Tender again.'
    case 'default-context':
      await tools.useDefaultContext()
      return 'The Docker CLI uses the default context.'
  }
}
