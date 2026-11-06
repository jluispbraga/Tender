import { useMemo, type ReactNode } from 'react'
import type { ContainerRow, StatsSample } from '@/api'
import { TimeSeries } from '@/components/ui/time-series'
import { bytes } from '@/lib/format'
import { useStats } from '@/lib/queries'

/** S08: CPU, memory, network and disk over the last five minutes, while the tab is open. */
export function StatsTab({ c }: { c: ContainerRow }) {
  const ids = useMemo(() => (c.state === 'running' ? [c.id] : []), [c.id, c.state])
  const samples = useStats(ids, 300)[c.id] ?? []

  if (c.state !== 'running') {
    return <p className="p-5 text-base text-muted">Usage is only collected while the container runs. Start it to see live numbers.</p>
  }
  if (samples.length < 2) {
    return <p role="status" className="p-5 text-base text-muted">Collecting the first samples…</p>
  }

  const last = samples.at(-1)!
  const times = samples.map((s) => s.at)
  // Network and disk counters are cumulative; chart them as per-second rates.
  const rate = (pick: (s: StatsSample) => number) => samples.map((s, i) => (i ? Math.max(0, pick(s) - pick(samples[i - 1])) / ((s.at - samples[i - 1].at) / 1000) : 0))

  return (
    <div className="grid h-full auto-rows-min grid-cols-2 gap-4 overflow-auto p-5">
      <Panel title="CPU" value={`${last.cpuPercent.toFixed(1)}%`} detail="100% = one full core">
        <TimeSeries times={times} format={(v) => `${v.toFixed(0)}%`} series={[{ label: 'CPU', color: 'accent', values: samples.map((s) => s.cpuPercent) }]} />
      </Panel>
      <Panel title="Memory" value={bytes(last.memUsage)} detail={`of ${bytes(last.memLimit)} limit`}>
        <TimeSeries times={times} format={bytes} series={[{ label: 'Memory', color: 'accent', values: samples.map((s) => s.memUsage) }]} />
      </Panel>
      <Panel title="Network" value={`↓ ${bytes(rate((s) => s.netRx).at(-1)!)}/s  ↑ ${bytes(rate((s) => s.netTx).at(-1)!)}/s`} detail={`${bytes(last.netRx)} in, ${bytes(last.netTx)} out in total`}>
        <TimeSeries
          times={times}
          format={(v) => `${bytes(v)}/s`}
          series={[
            { label: 'Received', color: 'accent', values: rate((s) => s.netRx) },
            { label: 'Sent', color: 'success', values: rate((s) => s.netTx) },
          ]}
        />
      </Panel>
      <Panel title="Disk" value={`R ${bytes(rate((s) => s.blkRead).at(-1)!)}/s  W ${bytes(rate((s) => s.blkWrite).at(-1)!)}/s`} detail={`${last.pids} processes`}>
        <TimeSeries
          times={times}
          format={(v) => `${bytes(v)}/s`}
          series={[
            { label: 'Read', color: 'accent', values: rate((s) => s.blkRead) },
            { label: 'Write', color: 'warning', values: rate((s) => s.blkWrite) },
          ]}
        />
      </Panel>
    </div>
  )
}

function Panel({ title, value, detail, children }: { title: string; value: string; detail: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-muted">{title}</h2>
        <span className="text-xs text-muted">{detail}</span>
      </div>
      <p className="text-lg text-fg tabular-nums">{value}</p>
      {children}
    </section>
  )
}
