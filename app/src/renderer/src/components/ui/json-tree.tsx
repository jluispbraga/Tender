import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Read-only JSON tree (S05, S12). Objects and arrays are buttons with
 * aria-expanded; the first two levels start open. A lighter stand-in for the
 * CodeMirror inspector in components.md, which can replace it later.
 */
export function JsonTree({ value, label }: { value: unknown; label: string }) {
  return (
    <ul role="tree" aria-label={label} className="font-mono text-mono">
      <Node name={null} value={value} depth={0} />
    </ul>
  )
}

function Node({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const isObj = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < 2)
  const entries = isObj ? Object.entries(value as Record<string, unknown>) : []
  const isArr = Array.isArray(value)
  const keyEl = name !== null && <span className="text-muted">{name}: </span>

  if (!isObj) {
    return (
      <li role="treeitem" className="py-px pl-5 whitespace-pre-wrap">
        {keyEl}
        <Scalar v={value} />
      </li>
    )
  }
  if (!entries.length) {
    return (
      <li role="treeitem" className="py-px pl-5">
        {keyEl}
        <span className="text-muted">{isArr ? '[]' : '{}'}</span>
      </li>
    )
  }
  return (
    <li role="treeitem" aria-expanded={open}>
      <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 rounded-sm py-px text-left hover:bg-hover">
        <ChevronRight aria-hidden className={cn('size-3.5 text-muted transition-transform duration-100', open && 'rotate-90')} />
        {name !== null ? <span className="text-fg">{name}</span> : <span className="text-muted">root</span>}
        <span className="text-muted">{isArr ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && (
        <ul role="group" className="ml-1.5 border-l border-line pl-2">
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

function Scalar({ v }: { v: unknown }) {
  if (typeof v === 'string') return <span className="text-success">"{v}"</span>
  if (typeof v === 'number') return <span className="text-link">{v}</span>
  if (typeof v === 'boolean') return <span className="text-warning">{String(v)}</span>
  return <span className="text-muted">{String(v)}</span>
}
