import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Tag as TagIcon, Upload } from 'lucide-react'
import { api, type ImageRow, type LayerProgress } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ProgressList } from '@/components/ui/progress-list'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'
import { keys } from '@/lib/queries'
import { href } from '@/lib/router'

/** Same rule the main process checks: lower-case repository, optional registry port, optional tag. */
const REF = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/

/** Gives an image another name, usually the one a registry expects (ghcr.io/you/app:1.0). */
export function TagDialog({ image, open, onClose, onTagged }: { image: ImageRow; open: boolean; onClose: () => void; onTagged?: (ref: string) => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [ref, setRef] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setRef(image.tags[0] ?? '')
      setError(null)
    }
  }, [open, image.tags])

  const submit = async () => {
    const r = ref.trim()
    if (!r) return setError('Enter a name, like ghcr.io/you/app:1.0.')
    if (!REF.test(r)) return setError('Use lower-case letters, digits, dots, dashes and slashes, then an optional :tag.')
    setBusy(true)
    try {
      await api.images.tag(image.id, r)
      const full = /:[^/]+$/.test(r) ? r : `${r}:latest`
      toast({ kind: 'success', title: `Tagged as ${full}` })
      void qc.invalidateQueries({ queryKey: keys.images })
      void qc.invalidateQueries({ queryKey: keys.image(image.id) })
      onClose()
      onTagged?.(full)
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
      title="Tag image"
      description="Adds a name to this image. The image itself isn’t copied, and its other names stay."
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<TagIcon />} loading={busy} onClick={() => void submit()}>
            Tag
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Input
          label="New name"
          placeholder="ghcr.io/you/app:1.0"
          value={ref}
          onChange={(e) => (setRef(e.target.value), setError(null))}
          error={error ?? undefined}
          hint="To push to a registry other than Docker Hub, start with its address. Without a tag, :latest is used."
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

type Phase = { kind: 'idle' } | { kind: 'pushing'; id: string; layers: LayerProgress[] } | { kind: 'error'; message: string; login: boolean }

/** Uploads one of the image's tags. Closing mid-push keeps it going; a toast reports the end. */
export function PushDialog({ image, open, onClose, initial }: { image: ImageRow; open: boolean; onClose: () => void; initial?: string }) {
  const toast = useToast()
  const [ref, setRef] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (open && phase.kind !== 'pushing') {
      setRef(initial && image.tags.includes(initial) ? initial : (image.tags[0] ?? ''))
      setPhase({ kind: 'idle' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const start = () => {
    if (!ref) return
    const handle = api.images.push(ref, (layers) => setPhase((p) => (p.kind === 'pushing' ? { ...p, layers } : p)))
    setPhase({ kind: 'pushing', id: handle.pullId, layers: [] })
    handle.done
      .then(() => {
        setPhase({ kind: 'idle' })
        toast({ kind: 'success', title: `Pushed ${ref}` })
        if (openRef.current) onClose()
      })
      .catch((e: Error & { status?: number }) => {
        if (openRef.current) setPhase({ kind: 'error', message: e.message, login: e.status === 401 })
        else {
          setPhase({ kind: 'idle' })
          if (e.status !== 499) toast({ kind: 'error', title: `Couldn’t push ${ref}`, body: e.message })
        }
      })
  }

  const pushing = phase.kind === 'pushing'
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Push image"
      description="Uploads the image to the registry in its name. Docker Hub when the name has no registry address."
      footer={
        pushing ? (
          <>
            <Button onClick={onClose}>Hide, keep pushing</Button>
            <Button variant="danger" onClick={() => void api.images.cancelPush(phase.id)}>
              Cancel push
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={<Upload />} disabled={!ref} onClick={start}>
              Push
            </Button>
          </>
        )
      }
    >
      {image.tags.length ? (
        <div className="flex flex-col gap-4">
          <Select label="Name to push" value={ref} onValueChange={(v) => (setRef(v), setPhase({ kind: 'idle' }))} options={image.tags.map((t) => ({ value: t, label: t }))} className="w-full" />
          {phase.kind === 'error' && (
            <p role="alert" className="text-sm text-danger">
              {phase.message}{' '}
              {phase.login && (
                <a href={href('settings', 'registries')} onClick={onClose} className="font-medium underline underline-offset-2">
                  Open Registries
                </a>
              )}
            </p>
          )}
          {pushing && (phase.layers.length ? <ProgressList layers={phase.layers} /> : <p role="status" className="text-sm text-muted">Preparing {ref}…</p>)}
        </div>
      ) : (
        <p className="text-base text-muted">This image has no name yet. Tag it first, then push that name.</p>
      )}
    </Modal>
  )
}
