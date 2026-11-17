import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as k8s from '@kubernetes/client-node'
import { ApiError, type HelmRelease, type HelmRevision } from '../../renderer/src/api/types'
import { forContext, quick } from './kube'

// Helm releases, read the way Helm 3 stores them: one Secret per revision
// (type helm.sh/release.v1), its "release" key holding base64 of gzipped
// JSON. Reading needs no helm binary. Rolling back does, because Helm has to
// render and apply the chart; Tender runs `helm rollback` when helm is there.

type Raw = {
  name: string
  namespace: string
  version: number
  info?: { status?: string; first_deployed?: string; last_deployed?: string; description?: string; notes?: string }
  chart?: { metadata?: { name?: string; version?: string; appVersion?: string } }
  config?: Record<string, unknown>
}

/** Secret data is base64; Helm base64s the gzip again on top. */
export function decodeRelease(secretValue: string): Raw {
  const once = Buffer.from(secretValue, 'base64')
  const twice = Buffer.from(once.toString('utf8'), 'base64')
  const json = twice[0] === 0x1f && twice[1] === 0x8b ? gunzipSync(twice).toString('utf8') : twice.toString('utf8')
  return JSON.parse(json) as Raw
}

/** Values that look like credentials are shown as •••• : the release Secret holds them in clear. */
const SECRETISH = /pass(word)?|secret|token|api[-_]?key|private[-_]?key|credential|auth/i
export function maskValues(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => maskValues(x, key))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValues(x, k)]))
  if (SECRETISH.test(key) && v !== null && v !== '' && typeof v !== 'boolean') return '••••'
  return v
}

async function releaseSecrets(context: string, namespace: string, name?: string) {
  const core = forContext(context).makeApiClient(k8s.CoreV1Api)
  const labelSelector = `owner=helm${name ? `,name=${name}` : ''}`
  const r = await quick(namespace === '*' ? core.listSecretForAllNamespaces({ labelSelector }) : core.listNamespacedSecret({ namespace, labelSelector }), context)
  return r.items.filter((s) => s.type === 'helm.sh/release.v1' && s.data?.release)
}

const toRevision = (r: Raw): HelmRevision => ({
  revision: r.version,
  status: r.info?.status ?? 'unknown',
  chart: `${r.chart?.metadata?.name ?? '?'}-${r.chart?.metadata?.version ?? '?'}`,
  appVersion: r.chart?.metadata?.appVersion,
  updatedAt: r.info?.last_deployed,
  description: r.info?.description,
})

/** The newest revision of every release in the namespace (or all, '*'). */
export async function releases(context: string, namespace: string): Promise<HelmRelease[]> {
  const latest = new Map<string, Raw>()
  const counts = new Map<string, number>()
  for (const s of await releaseSecrets(context, namespace)) {
    let r: Raw
    try {
      r = decodeRelease(s.data!.release)
    } catch {
      continue
    }
    const key = `${r.namespace}/${r.name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if ((latest.get(key)?.version ?? 0) < r.version) latest.set(key, r)
  }
  return [...latest.values()]
    .map((r) => ({ name: r.name, namespace: r.namespace, revisions: counts.get(`${r.namespace}/${r.name}`) ?? 1, ...toRevision(r) }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

export async function history(context: string, namespace: string, name: string): Promise<HelmRevision[]> {
  const out: HelmRevision[] = []
  for (const s of await releaseSecrets(context, namespace, name)) {
    try {
      out.push(toRevision(decodeRelease(s.data!.release)))
    } catch {
      // A revision Helm itself couldn't read: skip it.
    }
  }
  return out.sort((a, b) => b.revision - a.revision)
}

/** The values set for one revision (helm get values), credentials masked, plus its notes. */
export async function values(context: string, namespace: string, name: string, revision: number): Promise<{ values: unknown; notes?: string }> {
  for (const s of await releaseSecrets(context, namespace, name)) {
    const r = decodeRelease(s.data!.release)
    if (r.version === revision) return { values: maskValues(r.config ?? {}), notes: r.info?.notes }
  }
  throw new ApiError(`Revision ${revision} of ${name} isn’t there any more.`, 404)
}

export function findHelm(): string | null {
  const exe = process.platform === 'win32' ? 'helm.exe' : 'helm'
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(process.platform === 'win32' ? ';' : ':')) if (dir && existsSync(join(dir, exe))) return join(dir, exe)
  return null
}

/** helm rollback, with a kubeconfig holding only this context so nothing else can be touched. */
export async function rollback(context: string, namespace: string, name: string, revision: number): Promise<string> {
  const helm = findHelm()
  if (!helm) throw new ApiError('Rolling back needs Helm. Install it (winget install Helm.Helm) and open Tender again.', 424)
  const kc = forContext(context)
  const dir = mkdtempSync(join(tmpdir(), 'tender-helm-'))
  const file = join(dir, 'kubeconfig')
  writeFileSync(file, kc.exportConfig(), { mode: 0o600 })
  try {
    const r = await new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(helm, ['rollback', name, String(revision), '--namespace', namespace, '--kubeconfig', file, '--kube-context', kc.getCurrentContext(), '--wait', '--timeout', '5m'], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.on('error', (e) => resolve({ code: -1, out: e.message }))
      child.on('close', (code) => resolve({ code: code ?? -1, out }))
    })
    if (r.code !== 0) throw new ApiError(r.out.trim().split(/\r?\n/).pop()?.replace(/^Error:\s*/, '') || `helm stopped with exit code ${r.code}.`, 422)
    return `Rolled ${name} back to revision ${revision}.`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
