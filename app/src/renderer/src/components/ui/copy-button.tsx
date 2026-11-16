import { useEffect, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Copies `value`; announces "Copied" politely for screen readers. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState<boolean | 'failed'>(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
        } catch {
          setCopied('failed')
        }
      }}
      className={cn('grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-fg', className)}
    >
      {copied === true ? <Check aria-hidden className="size-3.5 text-success" /> : copied === 'failed' ? <X aria-hidden className="size-3.5 text-danger" /> : <Copy aria-hidden className="size-3.5" />}
      <span role="status" className="sr-only">
        {copied === true ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : ''}
      </span>
    </button>
  )
}
