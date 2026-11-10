import { execFile } from 'node:child_process'
import type { ResourceAction, WslResources } from '../../renderer/src/api/types'
import type { Engine } from '../engine/engine'
import { decode, run as wsl, runningDistros } from '../engine/wsl'
import { readWslconfig, setWslconfig, wslconfigPath } from './wslconfig'
import { listDistros } from './wsl-setup'

// Windows only. Two complaints about Docker Desktop that WSL shares: the VM
// keeps memory it no longer needs, and the virtual disk only ever grows.
// WSL has answers for both (memory reclaim, sparse disks, a memory cap); they
// are just buried in %UserProfile%\.wslconfig and `wsl --manage`. This puts
// them, with what they cost, in one place.

const ps = (script: string, timeout = 20_000): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout }, (e, out, err) => (e ? reject(new Error(String(err).trim() || e.message)) : resolve(String(out)))),
  )

const READ = `
$vm = (Get-Process -Name vmmemWSL, vmmem -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum
$d = Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if (-not $p.BasePath -or $p.DistributionName -like 'docker-desktop*') { return }
  $name = if ($p.VhdFileName) { $p.VhdFileName } else { 'ext4.vhdx' }
  $vhd = Join-Path ($p.BasePath -replace '^\\\\\\\\\\?\\\\', '') $name
  $f = Get-Item -LiteralPath $vhd -ErrorAction SilentlyContinue
  if ($f) { [pscustomobject]@{ name = $p.DistributionName; vhd = $vhd; size = $f.Length; sparse = [bool]($f.Attributes -band [IO.FileAttributes]::SparseFile) } }
}
$total = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
[pscustomobject]@{ vm = [int64]$vm; total = [int64]$total; disks = @($d) } | ConvertTo-Json -Depth 4 -Compress
`

export async function status(engine: Engine): Promise<WslResources> {
  const raw = JSON.parse((await ps(READ)).trim() || '{}') as { vm: number; total: number; disks: { name: string; vhd: string; size: number; sparse: boolean }[] | null }
  const cfg = readWslconfig()
  const running = await runningDistros()
  const known = await listDistros()
  const disks = await Promise.all(
    (raw.disks ?? []).map(async (d) => {
      let used: number | undefined
      if (running.includes(d.name)) {
        const r = await wsl(['--distribution', d.name, '--exec', 'df', '-B1', '--output=used', '/'], 15_000)
        used = Number(decode(r.stdout).trim().split(/\s+/).pop()) || undefined
      }
      return { distro: d.name, path: d.vhd, fileBytes: d.size, usedBytes: used, sparse: d.sparse, running: running.includes(d.name), version: known.find((k) => k.name === d.name)?.version ?? 2 }
    }),
  )
  let buildCache: WslResources['buildCache'] = null
  if (engine.getStatus().state === 'running') buildCache = await engine.buildCache().catch(() => null)
  return {
    memory: {
      vmBytes: raw.vm || 0,
      hostBytes: raw.total || 0,
      limit: cfg.wsl2?.memory ?? null,
      reclaim: (cfg.experimental?.automemoryreclaim ?? cfg.wsl2?.automemoryreclaim ?? 'disabled') as WslResources['memory']['reclaim'],
    },
    disks,
    sparseByDefault: (cfg.experimental?.sparsevhd ?? cfg.wsl2?.sparsevhd) === 'true',
    buildCache,
    wslconfig: wslconfigPath(),
  }
}


/** Applies one change; returns what to tell the user. */
export async function act(engine: Engine, a: ResourceAction): Promise<string> {
  const later = 'It applies after WSL restarts: wsl --shutdown (every distribution stops).'
  switch (a.kind) {
    case 'reclaim':
      setWslconfig('experimental', 'autoMemoryReclaim', a.mode === 'disabled' ? null : a.mode)
      return `Memory reclaim is ${a.mode === 'disabled' ? 'off' : a.mode}. ${later}`
    case 'limit':
      setWslconfig('wsl2', 'memory', a.gb ? `${a.gb}GB` : null)
      return `${a.gb ? `WSL may use up to ${a.gb} GB` : 'No memory cap'}. ${later}`
    case 'sparse-default':
      setWslconfig('experimental', 'sparseVhd', a.on ? 'true' : null)
      return a.on ? 'New distributions get a sparse disk.' : 'New distributions get a regular disk.'
    case 'make-sparse': {
      // The disk must be detached: stop the distribution, flip it, start it again.
      await wsl(['--terminate', a.distro], 60_000)
      const r = await wsl(['--manage', a.distro, '--set-sparse', 'true'], 5 * 60_000)
      const said = decode(r.stdout).trim() || decode(r.stderr).trim()
      await wsl(['--distribution', a.distro, '--exec', 'true'], 60_000)
      if (r.code !== 0) throw new Error(said || `wsl --manage failed (${r.code})`)
      void engine.reconnect()
      return `${a.distro}’s disk is sparse: space freed inside it now goes back to Windows. Run “Give space back” after deleting a lot.`
    }
    case 'trim': {
      // On a sparse disk, trimming hands the blocks Linux no longer uses back to Windows.
      const r = await wsl(['--distribution', a.distro, '--user', 'root', '--exec', 'fstrim', '-v', '/'], 10 * 60_000)
      if (r.code !== 0) throw new Error(decode(r.stderr).trim() || 'fstrim failed')
      return decode(r.stdout).trim() || 'Trimmed.'
    }
    case 'prune-build-cache': {
      const freed = await engine.pruneBuildCache()
      return `Freed ${(freed / 1e9).toFixed(2)} GB of build cache.`
    }
  }
}
