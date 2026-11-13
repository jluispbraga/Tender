import { useQuery } from '@tanstack/react-query'
import { api, type KubeKind } from '@/api'
import { CopyButton } from '@/components/ui/copy-button'
import { Modal } from '@/components/ui/dialog'

export type YamlTarget = { kind: 'pods' | 'deployments' | 'services' | KubeKind; namespace: string; name: string }

/** Read only: what kubectl get -o yaml shows. */
export function YamlDialog({ context, target, onClose }: { context: string; target: YamlTarget; onClose: () => void }) {
  const y = useQuery({ queryKey: ['kube', 'yaml', context, target], queryFn: () => api.kube.yaml(context, target.kind, target.namespace, target.name), retry: false })
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${target.name}.yaml`}
      description={`${target.namespace}. Read only${target.kind === 'secrets' ? ', and the secret values are hidden' : ''}.`}
      size="lg"
      footer={y.data ? <CopyButton label="Copy YAML" value={y.data} /> : undefined}
    >
      {y.isError ? (
        <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(y.error as Error).message}</p>
      ) : !y.data ? (
        <p className="text-sm text-muted">Reading…</p>
      ) : (
        <pre tabIndex={0} aria-label="YAML" className="max-h-[60vh] overflow-auto rounded-md bg-term-bg px-3 py-2 font-mono text-xs whitespace-pre text-term-text">
          {y.data}
        </pre>
      )}
    </Modal>
  )
}
