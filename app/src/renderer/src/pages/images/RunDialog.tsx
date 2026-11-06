import { useEffect, useState } from 'react'
import { ChevronRight, Play } from 'lucide-react'
import { api, type ImageRow } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { KvEditor, type KvRow } from '@/components/ui/kv-editor'
import { useToast } from '@/components/ui/toast'
import { imageName } from '@/lib/format'
import { navigate } from '@/lib/router'
import { cn } from '@/lib/cn'

const portOk = (s: string) => /^\d{1,5}$/.test(s) && +s > 0 && +s < 65536

/** S13: start a container from an image, optionally with name, ports, volumes and env. */
export function RunDialog({ image, onClose }: { image: ImageRow | null; onClose: () => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [more, setMore] = useState(false)
  const [ports, setPorts] = useState<KvRow[]>([])
  const [volumes, setVolumes] = useState<KvRow[]>([])
  const [env, setEnv] = useState<KvRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!image) return
    setName('')
    setMore(false)
    setPorts([])
    setVolumes([])
    setEnv([])
    setError(null)
  }, [image])

  const validate = () => {
    let ok = true
    const p = ports
      .filter((r) => r.key || r.value)
      .map((r) => {
        if (!portOk(r.key) || !portOk(r.value)) {
          ok = false
          return { ...r, error: 'Both sides need a port number between 1 and 65535.' }
        }
        return r
      })
    const seen = new Set<string>()
    for (const r of p) {
      if (!r.error && seen.has(r.key)) {
        ok = false
        r.error = `Host port ${r.key} is listed twice.`
      }
      seen.add(r.key)
    }
    const v = volumes
      .filter((r) => r.key || r.value)
      .map((r) => {
        if (!r.key || !r.value.startsWith('/')) {
          ok = false
          return { ...r, error: 'Give a volume name or host folder, and an absolute path inside the container (starting with /).' }
        }
        return r
      })
    const e = env
      .filter((r) => r.key || r.value)
      .map((r) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key)) {
          ok = false
          return { ...r, error: 'Variable names use letters, digits and underscores, and can’t start with a digit.' }
        }
        return r
      })
    setPorts(p)
    setVolumes(v)
    setEnv(e)
    if (!ok) setMore(true)
    return ok ? { p, v, e } : null
  }

  const submit = async () => {
    if (!image) return
    setError(null)
    const valid = validate()
    if (!valid) return
    setBusy(true)
    try {
      const { containerId } = await api.images.run({
        image: image.tags[0] ?? image.id,
        name: name.trim() || undefined,
        ports: valid.p.map((r) => ({ host: r.key, container: r.value })),
        volumes: valid.v.map((r) => ({ source: r.key, target: r.value })),
        env: valid.e.map((r) => ({ key: r.key, value: r.value })),
      })
      toast({ kind: 'success', title: 'Container started', body: `From ${imageName(image.tags, image.id)}.` })
      onClose()
      navigate('containers', containerId, 'logs')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const label = image ? imageName(image.tags, image.id) : ''
  return (
    <Modal
      open={!!image}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Run ${label}`}
      description="Starts a new container from this image."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Play />} loading={busy} onClick={() => void submit()}>
            Run
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Input label="Container name" placeholder="Leave empty to get a generated name" value={name} onChange={(e) => setName(e.target.value)} hint="Letters, digits, dots, dashes and underscores." />
        <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="inline-flex items-center gap-1.5 self-start rounded-sm text-sm font-medium text-fg">
          <ChevronRight aria-hidden className={cn('size-4 text-muted transition-transform duration-100', more && 'rotate-90')} />
          Ports, volumes and environment
        </button>
        {more && (
          <div className="flex flex-col gap-5 border-l border-line pl-4">
            <KvEditor legend="Ports" keyLabel="Host port" valueLabel="Container port" keyPlaceholder="8080" valuePlaceholder="80" rows={ports} onChange={setPorts} addLabel="Add port" />
            <KvEditor legend="Volumes" keyLabel="Volume or host folder" valueLabel="Path in container" keyPlaceholder="my-data or C:\data" valuePlaceholder="/data" rows={volumes} onChange={setVolumes} addLabel="Add volume" />
            <KvEditor legend="Environment variables" keyLabel="Name" valueLabel="Value" keyPlaceholder="NAME" valuePlaceholder="value" rows={env} onChange={setEnv} addLabel="Add variable" />
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
