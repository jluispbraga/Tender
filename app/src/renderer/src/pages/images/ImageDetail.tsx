import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Layers, Play } from 'lucide-react'
import { api, type ImageDetail as Detail } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { StatusChip, Tag } from '@/components/ui/status-chip'
import { ago, bytes, fullDate, imageName, shortId } from '@/lib/format'
import { keys } from '@/lib/queries'
import { href, navigate, navigateWithQuery } from '@/lib/router'
import { RunDialog } from './RunDialog'

/** S12: what an image is made of. */
export function ImageDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: keys.image(id), queryFn: () => api.images.inspect(id), retry: false })
  const [run, setRun] = useState(false)

  if (q.isPending) return <p role="status" className="p-5 text-base text-muted">Loading image…</p>
  if (q.isError) {
    if ((q.error as { status?: number }).status === 404) {
      return <EmptyState page icon={<Layers />} title="This image is no longer on this machine" body="It was deleted or replaced." action={<Button onClick={() => navigate('images')}>Back to images</Button>} />
    }
    return <ErrorState what="this image" error={q.error} onRetry={() => void q.refetch()} />
  }

  const d: Detail = q.data
  const name = imageName(d.image.tags, d.image.id)
  const history = d.layers.map((l) => l.createdBy).join('\n')
  const contentSize = d.layers.reduce((s, l) => s + l.size, 0)

  return (
    <>
      <PageHeader
        back={
          <a href={href('images')} aria-label="Back to images" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" />
          </a>
        }
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate" title={name}>
              {name}
            </span>
            <StatusChip status={d.image.dangling ? 'dangling' : d.image.inUse ? 'in-use' : 'unused'} />
          </span>
        }
      >
        {d.image.inUse && (
          <Button onClick={() => navigateWithQuery({ q: d.image.tags[0] ?? '' }, 'containers')}>Show containers</Button>
        )}
        <Button variant="primary" icon={<Play />} onClick={() => setRun(true)}>
          Run
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <dl className="grid max-w-3xl grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-sm">
          <Row label="Image ID">
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              {shortId(d.image.id)}
              <CopyButton label="Copy full image ID" value={d.image.id} />
            </span>
          </Row>
          <Row label="Tags">{d.image.tags.length ? d.image.tags.map((t) => <span key={t} className="mr-3 font-mono text-xs">{t}</span>) : <span className="text-muted">none</span>}</Row>
          <Row label="Created">
            <span title={fullDate(d.image.createdAt)}>{ago(d.image.createdAt)}</span>
          </Row>
          <Row label="Size">{bytes(d.image.size)}</Row>
          <Row label="Platform">
            <span className="inline-flex items-center gap-2">
              linux/{d.image.arch}
              {d.image.emulated && <Tag>runs under emulation</Tag>}
            </span>
          </Row>
          <Row label="Default command">
            <span className="font-mono text-xs">{d.cmd}</span>
          </Row>
          <Row label="Exposed ports">{d.exposedPorts.length ? <span className="font-mono text-xs">{d.exposedPorts.join(', ')}</span> : <span className="text-muted">none</span>}</Row>
        </dl>

        <section aria-labelledby="layers-h" className="mt-8 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 id="layers-h" className="text-md text-fg">
              Layers
            </h2>
            <span className="text-sm text-muted">
              {d.layers.length} steps · {bytes(contentSize)}
            </span>
            <div className="flex-1" />
            <CopyButton label="Copy build history" value={history} />
          </div>
          <ol className="flex flex-col rounded-lg border border-line">
            {d.layers.map((l, i) => (
              <li key={i} className="grid grid-cols-[32px_1fr_80px] items-start gap-3 border-b border-line px-4 py-2 text-sm last:border-b-0">
                <span className="text-xs text-muted tabular-nums">{i + 1}</span>
                <code className="font-mono text-xs break-all text-fg">{l.createdBy}</code>
                <span className="text-right text-xs text-muted tabular-nums">{l.size ? bytes(l.size) : '0 B'}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="env-h" className="mt-8 flex flex-col gap-2">
          <h2 id="env-h" className="text-md text-fg">
            Environment
          </h2>
          <ul className="rounded-lg border border-line px-4 py-2 font-mono text-xs text-fg">
            {d.env.map((e) => (
              <li key={e} className="break-all">
                {e}
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-8 max-w-2xl text-sm text-muted">Vulnerability scanning isn’t built in. A local scanner such as Trivy can be added later.</p>
      </div>
      <RunDialog image={run ? d.image : null} onClose={() => setRun(false)} />
    </>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  )
}
