import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WindowsTools } from '../../renderer/src/api/types'
import type { Engine } from '../engine/engine'
import { pipeExists, WslBridge } from '../engine/wsl'

// Windows only. Without Docker Desktop, the tools that expect Docker on
// Windows (docker.exe, the VS Code Docker extension, Testcontainers, IDEs)
// find nothing. Tender fills that in: it serves the standard pipe
// //./pipe/docker_engine from the engine inside WSL while it runs, and it can
// install the official Docker CLI, Compose and Buildx for the current user.

// Dev only: TENDER_SHARE_PIPE serves another name, to test next to Docker Desktop.
const PIPE = (!app.isPackaged && process.env.TENDER_SHARE_PIPE) || 'docker_engine'

/** Serves \\.\pipe\docker_engine, relaying to the WSL engine Tender uses, while that pipe is free. */
export class PipeShare {
  private bridge: WslBridge | null = null
  private queue: Promise<void> = Promise.resolve()
  state: WindowsTools['pipe']['state'] = 'off'

  constructor(private engine: Engine) {}

  get distro() {
    return this.bridge?.distro
  }

  /** Brings the share in line with the setting and the engine; calls are serialised. */
  sync(enabled: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.apply(enabled)).catch(() => undefined)
    return this.queue
  }

  private async apply(enabled: boolean) {
    if (process.platform !== 'win32' || !enabled) {
      this.close()
      this.state = 'off'
      return
    }
    const distro = this.engine.wslDistro
    if (this.bridge && this.bridge.distro === distro) return
    this.close()
    if (!distro) {
      // Tender is not on a WSL engine (Docker Desktop, DOCKER_HOST...): nothing to share.
      this.state = 'waiting'
      return
    }
    if (pipeExists(PIPE)) {
      // Something else serves it, most likely Docker Desktop: leave it alone.
      this.state = 'taken'
      return
    }
    try {
      this.bridge = await WslBridge.open(distro, `\\\\.\\pipe\\${PIPE}`)
      this.engine.servedPipe = PIPE
      this.state = 'serving'
    } catch {
      this.state = 'taken'
    }
  }

  close() {
    this.bridge?.close()
    this.bridge = null
    if (this.engine.servedPipe === PIPE) this.engine.servedPipe = null
  }
}

// ---- the Docker CLI on Windows ---------------------------------------------------------------

/** Where Tender installs the CLI for this user; added to the user's PATH. */
export const binDir = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Tender', 'bin')
const dockerDir = () => process.env.DOCKER_CONFIG || join(homedir(), '.docker')
const pluginDir = () => join(dockerDir(), 'cli-plugins')

function run(file: string, args: string[], timeout = 20_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out).trim(), err: String(err).trim() }))
  })
}

/** The docker.exe a terminal would run: the one on PATH, else Tender's own copy. */
async function findDocker(): Promise<string | null> {
  const r = await run('where.exe', ['docker'])
  const onPath = r.code === 0 ? r.out.split(/\r?\n/).find((l) => /\.exe$/i.test(l)) : undefined
  if (onPath) return onPath
  const own = join(binDir(), 'docker.exe')
  return existsSync(own) ? own : null
}

export async function status(share: PipeShare): Promise<WindowsTools> {
  const docker = await findDocker()
  let cli: WindowsTools['cli'] = null
  let compose: string | null = null
  let buildx: string | null = null
  if (docker) {
    const [v, c, b] = await Promise.all([run(docker, ['version', '--format', '{{.Client.Version}}']), run(docker, ['compose', 'version', '--short']), run(docker, ['buildx', 'version'])])
    cli = { path: docker, version: v.out.split(/\r?\n/)[0] || 'unknown', own: docker.toLowerCase().startsWith(binDir().toLowerCase()) }
    compose = c.code === 0 ? c.out : null
    buildx = b.code === 0 ? (/v?\d+\.\d+\.\d+/.exec(b.out)?.[0] ?? b.out) : null
  }
  let context = 'default'
  try {
    context = JSON.parse(readFileSync(join(dockerDir(), 'config.json'), 'utf8')).currentContext || 'default'
  } catch {
    // no config.json: the default context
  }
  return {
    pipe: { state: share.state, distro: share.distro },
    cli,
    compose,
    buildx,
    context,
    // Contexts other than default point somewhere else than the pipe Tender serves.
    contextUsesPipe: context === 'default',
    binOnPath: (process.env.Path ?? process.env.PATH ?? '').toLowerCase().split(';').includes(binDir().toLowerCase()),
  }
}

// ---- installing ------------------------------------------------------------------------------

