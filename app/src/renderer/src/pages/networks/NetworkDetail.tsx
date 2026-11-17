import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Link2, Network, Trash2, Unlink } from 'lucide-react'
import { api, type NetworkMember, type NetworkRow } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Modal } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Select } from '@/components/ui/select'
import { StatusChip } from '@/components/ui/status-chip'
import { useToast } from '@/components/ui/toast'
import { Tooltip } from '@/components/ui/tooltip'
import { ago, fullDate } from '@/lib/format'
import { keys, useContainers, useNetworks } from '@/lib/queries'
import { href, navigate } from '@/lib/router'
import { Tag } from './NetworksPage'

/** host and none are picked when a container is created; nothing joins them later. */
const fixedAtCreate = (n: NetworkRow) => n.driver === 'host' || n.driver === 'null'

/** One network: its address range and the containers on it. */
export function NetworkDetail({ id }: { id: string }) {
  const networks = useNetworks()
  const qc = useQueryClient()
  const toast = useToast()
  const n = networks.data?.find((x) => x.id === id || x.name === id)
  const [connect, setConnect] = useState(false)
  const [leaving, setLeaving] = useState<NetworkMember | null>(null)
  const [deleting, setDeleting] = useState(false)

  if (networks.isError) return <ErrorState what="this network" error={networks.error} onRetry={() => void networks.refetch()} />
  if (networks.isPending) return <p role="status" className="p-5 text-base text-muted">Loading network…</p>
  if (!n) return <EmptyState page icon={<Network />} title="This network no longer exists" body="It was deleted, maybe from the command line." action={<Button onClick={() => navigate('networks')}>Back to networks</Button>} />

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.networks })
    void qc.invalidateQueries({ queryKey: keys.networkMembers(n.id) })
  }

  const disconnect = async (m: NetworkMember) => {
    try {
      await api.networks.disconnect(n.id, m.containerId)
      toast({ kind: 'success', title: `Disconnected ${m.containerName} from ${n.name}` })
    } catch (e) {
      toast({ kind: 'error', title: `Couldn’t disconnect ${m.containerName}`, body: (e as Error).message })
    } finally {
      refresh()
    }
  }

  const remove = async () => {
    const [r] = await api.networks.remove([n.id])
    if (r?.ok) {
      toast({ kind: 'success', title: `Deleted ${n.name}` })
      navigate('networks')
    } else toast({ kind: 'error', title: `Couldn’t delete ${n.name}`, body: r?.error })
    refresh()
  }

  const facts: [string, string, string?][] = [
    ['Driver', n.driver],
    ['Scope', n.scope],
    ['Subnet', n.subnet ?? '—'],
    ['Gateway', n.gateway ?? '—'],
    ['Internet', n.internal ? 'No (internal)' : n.driver === 'null' ? 'No' : 'Yes'],
    ['Created', ago(n.createdAt), fullDate(n.createdAt)],
    ...(n.project ? ([['Compose project', n.project]] as [string, string][]) : []),
  ]

  return (
    <>
      <PageHeader
        back={
          <a href={href('networks')} aria-label="Back to networks" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" />
          </a>
        }
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">{n.name}</span>
            <StatusChip status={n.usedBy.length ? 'in-use' : 'unused'} />
            {n.builtIn && <Tag>built in</Tag>}
          </span>
        }
      >
        {fixedAtCreate(n) ? (
          <Tooltip content={`A container is put on ${n.name} when it is created; it can’t join later.`}>
            <span tabIndex={0}>
              <Button icon={<Link2 />} disabled>
                Connect container
              </Button>
            </span>
          </Tooltip>
        ) : (
          <Button icon={<Link2 />} onClick={() => setConnect(true)}>
            Connect container
          </Button>
        )}
        {!n.builtIn && (
          <Button variant="danger" icon={<Trash2 />} onClick={() => setDeleting(true)}>
            Delete
          </Button>
        )}
      </PageHeader>
      <dl className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-b border-line px-5 py-2 text-sm">
        {facts.map(([k, v, title]) => (
          <div key={k} className="flex gap-2">
            <dt className="text-muted">{k}</dt>
            <dd className={k === 'Subnet' || k === 'Gateway' ? 'font-mono text-xs leading-5' : undefined} title={title}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="min-h-0 flex-1 overflow-auto">
        <Members network={n} onDisconnect={setLeaving} />
      </div>
      <ConnectDialog network={n} open={connect} onClose={() => setConnect(false)} onDone={refresh} />
      <ConfirmDialog
        open={!!leaving}
        onOpenChange={(o) => !o && setLeaving(null)}
        title={`Disconnect ${leaving?.containerName ?? ''}?`}
        items={leaving ? [leaving.containerName] : []}
        impact={`It stops reaching the other containers on ${n.name}${leaving?.state === 'running' ? ' right away' : ''}. You can connect it again later.`}
        confirmLabel="Disconnect"
        onConfirm={() => (leaving ? disconnect(leaving) : Promise.resolve())}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={n.usedBy.length ? `Can’t delete ${n.name}` : `Delete ${n.name}?`}
        items={[n.name]}
        blockedReason={n.usedBy.length ? `${n.usedBy.join(', ')} ${n.usedBy.length === 1 ? 'is' : 'are'} on this network. Disconnect or remove ${n.usedBy.length === 1 ? 'that container' : 'those containers'} first.` : undefined}
        impact="Containers created later can’t join it until it is created again."
        confirmLabel="Delete network"
        onConfirm={remove}
      />
    </>
  )
}

function Members({ network: n, onDisconnect }: { network: NetworkRow; onDisconnect: (m: NetworkMember) => void }) {
  const q = useQuery({ queryKey: keys.networkMembers(n.id), queryFn: () => api.networks.members(n.id), staleTime: 0 })
  if (q.isError) return <ErrorState what="containers on this network" error={q.error} onRetry={() => void q.refetch()} />
  if (q.isPending) return <p role="status" className="p-5 text-base text-muted">Loading…</p>
  if (!q.data.length)
    return (
      <p className="p-5 text-base text-muted">
        No container is on this network.{fixedAtCreate(n) || n.builtIn ? '' : ' It can be deleted safely.'}
      </p>
    )
  return (
    <table aria-label={`Containers on ${n.name}`} className="w-full table-fixed border-collapse text-sm">
      <thead className="sticky top-0 bg-surface">
        <tr className="h-8 border-b border-line text-left text-xs text-muted">
          <th className="px-5 font-medium">Container</th>
          <th className="w-28 px-3 font-medium">State</th>
          <th className="w-36 px-3 font-medium">IP address</th>
          <th className="px-3 font-medium">Reachable as</th>
          <th className="w-40 px-3 font-medium">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {q.data.map((m) => (
          <tr key={m.containerId} className="h-10 border-b border-line">
            <td className="truncate px-5">
              <a href={href('containers', m.containerId, 'inspect')} className="font-medium text-fg underline-offset-2 hover:underline" title={m.image}>
                {m.containerName}
              </a>
            </td>
            <td className="px-3">
              <StatusChip status={m.state === 'dead' ? 'error' : m.state} />
            </td>
            <td className="truncate px-3 font-mono text-xs" title={m.mac ? `MAC ${m.mac}` : undefined}>
              {m.ipv4 ?? <span className="font-sans text-muted">{m.state === 'running' || m.state === 'paused' ? '—' : 'when started'}</span>}
            </td>
            <td className="truncate px-3 font-mono text-xs text-muted" title={[m.containerName, ...m.aliases.filter((a) => a !== m.containerName)].join(', ')}>
              {[m.containerName, ...m.aliases.filter((a) => a !== m.containerName)].join(', ')}
            </td>
            <td className="px-3 text-right">
              {!fixedAtCreate(n) && (
                <Button size="sm" variant="ghost" icon={<Unlink />} onClick={() => onDisconnect(m)} aria-label={`Disconnect ${m.containerName}`}>
                  Disconnect
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ConnectDialog({ network: n, open, onClose, onDone }: { network: NetworkRow; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const containers = useContainers()
  const [choice, setChoice] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const options = useMemo(
    () =>
      (containers.data ?? [])
        .filter((c) => !n.usedBy.includes(c.name))
        .map((c) => ({ value: c.id, label: c.state === 'running' ? c.name : `${c.name} (${c.state})` })),
    [containers.data, n.usedBy],
  )

  useEffect(() => {
    if (open) {
      setChoice(options[0]?.value ?? '')
      setError(null)
    }
    // Only when the dialog opens: the list refreshing must not change the pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const submit = async () => {
    const c = containers.data?.find((x) => x.id === choice)
    if (!c) return
    setBusy(true)
    try {
      await api.networks.connect(n.id, c.id)
      toast({ kind: 'success', title: `Connected ${c.name} to ${n.name}`, body: `Other containers on ${n.name} reach it as ${c.name}.` })
      onDone()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Connect a container to ${n.name}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Link2 />} loading={busy} disabled={!choice} onClick={() => void submit()}>
            Connect
          </Button>
        </>
      }
    >
      {options.length ? (
        <div className="flex flex-col gap-3">
          <Select label="Container" value={choice} onValueChange={(v) => (setChoice(v), setError(null))} options={options} className="w-full" />
          <p className="text-sm text-muted">It keeps its other networks. A stopped container joins when it next starts.</p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p className="text-base text-muted">Every container is already on {n.name}.</p>
      )}
    </Modal>
  )
}
