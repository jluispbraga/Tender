import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './button'
import { fieldClass } from './input'

export interface KvRow {
  key: string
  value: string
  error?: string
}

/**
 * Repeating two-field rows for ports, volumes and env vars in the Run dialog
 * (S13). Each input is labelled "<keyLabel> <n>" so rows stay distinguishable
 * to screen readers.
 */
export function KvEditor({
  legend,
  keyLabel,
  valueLabel,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  onChange,
  addLabel,
}: {
  legend: string
  keyLabel: string
  valueLabel: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
  addLabel: string
}) {
  const baseId = useId()
  const set = (i: number, patch: Partial<KvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch, error: undefined } : r)))
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              aria-label={`${keyLabel} ${i + 1}`}
              aria-invalid={r.error ? true : undefined}
              aria-describedby={r.error ? `${baseId}-${i}-error` : undefined}
              placeholder={keyPlaceholder}
              value={r.key}
              onChange={(e) => set(i, { key: e.target.value })}
              className={cn(fieldClass, 'font-mono text-sm')}
            />
            <span aria-hidden className="text-muted">
              →
            </span>
            <input
              aria-label={`${valueLabel} ${i + 1}`}
              placeholder={valuePlaceholder}
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
              className={cn(fieldClass, 'font-mono text-sm')}
            />
            <Button
              variant="ghost"
              iconOnly
              aria-label={`Remove ${keyLabel.toLowerCase()} ${i + 1}`}
              icon={<Trash2 />}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            />
          </div>
          {r.error && (
            <p id={`${baseId}-${i}-error`} className="text-sm text-danger">
              {r.error}
            </p>
          )}
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus />} className="self-start" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        {addLabel}
      </Button>
    </fieldset>
  )
}
