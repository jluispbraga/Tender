import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, ChevronUp, Clock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './button'
import { CopyButton } from './copy-button'
import { SearchField } from './input'

export interface LogLine {
  ts: string
  stream: 'stdout' | 'stderr'
  text: string
  source?: string
}

/**
 * Log viewer (S04, S10). Always dark (term-* tokens) in both themes.
 * Follows the tail until the user scrolls up, then shows "Jump to latest".
 * Search highlights matches; Enter / Shift+Enter step through them.
 * Real data will be virtualised in replica-build; this primitive renders the
 * buffer it is given.
 */
export function LogViewer({ lines, label }: { lines: LogLine[]; label: string }) {
  const [query, setQuery] = useState('')
  const [showTs, setShowTs] = useState(false)
  const [follow, setFollow] = useState(true)
  const [hit, setHit] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  // Set while we scroll to the bottom ourselves, so that scroll event isn't read as the user leaving the tail.
  const autoScrolling = useRef(false)

  const matches = useMemo(() => {
    if (!query) return []
    const q = query.toLowerCase()
    return lines.flatMap((l, i) => (l.text.toLowerCase().includes(q) ? [i] : []))
  }, [lines, query])

  useEffect(() => setHit(0), [query])
  useLayoutEffect(() => {
    const el = scroller.current
    if (!follow || !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return
    autoScrolling.current = true
    el.scrollTop = el.scrollHeight
  }, [lines, follow])
  useEffect(() => {
    if (!matches.length) return
    scroller.current?.querySelector(`[data-line="${matches[hit]}"]`)?.scrollIntoView({ block: 'center' })
  }, [hit, matches])

  const step = (d: number) => matches.length && setHit((h) => (h + d + matches.length) % matches.length)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <SearchField
          label="Search logs"
          placeholder="Search logs"
          value={query}
          onChange={setQuery}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            }
          }}
        />
        <span role="status" className="min-w-20 text-xs text-muted tabular-nums">
          {query ? (matches.length ? `${hit + 1} of ${matches.length}` : 'No matches') : ''}
        </span>
        <Button variant="ghost" size="sm" iconOnly aria-label="Previous match" icon={<ChevronUp />} disabled={!matches.length} onClick={() => step(-1)} />
        <Button variant="ghost" size="sm" iconOnly aria-label="Next match" icon={<ChevronDown />} disabled={!matches.length} onClick={() => step(1)} />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" icon={<Clock />} aria-pressed={showTs} onClick={() => setShowTs((v) => !v)} className={cn(showTs && 'bg-selected')}>
          Timestamps
        </Button>
        <CopyButton label="Copy all logs" value={lines.map((l) => l.text).join('\n')} />
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          role="log"
          aria-label={label}
          tabIndex={0}
          onScroll={(e) => {
            if (autoScrolling.current) {
              autoScrolling.current = false
              return
            }
            const el = e.currentTarget
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 8)
          }}
          className="h-full overflow-auto bg-term-bg px-4 py-2 font-mono text-mono text-term-text"
        >
          {lines.map((l, i) => (
            <div key={i} data-line={i} className={cn('flex gap-3 whitespace-pre-wrap', matches[hit] === i && 'bg-[color-mix(in_srgb,var(--ds-accent)_35%,transparent)]')}>
              {showTs && <span className="shrink-0 text-term-muted">{l.ts}</span>}
              {l.source && <span className="w-16 shrink-0 truncate text-term-muted">{l.source}</span>}
              <span className={l.stream === 'stderr' ? 'text-term-stderr' : undefined}>{highlight(l.text, query)}</span>
            </div>
          ))}
        </div>
        {!follow && (
          <Button variant="primary" size="sm" icon={<ArrowDown />} className="absolute right-4 bottom-3 shadow-pop" onClick={() => setFollow(true)}>
            Jump to latest
          </Button>
        )}
      </div>
    </div>
  )
}

function highlight(text: string, q: string) {
  if (!q) return text
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'))
  return parts.map((p, i) =>
    p.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className="rounded-sm bg-term-match px-0.5 text-term-bg">
        {p}
      </mark>
    ) : (
      p
    ),
  )
}
