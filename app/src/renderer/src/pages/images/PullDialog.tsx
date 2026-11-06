import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { api, type LayerProgress } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ProgressList } from '@/components/ui/progress-list'
import { useToast } from '@/components/ui/toast'

type Phase = { kind: 'idle' } | { kind: 'pulling'; pullId: string; layers: LayerProgress[] } | { kind: 'error'; message: string }

/**
 * S14: pull an image by reference. Closing the dialog mid-pull keeps the pull
 * going; a toast reports the result either way.
 */
export function PullDialog({ open, onClose, initial = '' }: { open: boolean; onClose: () => void; initial?: string }) {
  const toast = useToast()
  const [ref, setRef] = useState(initial)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (open && phase.kind !== 'pulling') {
      setRef(initial)
      setPhase({ kind: 'idle' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const start = () => {
    const reference = ref.trim()
    if (!reference) {
      setPhase({ kind: 'error', message: 'Enter an image reference, for example nginx:1.27.' })
      return
    }
    const handle = api.images.pull(reference, (layers) => setPhase((p) => (p.kind === 'pulling' ? { ...p, layers } : p)))
    setPhase({ kind: 'pulling', pullId: handle.pullId, layers: [] })
    handle.done
      .then(() => {
        setPhase({ kind: 'idle' })
        toast({ kind: 'success', title: `Pulled ${reference}` })
        if (openRef.current) onClose()
      })
      .catch((e: Error) => {
        if (openRef.current) setPhase({ kind: 'error', message: e.message })
        else {
          setPhase({ kind: 'idle' })
          toast({ kind: 'error', title: `Couldn’t pull ${reference}`, body: e.message })
        }
      })
  }

  const pulling = phase.kind === 'pulling'
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Pull an image"
      description="Downloads an image from its registry. Docker Hub is used when no registry is named."
      footer={
        pulling ? (
          <>
            <Button onClick={onClose}>Hide, keep pulling</Button>
            <Button variant="danger" onClick={() => void api.images.cancelPull(phase.pullId)}>
              Cancel pull
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={<Download />} onClick={start}>
              Pull
            </Button>
          </>
        )
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!pulling) start()
        }}
      >
        <Input
          label="Image"
          placeholder="nginx:1.27 or ghcr.io/owner/app:tag"
          value={ref}
          disabled={pulling}
          onChange={(e) => {
            setRef(e.target.value)
            if (phase.kind === 'error') setPhase({ kind: 'idle' })
          }}
          error={phase.kind === 'error' ? phase.message : undefined}
          hint="Without a tag, :latest is used."
          autoComplete="off"
          spellCheck={false}
        />
        {pulling && (phase.layers.length ? <ProgressList layers={phase.layers} /> : <p role="status" className="text-sm text-muted">Resolving {ref.trim()}…</p>)}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
