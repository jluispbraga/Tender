import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import * as RToast from '@radix-ui/react-toast'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

type Kind = 'info' | 'success' | 'error'
interface ToastData {
  id: number
  kind: Kind
  title: string
  body?: string
}

const ToastContext = createContext<(t: Omit<ToastData, 'id'>) => void>(() => {})
export const useToast = () => useContext(ToastContext)

const icons = {
  info: <Info aria-hidden className="size-4 text-link" />,
  success: <CheckCircle2 aria-hidden className="size-4 text-success" />,
  error: <XCircle aria-hidden className="size-4 text-danger" />,
}

/**
 * Bottom-right stack. Info/success auto-dismiss after 4 s; errors stay until
 * closed and are announced assertively (Radix `type="foreground"`).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([])
  const push = useCallback((t: Omit<ToastData, 'id'>) => setToasts((all) => [...all, { ...t, id: Date.now() + Math.random() }]), [])
  return (
    <ToastContext.Provider value={push}>
      <RToast.Provider swipeDirection="right" label="Notification">
        {children}
        {toasts.map((t) => (
          <RToast.Root
            key={t.id}
            type={t.kind === 'error' ? 'foreground' : 'background'}
            duration={t.kind === 'error' ? Infinity : 4000}
            onOpenChange={(open) => !open && setToasts((all) => all.filter((x) => x.id !== t.id))}
            className={cn('flex w-80 items-start gap-2.5 rounded-md border border-line bg-raised p-3 shadow-pop')}
          >
            <span className="pt-0.5">{icons[t.kind]}</span>
            <div className="flex flex-1 flex-col gap-0.5">
              <RToast.Title className="text-sm font-semibold text-fg">{t.title}</RToast.Title>
              {t.body && <RToast.Description className="text-sm text-muted">{t.body}</RToast.Description>}
            </div>
            <RToast.Close aria-label="Dismiss" className="grid size-5 place-items-center rounded-sm text-muted hover:bg-hover hover:text-fg">
              <X aria-hidden className="size-3.5" />
            </RToast.Close>
          </RToast.Root>
        ))}
        <RToast.Viewport className="fixed right-4 bottom-10 z-50 flex flex-col gap-2 outline-none" />
      </RToast.Provider>
    </ToastContext.Provider>
  )
}
