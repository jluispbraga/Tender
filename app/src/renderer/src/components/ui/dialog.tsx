import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as RDialog from '@radix-ui/react-dialog'
import { AlertTriangle, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './button'

const widths = { sm: 'w-[400px]', md: 'w-[560px]', lg: 'w-[720px]' }

/**
 * Remembers what had focus when a controlled dialog opened and gives it back
 * on close. Radix only does this for its own Trigger, which these dialogs
 * don't use (they open from rows, menus and code).
 */
export function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) opener.current = document.activeElement as HTMLElement | null
  }, [open])
  return (e: Event) => {
    if (opener.current?.isConnected) {
      e.preventDefault()
      opener.current.focus()
    }
  }
}

export interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  size?: keyof typeof widths
  children?: ReactNode
  footer?: ReactNode
}

/** Focus is trapped, Escape closes, focus returns to the trigger (Radix Dialog). */
export function Modal({ open, onOpenChange, title, description, size = 'md', children, footer }: ModalProps) {
  const returnFocus = useReturnFocus(open)
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-overlay/50" />
        <RDialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-lg border border-line bg-raised shadow-modal',
            widths[size],
          )}
          onCloseAutoFocus={returnFocus}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex flex-col gap-1 py-4 pr-12 pl-5 pb-2">
            <RDialog.Title className="text-md text-fg">{title}</RDialog.Title>
            {description && <RDialog.Description className="text-base text-muted">{description}</RDialog.Description>}
          </div>
          {children && <div className="min-h-0 overflow-auto px-5 py-2">{children}</div>}
          {footer && <div className="flex justify-end gap-2 px-5 pt-2 pb-4">{footer}</div>}
          {/* Last in DOM so initial focus lands on the first field, not on Close. */}
          <RDialog.Close asChild>
            <Button variant="ghost" size="sm" iconOnly aria-label="Close" icon={<X />} className="absolute top-3 right-3" />
          </RDialog.Close>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** What will be removed, one line each. */
  items: string[]
  /** e.g. "Frees 1.2 GB". */
  impact?: string
  /** When set, the action is blocked and this explains why. */
  blockedReason?: string
  confirmLabel: string
  onConfirm: () => Promise<void> | void
  /** When set, the confirm button stays off until this exact text is typed (for production clusters). */
  typeToConfirm?: string
}

/** Destructive confirm (S18). Cancel gets initial focus, never the danger button. */
export function ConfirmDialog({ open, onOpenChange, title, items, impact, blockedReason, confirmLabel, onConfirm, typeToConfirm }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (!open) setTyped('')
  }, [open])
  const typedOk = !typeToConfirm || typed.trim() === typeToConfirm
  const returnFocus = useReturnFocus(open)
  return (
    <RDialog.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-overlay/50" />
        <RDialog.Content
          role="alertdialog"
          onCloseAutoFocus={returnFocus}
          className="fixed top-1/2 left-1/2 z-50 flex w-[400px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-raised p-5 shadow-modal"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle aria-hidden className="size-5 text-danger" />
            <RDialog.Title className="text-md text-fg">{title}</RDialog.Title>
          </div>
          <RDialog.Description asChild>
            <div className="flex flex-col gap-2 text-base text-muted">
              <ul className="max-h-40 overflow-auto rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-fg">
                {items.map((i) => (
                  <li key={i} className="truncate">
                    {i}
                  </li>
                ))}
              </ul>
              {blockedReason ? <p className="text-danger">{blockedReason}</p> : impact && <p>{impact}</p>}
              {!blockedReason && <p>This can’t be undone.</p>}
            </div>
          </RDialog.Description>
          {typeToConfirm && !blockedReason && (
            <label className="flex flex-col gap-1 text-sm text-fg">
              <span>
                Type <span className="font-mono font-medium">{typeToConfirm}</span> to confirm
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label={`Type ${typeToConfirm} to confirm`}
                spellCheck={false}
                autoComplete="off"
                className="h-8 rounded-md border border-line-strong bg-bg px-2.5 font-mono text-sm text-fg"
              />
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <RDialog.Close asChild>
              <Button autoFocus disabled={busy}>
                {blockedReason ? 'Close' : 'Cancel'}
              </Button>
            </RDialog.Close>
            {!blockedReason && (
              <Button
                variant="danger"
                loading={busy}
                disabled={!typedOk}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onConfirm()
                    onOpenChange(false)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {confirmLabel}
              </Button>
            )}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
