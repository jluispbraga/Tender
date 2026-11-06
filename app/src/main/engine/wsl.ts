import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:net'

// Windows only. Docker Engine installed straight into a WSL distribution
// (no Docker Desktop) listens on a Unix socket inside that distribution,
// which no Windows program can open. Tender bridges it without changing
// anything there: a private named pipe on the Windows side, and for every
// connection `docker system dial-stdio` inside the distribution, the same
// relay the Docker CLI itself uses for SSH. No TCP port, no root, no setup.
// Only distributions that are already running are looked at, so Tender never
// boots one.

const WSL = 'wsl.exe'

interface Run {
  code: number | null
  stdout: Buffer
  stderr: Buffer
}

function run(args: string[], timeout: number): Promise<Run> {
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

export type Probe = { ok: true; distro: string; version: string } | { ok: false; distro: string; reason: string }

/** Asks the distribution's own Docker CLI whether its engine answers. */
export async function probe(distro: string): Promise<Probe> {
  const r = await run(['--distribution', distro, '--exec', 'docker', 'version', '--format', '{{.Server.Version}}'], 10_000)
  const version = decode(r.stdout).trim()
  if (r.code === 0 && version) return { ok: true, distro, version }
  const err = decode(r.stderr).trim()
  const reason = /permission denied/i.test(err)
    ? 'permission denied on the Docker socket (add your user to the docker group)'
    : /cannot connect|is the docker daemon running/i.test(err)
      ? 'Docker is installed but its engine is not running'
      : /no such file|not found|execvpe/i.test(err) || r.code === 1
        ? 'no Docker CLI installed'
        : err.split('\n')[0] || `exit code ${r.code}`
  return { ok: false, distro, reason }
}

/** The first running distribution whose engine answers, or why none did. */
export async function findWslEngine(): Promise<{ found: Probe & { ok: true } } | { found: null; why: string }> {
  const distros = await runningDistros()
  if (!distros.length) return { found: null, why: 'no WSL distribution is running' }
  const misses: string[] = []
  for (const d of distros) {
    const p = await probe(d)
    if (p.ok) return { found: p }
    misses.push(`${d}: ${p.reason}`)
  }
  return { found: null, why: misses.join('; ') }
}

/** A private named pipe that relays each connection to the engine inside `distro`. */
export class WslBridge {
  private children = new Set<ChildProcess>()

  private constructor(
    readonly distro: string,
    readonly pipe: string,
    private server: Server,
  ) {}

  static open(distro: string): Promise<WslBridge> {
    const pipe = `\\\\.\\pipe\\tender-wsl-${process.pid}-${randomBytes(6).toString('hex')}`
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
