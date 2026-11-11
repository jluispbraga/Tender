import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import type { WslDistro } from '../../renderer/src/api/types'

// Windows only. Docker Engine installed straight into a WSL distribution
// (no Docker Desktop) listens on a Unix socket inside that distribution,
// which no Windows program can open. Tender bridges it without changing
// anything there: a private named pipe on the Windows side, and for every
// connection `docker system dial-stdio` inside the distribution, the same
// relay the Docker CLI itself uses for SSH. No TCP port, no root, no setup.
// Running distributions are looked at first. After Windows restarts none is
// running, so Tender boots the one whose engine it used last (or, the first
// time, the default one): Docker Desktop did that too, and without it the
// containers seem gone until something else starts WSL.

const WSL = 'wsl.exe'

interface Run {
  code: number | null
  stdout: Buffer
  stderr: Buffer
}

export function run(args: string[], timeout: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(WSL, args, { encoding: 'buffer', timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : null) : 0
      resolve({ code, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0) })
    })
  })
}

/** wsl.exe writes its own messages in UTF-16LE; programs inside the distribution write UTF-8. */
export function decode(b: Buffer): string {
  const utf16 = b.length > 1 && b.subarray(0, Math.min(b.length, 64)).includes(0)
  return (utf16 ? b.toString('utf16le') : b.toString('utf8')).replace(/^﻿/, '').replace(/\0/g, '')
}

/** Whether a named pipe exists, without opening it. */
export function pipeExists(name: string): boolean {
  try {
    return readdirSync('\\\\.\\pipe\\').includes(name)
  } catch {
    // Can't list pipes: assume it exists and let the connection attempt decide.
    return true
  }
}

/** Running distributions, minus Docker Desktop's own (its engine has its own pipe). */
export async function runningDistros(): Promise<string[]> {
  const r = await run(['--list', '--running', '--quiet'], 5000)
  if (r.code !== 0) return []
  return decode(r.stdout)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((d) => d && !d.startsWith('docker-desktop'))
}

