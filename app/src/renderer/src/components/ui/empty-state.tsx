import type { ReactNode } from 'react'

/** Every list has one. The icon is decorative; the heading carries meaning. */
export function EmptyState({ icon, title, body, action, page }: { icon: ReactNode; title: string; body?: string; action?: ReactNode; page?: boolean }) {
  // `page`: the state replaces the whole page, so its heading is the page's h1.
  const Heading = page ? 'h1' : 'h3'
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div aria-hidden className="grid size-12 place-items-center rounded-lg bg-surface text-muted [&>svg]:size-6">
        {icon}
      </div>
      <Heading className="text-md text-fg">{title}</Heading>
      {body && <p className="max-w-sm text-base text-muted">{body}</p>}
      {action}
    </div>
  )
}
