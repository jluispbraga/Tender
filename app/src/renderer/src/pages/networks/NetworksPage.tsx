import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { Info, Network, Plus, Trash2 } from 'lucide-react'
import { api, type NetworkRow } from '@/api'
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
import { keys, useNetworks } from '@/lib/queries'
import { navigate } from '@/lib/router'
import { CreateNetworkDialog } from './CreateNetworkDialog'

type Filter = 'all' | 'in-use' | 'unused' | 'mine'

/** Docker networks: who is on which, and what address range each uses. */
export function NetworksPage() {
  const networks = useNetworks()
  const qc = useQueryClient()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sel, setSel] = useState<RowSelectionState>({})
  const [create, setCreate] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<NetworkRow[] | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (networks.data ?? []).filter(
      (n) =>
        (filter === 'all' || (filter === 'mine' ? !n.builtIn : (filter === 'in-use') === n.usedBy.length > 0)) &&
        (!needle || n.name.toLowerCase().includes(needle) || n.subnet?.includes(needle) || n.usedBy.some((c) => c.toLowerCase().includes(needle))),
    )
  }, [networks.data, q, filter])

  useEffect(() => {
    const ids = new Set(shown.map((n) => n.id))
    setSel((s) => Object.fromEntries(Object.entries(s).filter(([id]) => ids.has(id))))
  }, [shown])

  const columns: ColumnDef<NetworkRow, any>[] = useMemo(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium" title={row.original.name}>
              {row.original.name}
            </span>
            <CopyButton label={`Copy ${row.original.name}`} value={row.original.name} className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Containers',
        size: 124,
        accessorFn: (n) => n.usedBy.length,
        cell: ({ row }) =>
          row.original.usedBy.length ? (
            <span className="flex min-w-0 items-center gap-2" title={row.original.usedBy.join(', ')}>
              <StatusChip status="in-use" />
              <span className="text-xs text-muted tabular-nums">{row.original.usedBy.length}</span>
            </span>
          ) : (
            <StatusChip status="unused" />
          ),
      },
      {
        id: 'driver',
        accessorKey: 'driver',
        header: 'Driver',
        size: 140,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted">{row.original.driver}</span>
            {row.original.builtIn && <Tag>built in</Tag>}
            {row.original.internal && <Tag>internal</Tag>}
          </span>
        ),
      },
      { id: 'subnet', accessorFn: (n) => n.subnet ?? '', header: 'Subnet', size: 130, cell: ({ getValue }) => <span className="font-mono text-xs text-muted">{getValue() || '—'}</span> },
    ],
    [],
  )

  const doDelete = async (rows: NetworkRow[]) => {
    const ids = rows.map((r) => r.id)
    const nameOf = new Map(rows.map((r) => [r.id, r.name]))
    setBusy((b) => new Set([...b, ...ids]))
    try {
      const results = await api.networks.remove(ids)
      const ok = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)
      if (ok.length) toast({ kind: 'success', title: ok.length === 1 ? `Deleted ${nameOf.get(ok[0].id) ?? ok[0].id}` : `Deleted ${ok.length} networks` })
      if (failed.length) toast({ kind: 'error', title: `Kept ${failed.length} network${failed.length === 1 ? '' : 's'}`, body: failed.map((f) => `${nameOf.get(f.id) ?? f.id}: ${f.error}`).join(' ') })
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t delete networks', body: (e as Error).message })
    } finally {
      setBusy((b) => new Set([...b].filter((id) => !ids.includes(id))))
      void qc.invalidateQueries({ queryKey: keys.networks })
    }
  }

  const all = networks.data ?? []
  const selected = all.filter((n) => sel[n.id])
  const kept = pendingDelete?.filter((n) => n.builtIn || n.usedBy.length) ?? []
  const deletable = pendingDelete?.filter((n) => !n.builtIn && !n.usedBy.length) ?? []
  const unusedOwn = all.filter((n) => !n.builtIn && !n.usedBy.length)

  return (
    <>
      <PageHeader title="Networks">
        <span className="text-sm text-muted">{networks.data ? `${all.length} networks · ${unusedOwn.length} unused` : ''}</span>
        {unusedOwn.length > 0 && (
          <Button icon={<Trash2 />} onClick={() => setPendingDelete(unusedOwn)}>
            Remove unused
          </Button>
        )}
        <Button variant="primary" icon={<Plus />} onClick={() => setCreate(true)}>
          Create
        </Button>
      </PageHeader>
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-2">
        <SearchField label="Search networks" placeholder="Search by name, subnet or container" value={q} onChange={setQ} />
        <Select
          label="Show"
          value={filter}
          onValueChange={(v) => setFilter(v as Filter)}
          className="w-40"
          options={[
            { value: 'all', label: 'All networks' },
            { value: 'mine', label: 'Not built in' },
            { value: 'in-use', label: 'In use' },
            { value: 'unused', label: 'Unused' },
          ]}
        />
      </div>
      <BulkBar count={selected.length} noun="network" note={selected.some((n) => n.builtIn || n.usedBy.length) ? 'built-in networks and networks in use will be kept' : undefined} onClear={() => setSel({})}>
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setPendingDelete(selected)}>
          Delete
        </Button>
      </BulkBar>
      <div className="min-h-0 flex-1 overflow-auto">
        {networks.isError ? (
          <ErrorState what="networks" error={networks.error} onRetry={() => void networks.refetch()} />
        ) : (
          <DataGrid
            label="Networks"
            loading={networks.isPending}
            columns={columns}
            data={shown}
            getRowId={(n) => n.id}
            getRowLabel={(n) => n.name}
            rowSelection={sel}
            onRowSelectionChange={setSel}
            columnVisibility={{}}
            onColumnVisibilityChange={() => {}}
            isRowBusy={(n) => busy.has(n.id)}
            onRowOpen={(n) => navigate('networks', n.id)}
            rowActions={(n) => (
              <ActionsMenu
                label={`Actions for ${n.name}`}
                entries={[
                  { label: 'Details', icon: <Info />, onSelect: () => navigate('networks', n.id) },
                  ...(n.builtIn ? [] : [{ kind: 'separator' as const }, { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete([n]) }]),
                ]}
              />
            )}
            empty={
              all.length ? (
                <EmptyState icon={<Network />} title="No networks match" body="Try another name, or show all networks." action={<Button onClick={() => (setQ(''), setFilter('all'))}>Show all networks</Button>} />
              ) : (
                <EmptyState icon={<Network />} title="No networks" body="Docker normally has bridge, host and none. If they are missing, the engine may still be starting." />
              )
            }
          />
        )}
      </div>
      <CreateNetworkDialog open={create} onClose={() => setCreate(false)} />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={
          pendingDelete?.length === 1
            ? kept.length
              ? `Can’t delete ${pendingDelete[0].name}`
              : `Delete ${pendingDelete[0].name}?`
            : `Delete ${pendingDelete?.length ?? 0} networks?`
        }
        items={pendingDelete?.map((n) => n.name) ?? []}
        blockedReason={
          kept.length && !deletable.length
            ? kept
                .map((n) => (n.builtIn ? `${n.name} is built into Docker.` : `${n.usedBy.join(', ')} ${n.usedBy.length === 1 ? 'is' : 'are'} on ${n.name}. Disconnect or remove ${n.usedBy.length === 1 ? 'that container' : 'those containers'} first.`))
                .join(' ')
            : undefined
        }
        impact={kept.length ? `${kept.length} built in or in use will be kept.` : 'Containers created later can’t join it until it is created again.'}
        confirmLabel={deletable.length === 1 ? 'Delete network' : 'Delete networks'}
        onConfirm={() => doDelete(deletable)}
      />
    </>
  )
}

export function Tag({ children }: { children: string }) {
  return <span className="shrink-0 rounded-sm border border-line px-1.5 text-xs leading-4 text-muted">{children}</span>
}
