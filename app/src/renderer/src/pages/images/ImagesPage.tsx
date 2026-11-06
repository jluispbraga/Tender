import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { Box, Download, Eraser, Info, Layers, Play, Trash2 } from 'lucide-react'
import { api, type ImageRow } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { BulkBar, ColumnPicker, DataGrid } from '@/components/ui/data-grid'
import { ConfirmDialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { SearchField } from '@/components/ui/input'
import { ActionsMenu } from '@/components/ui/menu'
import { Select } from '@/components/ui/select'
import { StatusChip, Tag } from '@/components/ui/status-chip'
import { useToast } from '@/components/ui/toast'
import { ago, bytes, fullDate, imageName, shortId } from '@/lib/format'
import { keys, useImages } from '@/lib/queries'
import { navigate, navigateWithQuery } from '@/lib/router'
import { CleanupDialog } from './CleanupDialog'
import { PullDialog } from './PullDialog'
import { RunDialog } from './RunDialog'

type Filter = 'all' | 'in-use' | 'unused' | 'dangling'
const optionalColumns = [
  { id: 'id', label: 'Image ID' },
  { id: 'created', label: 'Created' },
  { id: 'size', label: 'Size' },
]

/** S11: local images. */
export function ImagesPage() {
  const images = useImages()
  const qc = useQueryClient()
  const toast = useToast()
  const usage = useQuery({ queryKey: keys.diskUsage, queryFn: api.images.diskUsage, staleTime: 0 })
  const prefs = useQuery({ queryKey: keys.grid('images'), queryFn: () => api.grid.get('images') })
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sel, setSel] = useState<RowSelectionState>({})
  const [runImage, setRunImage] = useState<ImageRow | null>(null)
  const [pull, setPull] = useState<{ open: boolean; ref: string }>({ open: false, ref: '' })
  const [cleanup, setCleanup] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ImageRow[] | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const visibility: VisibilityState = useMemo(() => Object.fromEntries(optionalColumns.map((c) => [c.id, !(prefs.data?.hidden ?? []).includes(c.id)])), [prefs.data])
  const setVisibility = (v: VisibilityState) => void api.grid.set('images', { hidden: Object.entries(v).filter(([, on]) => !on).map(([k]) => k) }).then(() => prefs.refetch())

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (images.data ?? []).filter(
      (i) =>
        (filter === 'all' || (filter === 'in-use' && i.inUse) || (filter === 'unused' && !i.inUse && !i.dangling) || (filter === 'dangling' && i.dangling)) &&
        (!needle || i.tags.some((t) => t.toLowerCase().includes(needle)) || i.id.includes(needle)),
    )
  }, [images.data, q, filter])

  useEffect(() => {
    const ids = new Set(shown.map((i) => i.id))
    setSel((s) => Object.fromEntries(Object.entries(s).filter(([id]) => ids.has(id))))
  }, [shown])

  const selected = (images.data ?? []).filter((i) => sel[i.id])
  const shared = usage.data?.sharedSize ?? {}
  const reclaim = selected.filter((i) => !i.inUse).reduce((s, i) => s + i.size - (shared[i.id] ?? 0), 0)

  const columns: ColumnDef<ImageRow, any>[] = useMemo(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorFn: (i) => imageName(i.tags, i.id),
        cell: ({ row, getValue }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={row.original.dangling ? 'truncate text-muted italic' : 'truncate font-medium'} title={row.original.tags.join(', ')}>
              {getValue()}
            </span>
            {row.original.tags.length > 1 && <span className="text-xs text-muted">+{row.original.tags.length - 1} tag</span>}
            {row.original.emulated && <Tag>{row.original.arch}</Tag>}
            {row.original.tags[0] && <CopyButton label={`Copy ${row.original.tags[0]}`} value={row.original.tags[0]} className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />}
          </span>
        ),
      },
      { id: 'status', header: 'Status', size: 120, accessorFn: (i) => (i.dangling ? 2 : i.inUse ? 0 : 1), cell: ({ row }) => <StatusChip status={row.original.dangling ? 'dangling' : row.original.inUse ? 'in-use' : 'unused'} /> },
      { id: 'id', header: 'Image ID', size: 130, accessorKey: 'id', cell: ({ getValue }) => <span className="font-mono text-xs text-muted">{shortId(getValue())}</span> },
      { id: 'created', header: 'Created', size: 120, accessorKey: 'createdAt', cell: ({ getValue }) => <span className="text-muted" title={fullDate(getValue())}>{ago(getValue())}</span> },
      { id: 'size', header: 'Size', size: 96, accessorKey: 'size', cell: ({ getValue }) => <span className="text-muted tabular-nums">{bytes(getValue())}</span> },
    ],
    [],
  )

  const doDelete = async (rows: ImageRow[]) => {
    const ids = rows.map((r) => r.id)
    setBusy((b) => new Set([...b, ...ids]))
    try {
      const results = await api.images.remove(ids)
      const failed = results.filter((r) => !r.ok)
      const ok = results.length - failed.length
      if (ok) toast({ kind: 'success', title: `Deleted ${ok} image${ok === 1 ? '' : 's'}` })
      if (failed.length) toast({ kind: 'error', title: `Kept ${failed.length} image${failed.length === 1 ? '' : 's'}`, body: failed.map((f) => f.error).join(' ') })
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t delete images', body: (e as Error).message })
    } finally {
      setBusy((b) => new Set([...b].filter((id) => !ids.includes(id))))
      void qc.invalidateQueries({ queryKey: keys.images })
      void qc.invalidateQueries({ queryKey: keys.diskUsage })
    }
  }

  const total = images.data?.length ?? 0
  const allInUse = pendingDelete?.every((i) => i.inUse)

  return (
    <>
      <PageHeader title="Images">
        <span className="text-sm text-muted" aria-live="polite">
          {usage.data ? `${total} images · ${bytes(usage.data.imagesTotal)} on disk · ${bytes(usage.data.imagesReclaimable)} reclaimable` : `${total} images`}
        </span>
        <Button icon={<Eraser />} onClick={() => setCleanup(true)}>
          Clean up
        </Button>
        <Button variant="primary" icon={<Download />} onClick={() => setPull({ open: true, ref: '' })}>
          Pull
        </Button>
      </PageHeader>

      <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-2">
        <SearchField label="Search images" placeholder="Search by name, tag or ID" value={q} onChange={setQ} />
        <Select
          label="Show"
          value={filter}
          onValueChange={(v) => setFilter(v as Filter)}
          className="w-36"
          options={[
            { value: 'all', label: 'All images' },
            { value: 'in-use', label: 'In use' },
            { value: 'unused', label: 'Unused' },
            { value: 'dangling', label: 'Untagged' },
          ]}
        />
        <div className="flex-1" />
        <ColumnPicker columns={optionalColumns} visibility={visibility} onChange={setVisibility} />
      </div>

      <BulkBar count={selected.length} noun="image" note={reclaim ? `frees about ${bytes(reclaim)}` : selected.length ? 'all in use' : undefined} onClear={() => setSel({})}>
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setPendingDelete(selected)}>
          Delete
        </Button>
      </BulkBar>

      <div className="min-h-0 flex-1 overflow-auto">
        {images.isError ? (
          <ErrorState what="images" error={images.error} onRetry={() => void images.refetch()} />
        ) : (
          <DataGrid
            label="Images"
            loading={images.isPending}
            columns={columns}
            data={shown}
            getRowId={(i) => i.id}
            getRowLabel={(i) => imageName(i.tags, i.id)}
            rowSelection={sel}
            onRowSelectionChange={setSel}
            columnVisibility={visibility}
            onColumnVisibilityChange={setVisibility}
            isRowBusy={(i) => busy.has(i.id)}
            onRowOpen={(i) => navigate('images', i.id)}
            rowActions={(i) => (
              <>
                <Button variant="ghost" size="sm" iconOnly aria-label={`Run ${imageName(i.tags, i.id)}`} icon={<Play />} onClick={(e) => (e.stopPropagation(), setRunImage(i))} />
                <ActionsMenu
                  label={`Actions for ${imageName(i.tags, i.id)}`}
                  entries={[
                    { label: 'Run…', icon: <Play />, onSelect: () => setRunImage(i) },
                    { label: 'Inspect', icon: <Info />, onSelect: () => navigate('images', i.id) },
                    { label: 'Pull latest version', icon: <Download />, disabled: !i.tags[0], disabledReason: 'Untagged images can’t be pulled', onSelect: () => setPull({ open: true, ref: i.tags[0] }) },
                    { label: 'Show containers using it', icon: <Box />, disabled: !i.inUse, disabledReason: 'No container uses this image', onSelect: () => navigateWithQuery({ q: i.tags[0] ?? '' }, 'containers') },
                    { kind: 'separator' },
                    { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete([i]) },
                  ]}
                />
              </>
            )}
            empty={
              total ? (
                <EmptyState icon={<Layers />} title="No images match" body="Try another name, or show all images." action={<Button onClick={() => (setQ(''), setFilter('all'))}>Show all images</Button>} />
              ) : (
                <EmptyState
                  icon={<Layers />}
                  title="No images on this machine"
                  body="Pull one from a registry to get started. Images you build from the command line show up here too."
                  action={
                    <Button variant="primary" icon={<Download />} onClick={() => setPull({ open: true, ref: '' })}>
                      Pull an image
                    </Button>
                  }
                />
              )
            }
          />
        )}
      </div>

      <RunDialog image={runImage} onClose={() => setRunImage(null)} />
      <PullDialog open={pull.open} initial={pull.ref} onClose={() => setPull({ open: false, ref: '' })} />
      <CleanupDialog open={cleanup} onClose={() => setCleanup(false)} images={images.data ?? []} />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={pendingDelete?.length === 1 ? `Delete ${imageName(pendingDelete[0].tags, pendingDelete[0].id)}?` : `Delete ${pendingDelete?.length ?? 0} images?`}
        items={pendingDelete?.map((i) => imageName(i.tags, i.id)) ?? []}
        blockedReason={allInUse ? `${pendingDelete!.length === 1 ? 'This image is' : 'These images are'} used by containers. Remove those containers first.` : undefined}
        impact={pendingDelete?.some((i) => i.inUse) ? 'Images still used by a container are kept.' : `Frees about ${bytes((pendingDelete ?? []).reduce((s, i) => s + i.size - (shared[i.id] ?? 0), 0))}.`}
        confirmLabel={pendingDelete?.length === 1 ? 'Delete image' : 'Delete images'}
        onConfirm={() => doDelete(pendingDelete ?? [])}
      />
    </>
  )
}
