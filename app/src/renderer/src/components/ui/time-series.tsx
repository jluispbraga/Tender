import { useEffect, useRef } from 'react'
import uPlot from 'uplot'

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--ds-${name}`).trim()

export interface Series {
  label: string
  /** token role for the line colour, e.g. "accent" or "success" */
  color: string
  values: number[]
}

/**
 * Live line chart (S08). Decorative for assistive tech: the caller shows the
 * latest values as text next to it. Colours come from tokens, read at draw
 * time so a theme switch recolours it on the next sample.
 */
export function TimeSeries({ times, series, format, height = 140 }: { times: number[]; series: Series[]; format: (v: number) => string; height?: number }) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)

  useEffect(() => {
    if (!host.current) return
    const axis = { stroke: css('text-muted'), grid: { stroke: css('border'), width: 1 }, ticks: { show: false }, font: `11px ${css('font-sans')}` }
    const opts: uPlot.Options = {
      width: host.current.clientWidth,
      height,
      legend: { show: false },
      cursor: { show: false },
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(max * 1.2, 1e-9)] } },
      axes: [{ ...axis, values: (_u, ticks) => ticks.map((t) => new Date(t * 1000).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })) }, { ...axis, size: 64, values: (_u, ticks) => ticks.map(format) }],
      series: [{}, ...series.map((s) => ({ label: s.label, stroke: css(s.color), width: 1.5, points: { show: false } }))],
    }
    plot.current = new uPlot(opts, [times.map((t) => t / 1000), ...series.map((s) => s.values)], host.current)
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: host.current!.clientWidth, height }))
    ro.observe(host.current)
    return () => {
      ro.disconnect()
      plot.current?.destroy()
      plot.current = null
    }
    // Rebuild only when the shape changes; data updates go through setData below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.length, height])

  useEffect(() => {
    plot.current?.setData([times.map((t) => t / 1000), ...series.map((s) => s.values)])
  }, [times, series])

  return (
    <div className="flex flex-col gap-1">
      <div ref={host} aria-hidden className="w-full" />
      {series.length > 1 && (
        <ul aria-hidden className="flex gap-4 text-xs text-muted">
          {series.map((s) => (
            <li key={s.label} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-pill" style={{ background: `var(--ds-${s.color})` }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
