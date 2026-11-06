import { useState } from 'react'
import { Eraser } from 'lucide-react'
import { api, type ImageRow } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { bytes, imageName } from '@/lib/format'
import { cn } from '@/lib/cn'

/** S20: remove untagged images, or every image no container uses. */
export function CleanupDialog({ open, onClose, images }: { open: boolean; onClose: () => void; images: ImageRow[] }) {
  const toast = useToast()
  const [scope, setScope] = useState<'dangling' | 'unused'>('dangling')
  const [busy, setBusy] = useState(false)
  const targets = images.filter((i) => (scope === 'dangling' ? i.dangling : !i.inUse))
  const size = targets.reduce((s, i) => s + i.size, 0)

  const run = async () => {
    setBusy(true)
    try {
      const r = await api.images.prune(scope)
      toast({ kind: 'success', title: r.deleted.length ? `Removed ${r.deleted.length} image${r.deleted.length === 1 ? '' : 's'}` : 'Nothing to remove', body: r.deleted.length ? `Freed ${bytes(r.spaceReclaimed)}.` : undefined })
      onClose()
    } catch (e) {
      toast({ kind: 'error', title: 'Clean up failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Clean up images"
      description="Images in use by any container, running or stopped, are never removed."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" icon={<Eraser />} loading={busy} disabled={!targets.length} onClick={() => void run()}>
            {targets.length ? `Remove ${targets.length} image${targets.length === 1 ? '' : 's'}` : 'Nothing to remove'}
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">What to remove</legend>
        {(
          [
            ['dangling', 'Untagged images only', 'Leftovers from rebuilding an image under the same tag. Always safe to remove.'],
            ['unused', 'Every unused image', 'Also removes tagged images you may want later; they’d need to be pulled or built again.'],
          ] as const
        ).map(([value, title, body]) => (
          <label key={value} className={cn('flex cursor-pointer gap-3 rounded-md border p-3', scope === value ? 'border-accent bg-selected' : 'border-line hover:bg-hover')}>
            <input type="radio" name="scope" value={value} checked={scope === value} onChange={() => setScope(value)} className="mt-0.5 accent-accent" />
            <span className="flex flex-col gap-0.5">
              <span className="text-base font-medium text-fg">{title}</span>
              <span className="text-sm text-muted">{body}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-4 rounded-md border border-line bg-surface px-3 py-2">
        <p className="text-sm text-fg">
          {targets.length ? `${targets.length} image${targets.length === 1 ? '' : 's'}, up to ${bytes(size)}` : 'No images match.'}
        </p>
        {targets.length > 0 && (
          <ul className="mt-1 max-h-28 overflow-auto font-mono text-xs text-muted">
            {targets.map((i) => (
              <li key={i.id} className="truncate">
                {imageName(i.tags, i.id)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
