import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCircle2, Info, XCircle } from 'lucide-react'
import { api } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ago, fullDate } from '@/lib/format'
import { keys, useNotifications } from '@/lib/queries'
import { cn } from '@/lib/cn'

const icons = {
  info: <Info aria-hidden className="size-4 text-link" />,
  success: <CheckCircle2 aria-hidden className="size-4 text-success" />,
  error: <XCircle aria-hidden className="size-4 text-danger" />,
}
const kindLabel = { info: 'Info', success: 'Done', error: 'Problem' }

/** S24: what happened in the background. Opening the page marks everything read after a moment. */
export function NotificationsPage() {
  const notifications = useNotifications()
  const qc = useQueryClient()
  const list = notifications.data ?? []
  const unread = list.filter((n) => !n.readAt).map((n) => n.id)

  useEffect(() => {
    if (!unread.length) return
    const t = setTimeout(() => void api.notifications.markRead(unread).then(() => qc.invalidateQueries({ queryKey: keys.notifications })), 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread.join(',')])

  return (
    <>
      <PageHeader title="Notifications">
        {unread.length > 0 && (
          <Button size="sm" onClick={() => void api.notifications.markRead(unread).then(() => qc.invalidateQueries({ queryKey: keys.notifications }))}>
            Mark all as read
          </Button>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {notifications.isPending ? (
          <p role="status" className="p-5 text-base text-muted">
            Loading…
          </p>
        ) : !list.length ? (
          <EmptyState icon={<Bell />} title="Nothing to report" body="Finished pulls and containers that stop with an error show up here." />
        ) : (
          <ul aria-label="Notifications" className="flex flex-col">
            {list.map((n) => (
              <li key={n.id} className={cn('flex items-start gap-3 border-b border-line px-5 py-3', !n.readAt && 'bg-selected')}>
                <span className="pt-0.5">{icons[n.kind]}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-base text-fg">
                    <span className="sr-only">{kindLabel[n.kind]}: </span>
                    {n.title}
                    {!n.readAt && <span className="ml-2 text-xs font-medium text-link">New</span>}
                  </p>
                  {n.body && <p className="text-sm text-muted">{n.body}</p>}
                </div>
                <time dateTime={n.createdAt} title={fullDate(n.createdAt)} className="shrink-0 text-sm text-muted">
                  {ago(n.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
