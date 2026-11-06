import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'

/** S17: a new, empty named volume. */
export function CreateVolumeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
    }
  }, [open])

  const submit = async () => {
    if (!name.trim()) {
      setError('Give the volume a name.')
      return
    }
    setBusy(true)
    try {
      const v = await api.volumes.create(name.trim())
      toast({ kind: 'success', title: `Created ${v.name}`, body: 'Mount it when you run a container.' })
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
      title="Create a volume"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Plus />} loading={busy} onClick={() => void submit()}>
            Create
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
          label="Name"
          placeholder="app-data"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          error={error ?? undefined}
          hint="Letters, digits, dots, dashes and underscores."
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
