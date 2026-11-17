import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ExternalLink, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { api, type ImageRow, type ScanPhase, type ScanResult, type Severity } from '@/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ago, fullDate } from '@/lib/format'
import { cn } from '@/lib/cn'

// Scans live here for the session, keyed by image ID, so leaving the page
// keeps both a running scan and its last result.
type Entry = { state: 'running'; scanId: string; phase: ScanPhase | null } | { state: 'done'; result: ScanResult } | { state: 'failed'; error: string }
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const set = (id: string, e: Entry) => (entries.set(id, e), listeners.forEach((l) => l()))
const useEntry = (id: string) =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => entries.get(id),
  )

function startScan(image: ImageRow) {
  const ref = image.tags[0] ?? image.id
  const h = api.images.scan(ref, (phase) => {
    const e = entries.get(image.id)
    if (e?.state === 'running') set(image.id, { ...e, phase })
  })
  set(image.id, { state: 'running', scanId: h.scanId, phase: null })
  h.done.then(
    (result) => set(image.id, { state: 'done', result }),
    (e: Error & { status?: number }) => (e.status === 499 ? (entries.delete(image.id), listeners.forEach((l) => l())) : set(image.id, { state: 'failed', error: e.message })),
  )
}

const PHASE: Record<ScanPhase, string> = {
  scanner: 'Getting the scanner (first scan only)…',
  database: 'Updating the vulnerability database…',
  scanning: 'Scanning packages…',
}

const ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']
const TONE: Record<Severity, string> = {
  CRITICAL: 'bg-danger-solid text-on-danger',
  HIGH: 'bg-danger-bg text-danger',
  MEDIUM: 'bg-warning-bg text-warning',
  LOW: 'bg-neutral-bg text-fg',
  UNKNOWN: 'bg-neutral-bg text-muted',
}
const word = (s: Severity) => s.charAt(0) + s.slice(1).toLowerCase()

function SeverityChip({ s, count }: { s: Severity; count?: number }) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-pill px-2 text-xs font-medium', TONE[s])}>
      {word(s)}
      {count !== undefined && <span className="tabular-nums">{count}</span>}
    </span>
  )
}

/** Known vulnerabilities in an image's packages, found by Trivy on the same engine. */
export function ScanSection({ image }: { image: ImageRow }) {
  const entry = useEntry(image.id)
  const [only, setOnly] = useState<Severity | 'all'>('all')
  const [fixable, setFixable] = useState(false)
  useEffect(() => setOnly('all'), [image.id])

  const result = entry?.state === 'done' ? entry.result : null
  const shown = useMemo(() => (result?.vulnerabilities ?? []).filter((v) => (only === 'all' || v.severity === only) && (!fixable || v.fixed)), [result, only, fixable])
  const total = result?.vulnerabilities.length ?? 0

  return (
    <section aria-labelledby="vulns-h" className="mt-8 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="vulns-h" className="text-md text-fg">
          Vulnerabilities
        </h2>
        {result && (
          <span className="text-sm text-muted" title={fullDate(result.scannedAt)}>
            scanned {ago(result.scannedAt)} with {result.scanner.split('/').pop()}
          </span>
        )}
        <div className="flex-1" />
        {entry?.state === 'running' ? (
          <Button size="sm" variant="danger" onClick={() => void api.images.cancelScan(entry.scanId)}>
            Cancel scan
          </Button>
        ) : (
          <Button size="sm" icon={<ShieldAlert />} onClick={() => startScan(image)}>
            {result || entry?.state === 'failed' ? 'Scan again' : 'Scan'}
          </Button>
        )}
      </div>

      {!entry && <p className="text-sm text-muted">Check this image’s packages against known vulnerabilities. Trivy runs in a container on your engine; no account needed. The first scan downloads its database, about 60 MB.</p>}
      {entry?.state === 'running' && (
        <p role="status" className="text-sm text-muted">
          {entry.phase ? PHASE[entry.phase] : 'Starting the scanner…'}
        </p>
      )}
      {entry?.state === 'failed' && (
        <p role="alert" className="flex items-start gap-2 text-sm text-danger">
          <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0" />
          {entry.error}
        </p>
      )}
      {result && !total && (
        <p className="flex items-center gap-2 text-sm text-success">
          <ShieldCheck aria-hidden className="size-4" />
          No known vulnerabilities in this image’s packages.
        </p>
      )}
      {result && total > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by severity">
            <button type="button" aria-pressed={only === 'all'} onClick={() => setOnly('all')} className={cn('h-6 rounded-pill border px-2.5 text-xs font-medium', only === 'all' ? 'border-accent bg-selected text-fg' : 'border-line text-muted hover:bg-hover')}>
              All {total}
            </button>
            {ORDER.filter((s) => result.counts[s]).map((s) => (
              <button key={s} type="button" aria-pressed={only === s} onClick={() => setOnly(only === s ? 'all' : s)} className={cn('rounded-pill ring-offset-1 ring-offset-bg', only === s && 'ring-2 ring-accent')}>
                <SeverityChip s={s} count={result.counts[s]} />
              </button>
            ))}
            <div className="flex-1" />
            <Switch label="Only with a fix" checked={fixable} onCheckedChange={setFixable} />
          </div>
          <table aria-label={`Vulnerabilities in ${result.image}`} className="w-full table-fixed border-collapse rounded-lg border border-line text-sm">
            <thead className="bg-surface">
              <tr className="h-8 border-b border-line text-left text-xs text-muted">
                <th className="w-24 px-3 font-medium">Severity</th>
                <th className="w-40 px-3 font-medium">ID</th>
                <th className="px-3 font-medium">Package</th>
                <th className="w-36 px-3 font-medium">Installed</th>
                <th className="w-36 px-3 font-medium">Fixed in</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((v) => (
                <tr key={`${v.id}-${v.pkg}-${v.target}`} className="h-9 border-b border-line last:border-b-0">
                  <td className="px-3">
                    <SeverityChip s={v.severity} />
                  </td>
                  <td className="truncate px-3 font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => void api.images.openAdvisory(v.id, v.url)}
                      className="inline-flex max-w-full items-center gap-1 truncate text-link underline-offset-2 hover:underline"
                      title={v.title ? `${v.title} (opens in your browser)` : 'Opens in your browser'}
                    >
                      {v.id}
                      <ExternalLink aria-hidden className="size-3 shrink-0" />
                    </button>
                  </td>
                  <td className="truncate px-3" title={`${v.pkg} · ${v.target}`}>
                    <span className="font-medium">{v.pkg}</span> <span className="text-xs text-muted">{v.target}</span>
                  </td>
                  <td className="truncate px-3 font-mono text-xs text-muted">{v.installed}</td>
                  <td className="truncate px-3 font-mono text-xs">{v.fixed ?? <span className="font-sans text-muted">no fix yet</span>}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={5} className="px-3 py-3 text-sm text-muted">
                    Nothing matches these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