async function download(url: string, to: string) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Tender' } })
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}): ${url}`)
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(to))
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

async function latestRelease(repo: string): Promise<{ tag: string; assets: { name: string; url: string; digest?: string }[] }> {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'Tender', Accept: 'application/vnd.github+json' } })
  if (!r.ok) throw new Error(`Could not read the latest ${repo} release (${r.status})`)
  const j = (await r.json()) as { tag_name: string; assets: { name: string; browser_download_url: string; digest?: string | null }[] }
  return { tag: j.tag_name, assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, digest: a.digest ?? undefined })) }
}

/**
 * A GitHub release asset, checked before it is installed: against the SHA-256
 * GitHub records for every release asset, else against the release's own
 * checksum file. With neither, nothing is installed.
 */
async function fetchVerified(repo: string, pick: (name: string) => boolean, sumsFile: string, to: string): Promise<string> {
  const rel = await latestRelease(repo)
  const asset = rel.assets.find((a) => pick(a.name))
  if (!asset) throw new Error(`No Windows build in ${repo} ${rel.tag}`)
  let expected = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined
  if (!expected) {
    const sums = rel.assets.find((a) => a.name === sumsFile)
    if (sums) {
      const text = await (await fetch(sums.url, { headers: { 'User-Agent': 'Tender' } })).text()
      // "<hash>  <name>", "<hash> *<name>", or a file holding just the hash of this one asset.
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      expected = lines.map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l)).find((m) => m && m[2] === asset.name)?.[1] ?? (lines.length === 1 && /^[0-9a-f]{64}$/i.test(lines[0]) ? lines[0] : undefined)
    }
  }
  if (!expected) throw new Error(`No checksum published for ${asset.name}; nothing was installed`)
  const tmp = mkdtempSync(join(tmpdir(), 'tender-cli-'))
  try {
    const file = join(tmp, asset.name)
    await download(asset.url, file)
    if (expected.toLowerCase() !== sha256(file)) throw new Error(`Checksum mismatch for ${asset.name}; nothing was installed`)
    copyFileSync(file, to)
    return rel.tag
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** The newest docker-<version>.zip on Docker's static download site. */
async function latestStaticCli(): Promise<string> {
  const base = 'https://download.docker.com/win/static/stable/x86_64/'
  const html = await (await fetch(base, { headers: { 'User-Agent': 'Tender' } })).text()
  const versions = [...html.matchAll(/docker-(\d+)\.(\d+)\.(\d+)\.zip/g)].map((m) => [+m[1], +m[2], +m[3]] as const)
  if (!versions.length) throw new Error('Could not find the Docker CLI on download.docker.com')
  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])
  return `${base}docker-${versions[0].join('.')}.zip`
}

/** Adds Tender's bin folder to the user's PATH (HKCU), for terminals opened from now on. */
async function addToUserPath(dir: string) {
  const script = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if (-not $p) { $p='' }; if (($p -split ';') -notcontains '${dir}') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${dir}').TrimStart(';'), 'User') }`
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (r.code !== 0) throw new Error(`Could not add ${dir} to your PATH: ${r.err}`)
  // This process keeps its own PATH; reflect it so the status shows the change.
  if (!(process.env.Path ?? '').toLowerCase().split(';').includes(dir.toLowerCase())) process.env.Path = `${process.env.Path ?? ''};${dir}`
}

export type InstallStep = { step: 'cli' | 'compose' | 'buildx' | 'path'; status: 'working' | 'done' | 'failed'; detail?: string }

/** Installs docker.exe (Docker's static build), Compose and Buildx (GitHub releases, checksum-verified). */
export async function installCli(onStep: (s: InstallStep) => void): Promise<void> {
  const bin = binDir()
  mkdirSync(bin, { recursive: true })
  mkdirSync(pluginDir(), { recursive: true })
  let failed = false
  const stage = async (step: InstallStep['step'], work: () => Promise<string | undefined>) => {
    onStep({ step, status: 'working' })
    try {
      onStep({ step, status: 'done', detail: await work() })
    } catch (e) {
      failed = true
      onStep({ step, status: 'failed', detail: (e as Error).message })
    }
  }

  await stage('cli', async () => {
    const url = await latestStaticCli()
    const tmp = mkdtempSync(join(tmpdir(), 'tender-cli-'))
    try {
      const zip = join(tmp, 'docker.zip')
      await download(url, zip)
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`], 120_000)
      if (r.code !== 0) throw new Error(`Could not unpack ${url}: ${r.err}`)
      copyFileSync(join(tmp, 'docker', 'docker.exe'), join(bin, 'docker.exe'))
      return /docker-([\d.]+)\.zip/.exec(url)?.[1]
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
  await stage('compose', () =>
    fetchVerified('docker/compose', (n) => n === 'docker-compose-windows-x86_64.exe', 'docker-compose-windows-x86_64.exe.sha256', join(pluginDir(), 'docker-compose.exe')),
  )
  await stage('buildx', () =>
    fetchVerified('docker/buildx', (n) => /^buildx-v[\d.]+\.windows-amd64\.exe$/.test(n), 'checksums.txt', join(pluginDir(), 'docker-buildx.exe')),
  )
  await stage('path', async () => {
    // Dev only: TENDER_NO_PATH leaves the user's PATH alone (tests install into a temp folder).
    if (!app.isPackaged && process.env.TENDER_NO_PATH) return `${bin} (PATH left alone)`
    await addToUserPath(bin)
    return bin
  })
  if (failed) throw new Error('Some parts did not install; see the steps above.')
}

/** Points the Docker CLI back at the default context (the standard pipe), like `docker context use default`. */
export async function useDefaultContext(): Promise<void> {
  const docker = await findDocker()
  if (!docker) throw new Error('Install the Docker CLI first.')
  const r = await run(docker, ['context', 'use', 'default'])
  if (r.code !== 0) throw new Error(r.err || 'docker context use default failed')
}
