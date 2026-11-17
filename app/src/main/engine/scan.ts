import { PassThrough, type Readable } from 'node:stream'
import type Docker from 'dockerode'
import { ApiError, type ScanPhase, type ScanResult, type Severity, type Vulnerability } from '../../renderer/src/api/types'

// Vulnerability scans with Trivy, run as a short-lived container on the same
// engine: no account, nothing installed on Windows. The scanner reads the
// image through the engine's socket (read only) and keeps its database in a
// named volume, so only the first scan downloads it.

/** Pinned: a scanner that changes under people would change their results. */
export const TRIVY = 'aquasec/trivy:0.57.1'
const CACHE_VOLUME = 'tender-trivy-cache'
const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']

async function ensureImage(d: Docker, onPhase: (p: ScanPhase) => void, isCancelled: () => boolean) {
  if (await d.getImage(TRIVY).inspect().catch(() => null)) return
  onPhase('scanner')
  const s = (await d.pull(TRIVY)) as unknown as Readable
  await new Promise<void>((resolve, reject) => {
    d.modem.followProgress(s, (err: unknown) => (err ? reject(err) : resolve()))
  })
  if (isCancelled()) throw new ApiError('Scan cancelled.', 499)
}

export function scan(d: Docker, ref: string, onPhase: (p: ScanPhase) => void): { done: Promise<ScanResult>; cancel: () => void } {
  let cancelled = false
  let container: Docker.Container | null = null
  const done = (async (): Promise<ScanResult> => {
    await ensureImage(d, onPhase, () => cancelled)
    onPhase('database')
    container = await d.createContainer({
      Image: TRIVY,
      Cmd: ['image', '--format', 'json', '--scanners', 'vuln', '--no-progress', '--timeout', '10m', ref],
      Labels: { 'io.github.tender.helper': 'scan' },
      HostConfig: {
        Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro', `${CACHE_VOLUME}:/root/.cache`],
      },
    })
    const stream = (await container.attach({ stream: true, stdout: true, stderr: true })) as unknown as Readable
    const out = new PassThrough()
    const err = new PassThrough()
    d.modem.demuxStream(stream, out, err)
    const chunks: Buffer[] = []
    out.on('data', (c: Buffer) => chunks.push(c))
    let errText = ''
    err.on('data', (c: Buffer) => {
      const t = c.toString('utf8')
      errText = (errText + t).slice(-8000)
      if (/Detected OS|Detecting|Number of language-specific files/i.test(t)) onPhase('scanning')
    })
    await container.start()
    if (cancelled) throw new ApiError('Scan cancelled.', 499)
    const { StatusCode } = (await container.wait()) as { StatusCode: number }
    stream.destroy()
    if (cancelled) throw new ApiError('Scan cancelled.', 499)
    if (StatusCode !== 0) {
      const line = errText.split(/\r?\n/).filter((l) => /FATAL|ERROR/.test(l)).pop() ?? errText.trim().split(/\r?\n/).pop() ?? ''
      if (/permission denied.*docker.sock|Cannot connect to the Docker daemon|unable to inspect the image/i.test(line))
        throw new ApiError('The scanner couldn’t read the image through the engine’s socket. Scanning needs an engine at /var/run/docker.sock, like Docker in WSL.', 424)
      throw new ApiError(line.replace(/^.*?(FATAL|ERROR)\s*/, '') || `The scanner stopped with exit code ${StatusCode}.`, 422)
    }
    const report = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      Results?: { Target: string; Vulnerabilities?: { VulnerabilityID: string; PkgName: string; InstalledVersion: string; FixedVersion?: string; Severity: string; Title?: string; PrimaryURL?: string }[] }[]
    }
    const vulnerabilities: Vulnerability[] = (report.Results ?? []).flatMap((r) =>
      (r.Vulnerabilities ?? []).map((v) => ({
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installed: v.InstalledVersion,
        fixed: v.FixedVersion || undefined,
        severity: (SEVERITIES.includes(v.Severity as Severity) ? v.Severity : 'UNKNOWN') as Severity,
        title: v.Title,
        url: v.PrimaryURL,
        target: r.Target,
      })),
    )
    vulnerabilities.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.pkg.localeCompare(b.pkg))
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, vulnerabilities.filter((v) => v.severity === s).length])) as Record<Severity, number>
    return { image: ref, scannedAt: new Date().toISOString(), scanner: TRIVY, vulnerabilities, counts }
  })().finally(() => {
    void container?.remove({ force: true }).catch(() => undefined)
  })
  return {
    done,
    cancel: () => {
      cancelled = true
      void container?.kill().catch(() => undefined)
    },
  }
}