/** Every distribution, from `wsl --list --verbose`. Lists only; does not start any. */
export async function listDistros(): Promise<WslDistro[]> {
  const r = await run(['--list', '--verbose'], 10_000)
  if (r.code !== 0) return []
  return decode(r.stdout)
    .split(/\r?\n/)
    .slice(1)
    .map((l) => /^(\*)?\s*(\S+)\s+(\S+)\s+(\d)\s*$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .filter((m) => !m[2].startsWith('docker-desktop'))
    .map((m) => ({ name: m[2], isDefault: !!m[1], running: m[3].toLowerCase() === 'running', version: Number(m[4]) }))
}

export type Probe = { ok: true; distro: string; version: string } | { ok: false; distro: string; reason: string; lostSocket?: boolean }

/** Asks the distribution's own Docker CLI whether its engine answers. */
export async function probe(distro: string, timeout = 10_000): Promise<Probe> {
  const r = await run(['--distribution', distro, '--exec', 'docker', 'version', '--format', '{{.Server.Version}}'], timeout)
  const version = decode(r.stdout).trim()
  if (r.code === 0 && version) return { ok: true, distro, version }
  const err = decode(r.stderr).trim()
  if (/cannot connect|is the docker daemon running/i.test(err) && (await socketLost(distro))) {
    return { ok: false, distro, reason: 'its engine is running but lost its socket (Docker Desktop removes /var/run/docker.sock when it quits)', lostSocket: true }
  }
  const reason = /permission denied/i.test(err)
    ? 'permission denied on the Docker socket (add your user to the docker group)'
    : /cannot connect|is the docker daemon running/i.test(err)
      ? 'Docker is installed but its engine is not running'
      : /no such file|not found|execvpe/i.test(err) || r.code === 1
        ? 'no Docker CLI installed'
        : err.split('\n')[0] || `exit code ${r.code}`
  return { ok: false, distro, reason }
}

/**
 * The first running distribution whose engine answers. If none does, boots the
 * stopped ones named in `boot` (that are installed, WSL 2) and asks them: running
 * a command in a stopped distribution starts it, and systemd starts Docker.
 */
export async function findWslEngine(boot: string[] = []): Promise<{ found: Probe & { ok: true }; booted?: boolean } | { found: null; why: string; lost?: string }> {
  const distros = await runningDistros()
  const misses: string[] = []
  let lost: string | undefined
  for (const d of distros) {
    const p = await probe(d)
    if (p.ok) return { found: p }
    if (p.lostSocket) lost ??= d
    misses.push(`${d}: ${p.reason}`)
  }
  const installed = boot.length ? await listDistros() : []
  for (const d of [...new Set(boot)]) {
    if (distros.includes(d) || !installed.some((x) => x.name === d && x.version === 2)) continue
    // A cold start after Windows boots can take a while: the VM, then systemd, then Docker.
    const p = await probe(d, 60_000)
    if (p.ok) return { found: p, booted: true }
    misses.push(`${d} (started it): ${p.reason}`)
  }
  return { found: null, why: misses.join('; ') || 'no WSL distribution is running', lost }
}

/**
 * The distribution's Docker service runs, but /var/run/docker.sock is gone. Docker
 * Desktop's WSL integration replaces that socket while it runs and deletes it when it
 * quits, leaving the distribution's own engine running and unreachable.
 */
export async function socketLost(distro: string): Promise<boolean> {
  const r = await run(['--distribution', distro, '--exec', 'sh', '-c', 'systemctl is-active --quiet docker && [ ! -S /var/run/docker.sock ]'], 10_000)
  return r.code === 0
}

/**
 * Gives the socket back by restarting the distribution's Docker service. WSL runs
 * commands as root without a password (`wsl -u root`), so no sudo prompt. The restart
 * stops the engine's containers; those with a restart policy come back.
 */
export async function repairSocket(distro: string): Promise<void> {
  const r = await run(['--distribution', distro, '--user', 'root', '--exec', 'systemctl', 'restart', 'docker.socket', 'docker'], 90_000)
  if (r.code !== 0) throw new Error(`Could not restart Docker in ${distro}: ${decode(r.stderr).trim() || `exit code ${r.code}`}`)
  const p = await probe(distro)
  if (!p.ok) throw new Error(`Docker in ${distro} restarted but still does not answer: ${p.reason}`)
}

/** A private named pipe that relays each connection to the engine inside `distro`. */
export class WslBridge {
  private children = new Set<ChildProcess>()

  private constructor(
    readonly distro: string,
    readonly pipe: string,
    private server: Server,
  ) {}

  /** `pipe`: the full pipe path to serve on; by default a private, random one. */
  static open(distro: string, pipe = `\\\\.\\pipe\\tender-wsl-${process.pid}-${randomBytes(6).toString('hex')}`): Promise<WslBridge> {
    const children = new Set<ChildProcess>()
    const server = createServer((sock) => {
      const child = spawn(WSL, ['--distribution', distro, '--exec', 'docker', 'system', 'dial-stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
      children.add(child)
      const done = () => {
        children.delete(child)
        if (child.exitCode === null) child.kill()
        sock.destroy()
      }
      // Half-closes travel both ways: the request side ends stdin, the engine side ends the socket.
      sock.pipe(child.stdin!)
      child.stdout!.pipe(sock)
      child.stdin!.on('error', done)
      child.on('error', done)
      child.on('close', () => children.delete(child))
      sock.on('error', done)
      sock.on('close', done)
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipe, () => {
        server.off('error', reject)
        const bridge = new WslBridge(distro, pipe, server)
        bridge.children = children
        resolve(bridge)
      })
    })
  }

  close() {
    this.server.close()
    for (const c of this.children) c.kill()
    this.children.clear()
  }
}

/** What `docker info` calls the engine a distribution's CLI talks to, or why it can't tell. */
export async function engineOs(distro: string): Promise<{ ok: true; os: string; version: string } | { ok: false; reason: string; lostSocket?: boolean }> {
  const r = await run(['--distribution', distro, '--exec', 'docker', 'info', '--format', '{{.OperatingSystem}}|{{.ServerVersion}}'], 15_000)
  const [os, version] = decode(r.stdout).trim().split('|')
  if (r.code === 0 && os) return { ok: true, os, version: version ?? '' }
  const p = await probe(distro)
  return p.ok ? { ok: false, reason: 'docker info failed' } : { ok: false, reason: p.reason, lostSocket: p.lostSocket }
}
