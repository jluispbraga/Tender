import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Database } from 'lucide-react'
import { api } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { StatusChip } from '@/components/ui/status-chip'
import { Tabs } from '@/components/ui/tabs'
import { ago, bytes, fullDate } from '@/lib/format'
import { keys, useVolumes } from '@/lib/queries'
import { href, navigate } from '@/lib/router'

/** S16: one volume and the containers that mount it. */
export function VolumeDetail({ name, tab }: { name: string; tab: string }) {
  const volumes = useVolumes()
  const v = volumes.data?.find((x) => x.name === name)

  if (volumes.isError) return <ErrorState what="this volume" error={volumes.error} onRetry={() => void volumes.refetch()} />
  if (volumes.isPending) return <p role="status" className="p-5 text-base text-muted">Loading volume…</p>
  if (!v) return <EmptyState page icon={<Database />} title="This volume no longer exists" body="It was deleted, maybe from the command line." action={<Button onClick={() => navigate('volumes')}>Back to volumes</Button>} />

  return (
    <>
      <PageHeader
        back={
          <a href={href('volumes')} aria-label="Back to volumes" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" />
          </a>
        }
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">{v.name}</span>
            <StatusChip status={v.usedBy.length ? 'in-use' : 'unused'} />
          </span>
        }
      />
      <dl className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-b border-line px-5 py-2 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted">Driver</dt>
          <dd>{v.driver}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">Size</dt>
          <dd>{bytes(v.size)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">Created</dt>
          <dd title={fullDate(v.createdAt)}>{ago(v.createdAt)}</dd>
        </div>
      </dl>
      <Tabs
        label="Volume details"
        value={tab}
        onValueChange={(t) => navigate('volumes', v.name, t)}
        items={[
          { value: 'containers', label: 'Used by', content: <UsedBy name={v.name} /> },
          { value: 'data', label: 'Stored data', disabled: true, disabledReason: 'Browsing the files in a volume is planned for a later milestone', content: null },
        ]}
      />
    </>
  )
}

function UsedBy({ name }: { name: string }) {
  const q = useQuery({ queryKey: keys.volumeUsage(name), queryFn: () => api.volumes.usage(name), staleTime: 0 })
  if (q.isError) return <ErrorState what="containers using this volume" error={q.error} onRetry={() => void q.refetch()} />
  if (q.isPending) return <p role="status" className="p-5 text-base text-muted">Loading…</p>
  if (!q.data.length) return <p className="p-5 text-base text-muted">No container mounts this volume. It can be deleted safely, though its data goes with it.</p>
  return (
    <table aria-label={`Containers using ${name}`} className="w-full table-fixed border-collapse text-sm">
      <thead className="bg-surface">
        <tr className="h-8 border-b border-line text-left text-xs text-muted">
          <th className="px-5 font-medium">Container</th>
          <th className="px-3 font-medium">Image</th>
          <th className="px-3 font-medium">Mounted at</th>
          <th className="w-40 px-3 font-medium">Ports</th>
        </tr>
      </thead>
      <tbody>
        {q.data.map((u) => (
          <tr key={u.containerId} className="h-9 border-b border-line">
            <td className="truncate px-5">
              <a href={href('containers', u.containerId, 'mounts')} className="font-medium text-fg underline-offset-2 hover:underline">
                {u.containerName}
              </a>
            </td>
            <td className="truncate px-3 font-mono text-xs text-muted">{u.image}</td>
            <td className="truncate px-3 font-mono text-xs">{u.target}</td>
            <td className="px-3 text-muted">{u.ports || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
