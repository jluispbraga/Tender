import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { Database, Info, Plus, Trash2 } from 'lucide-react'
import { api, type VolumeRow } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { BulkBar, DataGrid } from '@/components/ui/data-grid'
import { ConfirmDialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { SearchField } from '@/components/ui/input'
import { ActionsMenu } from '@/components/ui/menu'
import { Select } from '@/components/ui/select'
import { StatusChip } from '@/components/ui/status-chip'
import { useToast } from '@/components/ui/toast'
import { ago, bytes, fullDate } from '@/lib/format'
import { keys, useVolumes } from '@/lib/queries'
import { navigate } from '@/lib/router'
import { CreateVolumeDialog } from './CreateVolumeDialog'

/** S15: named volumes. */
export function VolumesPage() {
  const volumes = useVolumes()
  const qc = useQueryClient()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'in-use' | 'unused'>('all')
  const [sel, setSel] = useState<RowSelectionState>({})
  const [create, setCreate] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<VolumeRow[] | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (volumes.data ?? []).filter((v) => (filter === 'all' || (filter === 'in-use') === v.usedBy.length > 0) && (!needle || v.name.toLowerCase().includes(needle)))
  }, [volumes.data, q, filter])

  useEffect(() => {
    const names = new Set(shown.map((v) => v.name))
    setSel((s) => Object.fromEntries(Object.entries(s).filter(([n]) => names.has(n))))
  }, [shown])

  const columns: ColumnDef<VolumeRow, any>[] = useMemo(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Name',
        cell: ({ getValue }) => (
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-medium" title={getValue()}>
              {getValue()}
            </span>
            <CopyButton label={`Copy ${getValue()}`} value={getValue()} className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        size: 200,
        accessorFn: (v) => v.usedBy.length,
        cell: ({ row }) =>
          row.original.usedBy.length ? (
            <span className="flex min-w-0 items-center gap-2">
              <StatusChip status="in-use" />
              <span className="truncate text-xs text-muted" title={row.original.usedBy.join(', ')}>
                {row.original.usedBy.join(', ')}
              </span>
            </span>
          ) : (
            <StatusChip status="unused" />
          ),
      },
      { id: 'created', accessorKey: 'createdAt', header: 'Created', size: 120, cell: ({ getValue }) => <span className="text-muted" title={fullDate(getValue())}>{ago(getValue())}</span> },
      { id: 'size', accessorKey: 'size', header: 'Size', size: 96, cell: ({ getValue }) => <span className="text-muted tabular-nums">{bytes(getValue())}</span> },
    ],
    [],
  )

  const doDelete = async (rows: VolumeRow[]) => {
    const names = rows.map((r) => r.name)
    setBusy((b) => new Set([...b, ...names]))
    try {
      const results = await api.volumes.remove(names)
      const ok = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)
      if (ok.length) toast({ kind: 'success', title: ok.length === 1 ? `Deleted ${ok[0].id}` : `Deleted ${ok.length} volumes` })
      if (failed.length) toast({ kind: 'error', title: `Kept ${failed.length} volume${failed.length === 1 ? '' : 's'} in use`, body: failed.map((f) => `${f.id}: ${f.error}`).join(' ') })
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t delete volumes', body: (e as Error).message })
    } finally {
      setBusy((b) => new Set([...b].filter((n) => !names.includes(n))))
      void qc.invalidateQueries({ queryKey: keys.volumes })
    }
  }

  const selected = (volumes.data ?? []).filter((v) => sel[v.name])
  const inUse = pendingDelete?.filter((v) => v.usedBy.length) ?? []
  const total = volumes.data?.length ?? 0

  return (
    <>
      <PageHeader title="Volumes">
        <span className="text-sm text-muted">{volumes.data ? `${total} volumes · ${bytes(volumes.data.reduce((s, v) => s + v.size, 0))}` : ''}</span>
        <Button variant="primary" icon={<Plus />} onClick={() => setCreate(true)}>
          Create
        </Button>
      </PageHeader>
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-2">
        <SearchField label="Search volumes" placeholder="Search by name" value={q} onChange={setQ} />
        <Select
          label="Show"
          value={filter}
          onValueChange={(v) => setFilter(v as typeof filter)}
          className="w-36"
          options={[
            { value: 'all', label: 'All volumes' },
            { value: 'in-use', label: 'In use' },
            { value: 'unused', label: 'Unused' },
          ]}
        />
      </div>
      <BulkBar count={selected.length} noun="volume" note={selected.some((v) => v.usedBy.length) ? 'volumes in use will be kept' : undefined} onClear={() => setSel({})}>
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setPendingDelete(selected)}>
          Delete
        </Button>
      </BulkBar>
      <div className="min-h-0 flex-1 overflow-auto">
        {volumes.isError ? (
          <ErrorState what="volumes" error={volumes.error} onRetry={() => void volumes.refetch()} />
        ) : (
          <DataGrid
            label="Volumes"
            loading={volumes.isPending}
            columns={columns}
            data={shown}
            getRowId={(v) => v.name}
            getRowLabel={(v) => v.name}
            rowSelection={sel}
            onRowSelectionChange={setSel}
            columnVisibility={{}}
            onColumnVisibilityChange={() => {}}
            isRowBusy={(v) => busy.has(v.name)}
            onRowOpen={(v) => navigate('volumes', v.name, 'containers')}
            rowActions={(v) => (
              <ActionsMenu
                label={`Actions for ${v.name}`}
                entries={[
                  { label: 'Details', icon: <Info />, onSelect: () => navigate('volumes', v.name, 'containers') },
                  { kind: 'separator' },
                  { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete([v]) },
                ]}
              />
            )}
            empty={
              total ? (
                <EmptyState icon={<Database />} title="No volumes match" body="Try another name, or show all volumes." action={<Button onClick={() => (setQ(''), setFilter('all'))}>Show all volumes</Button>} />
              ) : (
                <EmptyState
                  icon={<Database />}
                  title="No volumes yet"
                  body="Volumes keep data when a container is removed. Create one here, or run a container that asks for one."
                  action={
                    <Button variant="primary" icon={<Plus />} onClick={() => setCreate(true)}>
                      Create volume
                    </Button>
                  }
                />
              )
            }
          />
        )}
      </div>
      <CreateVolumeDialog open={create} onClose={() => setCreate(false)} />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={pendingDelete?.length === 1 ? (inUse.length ? `Can’t delete ${pendingDelete[0].name} yet` : `Delete ${pendingDelete[0].name}?`) : `Delete ${pendingDelete?.length ?? 0} volumes?`}
        items={pendingDelete?.map((v) => v.name) ?? []}
        blockedReason={
          inUse.length && inUse.length === pendingDelete?.length
            ? `${inUse.map((v) => v.usedBy.join(', ')).join('; ')} ${inUse.length === 1 && inUse[0].usedBy.length === 1 ? 'is' : 'are'} using ${inUse.length === 1 ? 'this volume' : 'these volumes'}. Remove ${inUse.flatMap((v) => v.usedBy).length === 1 ? 'that container' : 'those containers'} first; stopping isn’t enough.`
            : undefined
        }
        impact={inUse.length ? `${inUse.length} in use will be kept.` : `All data in ${pendingDelete?.length === 1 ? 'it' : 'them'} is lost (${bytes((pendingDelete ?? []).reduce((s, v) => s + v.size, 0))}).`}
        confirmLabel={pendingDelete?.length === 1 ? 'Delete volume' : 'Delete volumes'}
        onConfirm={() => doDelete((pendingDelete ?? []).filter((v) => !v.usedBy.length))}
      />
    </>
  )
}
