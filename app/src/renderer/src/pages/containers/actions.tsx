import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, FileText, Pause, Play, RotateCw, Square, SquareTerminal, Trash2 } from 'lucide-react'
import { api, type ActionResult, type ContainerAction, type ContainerRow } from '@/api'
import { ConfirmDialog } from '@/components/ui/dialog'
import type { MenuEntry } from '@/components/ui/menu'
import { useToast } from '@/components/ui/toast'
import { isLive } from '@/lib/format'
import { keys } from '@/lib/queries'
import { navigate } from '@/lib/router'

const verb: Record<ContainerAction, string> = { start: 'start', stop: 'stop', restart: 'restart', pause: 'pause', unpause: 'resume' }

/**
 * Container actions shared by the list (S03), the detail header (S04) and
 * the project page (S10): busy tracking per id, error toasts, and the delete
 * confirmation (S18).
 */
export function useContainerActions() {
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<ContainerRow[] | null>(null)

  const track = useCallback(
    async (ids: string[], work: () => Promise<ActionResult[]>, what: string) => {
      setBusy((b) => new Set([...b, ...ids]))
      try {
        const results = await work()
        const failed = results.filter((r) => !r.ok)
        if (failed.length) {
          toast({ kind: 'error', title: `Couldn’t ${what} ${failed.length === 1 ? 'a container' : `${failed.length} containers`}`, body: failed.map((f) => f.error).join(' ') })
        }
        return results
      } catch (e) {
        toast({ kind: 'error', title: `Couldn’t ${what}`, body: (e as Error).message })
        return []
      } finally {
        setBusy((b) => new Set([...b].filter((id) => !ids.includes(id))))
        void qc.invalidateQueries({ queryKey: keys.containers })
      }
    },
    [qc, toast],
  )

  const run = useCallback((ids: string[], action: ContainerAction) => track(ids, () => api.containers.action(ids, action), verb[action]), [track])

  const copyRunCommand = useCallback(
    async (c: ContainerRow) => {
      await navigator.clipboard.writeText(await api.containers.runCommand(c.id))
      toast({ kind: 'success', title: 'Copied the docker run command', body: `Recreates ${c.name} with the same ports, mounts and environment.` })
    },
    [toast],
  )

  const menu = useCallback(
    (c: ContainerRow, opts: { inDetail?: boolean } = {}): MenuEntry[] => [
      c.state === 'running' || c.state === 'restarting'
        ? { label: 'Stop', icon: <Square />, onSelect: () => void run([c.id], 'stop') }
        : c.state === 'paused'
          ? { label: 'Resume', icon: <Play />, onSelect: () => void run([c.id], 'unpause') }
          : { label: 'Start', icon: <Play />, onSelect: () => void run([c.id], 'start') },
      { label: 'Pause', icon: <Pause />, disabled: c.state !== 'running', disabledReason: 'Only a running container can be paused', onSelect: () => void run([c.id], 'pause') },
      { label: 'Restart', icon: <RotateCw />, disabled: !isLive(c) && c.state !== 'exited', onSelect: () => void run([c.id], 'restart') },
      ...(opts.inDetail
        ? []
        : [
            { label: 'View logs', icon: <FileText />, onSelect: () => navigate('containers', c.id, 'logs') },
            { label: 'Open terminal', icon: <SquareTerminal />, disabled: c.state !== 'running', disabledReason: 'Start the container to open a terminal', onSelect: () => navigate('containers', c.id, 'exec') },
          ]),
      { label: 'Copy docker run command', icon: <Copy />, onSelect: () => void copyRunCommand(c) },
      { kind: 'separator' },
      { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setPendingDelete([c]) },
    ],
    [run, copyRunCommand],
  )

  const anyLive = pendingDelete?.some(isLive)
  const confirm = (
    <ConfirmDialog
      open={!!pendingDelete}
      onOpenChange={(o) => !o && setPendingDelete(null)}
      title={pendingDelete?.length === 1 ? `Delete ${pendingDelete[0].name}?` : `Delete ${pendingDelete?.length ?? 0} containers?`}
      items={pendingDelete?.map((c) => c.name) ?? []}
      impact={anyLive ? 'Running containers are stopped first. Named volumes are kept.' : 'Named volumes are kept.'}
      confirmLabel={pendingDelete?.length === 1 ? 'Delete container' : 'Delete containers'}
      onConfirm={async () => {
        const rows = pendingDelete ?? []
        const results = await track(rows.map((c) => c.id), () => api.containers.remove(rows.map((c) => c.id), !!anyLive), 'delete')
        const ok = results.filter((r) => r.ok).length
        if (ok) toast({ kind: 'success', title: ok === 1 ? `Deleted ${rows.find((r) => r.id === results.find((x) => x.ok)!.id)?.name}` : `Deleted ${ok} containers` })
      }}
    />
  )

  return { busy, run, menu, askDelete: setPendingDelete, confirm, copyRunCommand }
}
