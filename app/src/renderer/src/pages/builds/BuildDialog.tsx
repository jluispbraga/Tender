import { useEffect, useState } from 'react'
import { FolderOpen, Hammer } from 'lucide-react'
import { api, type BuildContext } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { KvEditor, type KvRow } from '@/components/ui/kv-editor'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { startBuild } from '@/lib/builds'
import { navigate } from '@/lib/router'

const REF = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/

/** Pick a folder, a Dockerfile and a name; the build then runs on its own page. */
export function BuildDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [ctx, setCtx] = useState<BuildContext | null>(null)
  const [dockerfile, setDockerfile] = useState('')
  const [tag, setTag] = useState('')
  const [target, setTarget] = useState('')
  const [args, setArgs] = useState<KvRow[]>([])
  const [noCache, setNoCache] = useState(false)
  const [pull, setPull] = useState(false)
  const [errors, setErrors] = useState<{ ctx?: string; tag?: string; target?: string }>({})
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (open) setErrors({})
  }, [open])

  const pick = async () => {
    setPicking(true)
    try {
      const c = await api.builds.pickContext()
      if (!c) return
      setCtx(c)
      setDockerfile(c.dockerfiles[0] ?? '')
      setErrors({})
      // What was typed while the picker was open wins over the suggestion.
      setTag((t) => t || `${c.path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9._-]/g, '-') ?? 'app'}:dev`)
    } catch (e) {
      setErrors({ ctx: (e as Error).message })
    } finally {
      setPicking(false)
    }
  }

  const submit = () => {
    const e: typeof errors = {}
    if (!ctx) e.ctx = 'Choose the folder to build.'
    else if (!dockerfile) e.ctx = 'This folder has no Dockerfile at its top level.'
    if (tag.trim() && !REF.test(tag.trim())) e.tag = 'Use lower-case letters, digits, dots, dashes and slashes, then an optional :tag.'
    if (target.trim() && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target.trim())) e.target = 'A target is the name after AS in a FROM line.'
    const badArg = args.findIndex((a) => a.key.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.key.trim()))
    if (badArg >= 0) setArgs(args.map((a, i) => (i === badArg ? { ...a, error: 'Use letters, digits and underscores.' } : a)))
    setErrors(e)
    if (Object.keys(e).length || badArg >= 0 || !ctx) return
    const id = startBuild({
      context: ctx.path,
      dockerfile,
      ...(tag.trim() ? { tag: tag.trim() } : {}),
      ...(target.trim() ? { target: target.trim() } : {}),
      buildArgs: args.filter((a) => a.key.trim()).map((a) => ({ key: a.key.trim(), value: a.value })),
      noCache,
      pull,
    })
    onClose()
    navigate('builds', id)
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Build an image"
      description="Runs docker build on the engine Tender is connected to. .dockerignore is respected."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Hammer />} disabled={picking} onClick={submit}>
            Build
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-fg">Folder</span>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs text-fg" title={ctx?.path}>
              {ctx?.path ?? <span className="font-sans text-muted">No folder chosen</span>}
            </span>
            <Button icon={<FolderOpen />} loading={picking} onClick={() => void pick()}>
              Choose…
            </Button>
          </div>
          {errors.ctx && (
            <p role="alert" className="text-sm text-danger">
              {errors.ctx}
            </p>
          )}
        </div>
        {ctx && ctx.dockerfiles.length > 0 && (
          <Select label="Dockerfile" value={dockerfile} onValueChange={setDockerfile} options={ctx.dockerfiles.map((f) => ({ value: f, label: f }))} className="w-full" />
        )}
        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <Input label="Name and tag" placeholder="shop-web:dev" value={tag} onChange={(e) => (setTag(e.target.value), setErrors((x) => ({ ...x, tag: undefined })))} error={errors.tag} hint="Leave empty to build without a name." autoComplete="off" spellCheck={false} />
          <Input label="Target (optional)" placeholder="runtime" value={target} onChange={(e) => (setTarget(e.target.value), setErrors((x) => ({ ...x, target: undefined })))} error={errors.target} autoComplete="off" spellCheck={false} />
        </div>
        <KvEditor legend="Build arguments" keyLabel="Name" valueLabel="Value" keyPlaceholder="NODE_ENV" valuePlaceholder="production" rows={args} onChange={setArgs} addLabel="Add argument" />
        <div className="flex flex-col gap-2">
          <Switch label="Don’t use the cache" checked={noCache} onCheckedChange={setNoCache} />
          <Switch label="Check for newer base images" checked={pull} onCheckedChange={setPull} />
        </div>
      </div>
    </Modal>
  )
}
