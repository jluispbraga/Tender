import { spawn } from 'node:child_process'
import type { WslDistro, WslDistroDetail, WslSetupEvent, WslSetupStep } from '../../renderer/src/api/types'
import { decode, probe, run } from '../engine/wsl'

// Windows only. Installs Docker Engine inside a WSL distribution, the way
// Docker documents it for Debian and Ubuntu: systemd on, Docker's apt
// repository with its signing key, docker-ce with containerd, Buildx and
// Compose, the user in the docker group. Commands run as root through
// `wsl -u root`, so there is no sudo prompt. Every line they print is shown.

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

const INSPECT = `
. /etc/os-release 2>/dev/null
echo "id=$ID"
echo "like=$ID_LIKE"
echo "pretty=$PRETTY_NAME"
echo "codename=\${UBUNTU_CODENAME:-$VERSION_CODENAME}"
echo "pid1=$(cat /proc/1/comm 2>/dev/null)"
echo "dockerd=$(command -v dockerd || true)"
echo "docker=$(readlink -f "$(command -v docker)" 2>/dev/null || true)"
echo "active=$(systemctl is-active docker 2>/dev/null || true)"
`

export interface Inspection extends Omit<WslDistroDetail, 'name' | 'supported'> {
  /** debian or ubuntu, the families Docker's apt repository serves */
  family: 'debian' | 'ubuntu' | null
  codename: string
}

export async function detail(distro: string): Promise<WslDistroDetail> {
  const i = await inspect(distro)
  return { name: distro, os: i.os, supported: !!i.family, systemd: i.systemd, docker: i.docker, user: i.user }
}

/** Looks inside a distribution (starting it if it is stopped). */
export async function inspect(distro: string): Promise<Inspection> {
  const out = await runScript(distro, INSPECT, 30_000)
  const kv = Object.fromEntries(out.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
  const ids = `${kv.id} ${kv.like}`
  const family = /\bubuntu\b/.test(ids) ? 'ubuntu' : /\bdebian\b/.test(ids) ? 'debian' : null
  const who = await run(['--distribution', distro, '--exec', 'whoami'], 15_000)
  const docker: WslDistroDetail['docker'] = kv.dockerd
    ? kv.active === 'active'
      ? 'running'
      : 'installed'
    : kv.docker.includes('docker-desktop')
      ? 'desktop-cli'
      : kv.docker
        ? 'cli-only'
        : 'none'
  return { os: kv.pretty || kv.id || distro, family, codename: kv.codename, systemd: kv.pid1 === 'systemd', docker, user: decode(who.stdout).trim() }
}

/** Runs a shell script as root inside the distribution; the script goes through stdin, so nothing is quoted. */
function runScript(distro: string, script: string, timeout: number, onLine?: (l: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['--distribution', distro, '--user', 'root', '--exec', 'sh', '-s'], { windowsHide: true })
    let out = ''
    let buf = ''
    const timer = setTimeout(() => child.kill(), timeout)
    const take = (chunk: Buffer) => {
      const text = decode(chunk)
      out += text
      if (!onLine) return
      buf += text
      const lines = buf.split(/\r?\n|\r/)
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (buf.trim()) onLine?.(buf)
      if (code === 0) resolve(out)
      else reject(new Error(`exited with code ${code}`))
    })
    child.stdin.end(script.replace(/\r\n/g, '\n'))
  })
}

const SYSTEMD = `
set -e
touch /etc/wsl.conf
if grep -q '^\\[boot\\]' /etc/wsl.conf; then
  if grep -q '^systemd *=' /etc/wsl.conf; then sed -i 's/^systemd *=.*/systemd=true/' /etc/wsl.conf
  else sed -i '/^\\[boot\\]/a systemd=true' /etc/wsl.conf; fi
else
  printf '\\n[boot]\\nsystemd=true\\n' >> /etc/wsl.conf
fi
echo "systemd turned on in /etc/wsl.conf"
`

/** Docker's documented apt install for Debian and Ubuntu (docs.docker.com/engine/install). */
const APT = (family: string, codename: string) => `
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/${family}/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${family} ${codename} stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
`

/** Installs Docker Engine in `distro`. Emits a step at a time, with every line the commands print. */
export function install(distro: string, emit: (e: WslSetupEvent) => void): () => void {
  let cancelled = false
  void (async () => {
    const step = async (name: WslSetupStep, work: () => Promise<string | void>) => {
      if (cancelled) throw new Error('cancelled')
      emit({ type: 'step', step: name, status: 'working' })
      try {
        const detail = await work()
        emit({ type: 'step', step: name, status: 'done', detail: detail || undefined })
      } catch (e) {
        emit({ type: 'step', step: name, status: 'failed', detail: (e as Error).message })
        throw e
      }
    }
    const line = (l: string) => emit({ type: 'line', line: l })
    try {
      let info = await inspect(distro)
      if (!info.family) throw new Error(`${info.os} is not Debian or Ubuntu; Tender can only install Docker there for now.`)
      if (info.docker === 'running') {
        emit({ type: 'done', alreadyInstalled: true })
        return
      }
      if (!info.systemd) {
        await step('systemd', async () => {
          await runScript(distro, SYSTEMD, 30_000, line)
          // wsl.conf is read when the distribution boots: restart it.
          await run(['--terminate', distro], 30_000)
          await run(['--distribution', distro, '--exec', 'true'], 60_000)
          info = await inspect(distro)
          if (!info.systemd) throw new Error('systemd is still not running after the restart. Check that WSL is up to date: wsl --update')
          return 'restarted the distribution with systemd'
        })
      }
      if (info.docker !== 'installed') await step('packages', async () => void (await runScript(distro, APT(info.family!, info.codename), 15 * 60_000, line)))
      await step('group', async () => {
        if (!info.user || info.user === 'root') return 'the default user is root'
        await runScript(distro, `usermod -aG docker '${info.user.replace(/'/g, '')}'`, 30_000, line)
        return `added ${info.user} to the docker group`
      })
      await step('service', async () => void (await runScript(distro, 'systemctl enable --now docker.socket docker', 120_000, line)))
      await step('check', async () => {
        const p = await probe(distro)
        if (!p.ok) throw new Error(p.reason)
        return `Docker ${p.version} answers`
      })
      emit({ type: 'done' })
    } catch (e) {
      emit({ type: 'error', message: (e as Error).message })
    }
  })()
  return () => {
    cancelled = true
  }
}
