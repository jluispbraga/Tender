import { useState } from 'react'
import type { KubeContext, KubeEnv, Settings } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/cn'

export const envNames: Record<KubeEnv, string> = { local: 'Local', dev: 'Dev', qa: 'QA', prod: 'Production' }

const envStyle: Record<KubeEnv, string> = {
  local: 'bg-neutral-bg text-muted',
  dev: 'bg-neutral-bg text-accent',
  qa: 'bg-warning-bg text-warning',
  prod: 'bg-danger-bg text-danger',
}

export interface ClusterLabel {
  label: string
  env?: KubeEnv
  /** The env came from the user, not a guess. */
  envSet: boolean
}

/** The user's name and environment for a context, else Tender's defaults. */
export function clusterLabel(c: KubeContext | undefined, labels: Settings['kube_labels'] | undefined): ClusterLabel {
  if (!c) return { label: '', envSet: false }
  const own = labels?.[c.key]
  return { label: own?.name || c.defaultLabel, env: own?.env ?? c.guessedEnv, envSet: !!own?.env }
}

/** "flake-prod · microk8s · Production": what the context picker lists. */
export const optionText = (c: KubeContext, l: ClusterLabel) => [l.label, l.label !== c.context ? c.context : null, l.env ? envNames[l.env] : null].filter(Boolean).join(' · ')

export function EnvBadge({ env, className }: { env?: KubeEnv; className?: string }) {
  if (!env) return null
  return <span className={cn('inline-flex h-6 items-center rounded-md px-2 text-xs font-medium whitespace-nowrap', envStyle[env], className)}>{envNames[env]}</span>
}

/** Name a cluster and mark what it is for. Stored in Tender; the kubeconfig is left alone. */
export function ClusterLabelDialog({ context, current, onClose, onSave }: { context: KubeContext; current: ClusterLabel; onClose: () => void; onSave: (v: { name?: string; env?: KubeEnv }) => Promise<void> }) {
  const [name, setName] = useState(current.label === context.defaultLabel ? '' : current.label)
  const [env, setEnv] = useState<KubeEnv | 'none' | 'guess'>(current.envSet ? current.env! : 'guess')
  const [busy, setBusy] = useState(false)
  const error = name.trim().length > 60 ? 'At most 60 characters.' : undefined
  const save = async () => {
    if (error) return
    setBusy(true)
    try {
      await onSave({ name: name.trim() || undefined, env: env === 'guess' ? undefined : env === 'none' ? undefined : env })
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Name this cluster"
      description={`Context ${context.context} in ${context.file ?? 'your kubeconfig'}. Only Tender uses this name; your kubeconfig is not changed.`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!!error} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Input label="Name" placeholder={context.defaultLabel} value={name} onChange={(e) => setName(e.target.value)} error={error} hint="Leave empty to use the file or context name." autoFocus />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-fg">Environment</span>
          <Select
            label="Environment"
            value={env}
            onValueChange={(v) => setEnv(v as typeof env)}
            options={[
              { value: 'guess', label: context.guessedEnv ? `Tender’s guess: ${envNames[context.guessedEnv]}` : 'Not set (Tender has no guess)' },
              { value: 'local', label: 'Local' },
              { value: 'dev', label: 'Dev' },
              { value: 'qa', label: 'QA' },
              { value: 'prod', label: 'Production' },
            ]}
          />
          <p className="text-sm text-muted">Production shows in red everywhere, and deleting there asks you to type the name.</p>
        </div>
      </form>
    </Modal>
  )
}
