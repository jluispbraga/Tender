import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Folder, FolderPlus, FilePlus, RotateCw, Trash2 } from 'lucide-react'
import { api, type Settings } from '@/api'
import { Button } from '@/components/ui/button'

/**
 * Settings › Kubernetes: which kubeconfig files Tender reads. ~/.kube/config (or
 * KUBECONFIG) always; anything else only when the user adds it here, with a short
 * guide and, for each source, the contexts it brought in.
 */
export function KubeSources({ settings, save }: { settings: Settings; save: <K extends keyof Settings>(k: K, v: Settings[K]) => Promise<void> }) {
  const qc = useQueryClient()
  const report = useQuery({ queryKey: ['kube', 'sources', settings.kube_sources], queryFn: () => api.kube.sources(), refetchInterval: 10_000 })
  const r = report.data

  const update = async (next: string[]) => {
    await save('kube_sources', next)
    void qc.invalidateQueries({ queryKey: ['kube'] })
  }
  const add = async (kind: 'file' | 'folder') => {
    const path = await api.kube.pickSource(kind)
    if (path && !settings.kube_sources.some((p) => p.toLowerCase() === path.toLowerCase())) await update([...settings.kube_sources, path])
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-md bg-surface px-3 py-2.5 text-sm text-muted" role="note" aria-label="How Tender finds your clusters">
        <p>
          Tender always reads <code className="font-mono text-xs text-fg">{r?.fromEnv ? 'the files in KUBECONFIG' : '~/.kube/config'}</code>, the same file kubectl uses. If you keep a kubeconfig per cluster somewhere else (a cloud provider’s download, a file your team shares, a folder such as{' '}
          <code className="font-mono text-xs text-fg">~/.kube/prod</code>), add it below and its contexts show up on the Kubernetes page.
        </p>
        <ul className="list-disc pl-5">
          <li>
            <span className="text-fg">Add a file</span> for a single kubeconfig.
          </li>
          <li>
            <span className="text-fg">Add a folder</span> to read every kubeconfig in it (not its subfolders). New files you drop there, and edits to any file, show up within a few seconds, or right away with Read the files again.
          </li>
          <li>Two files with the same context name both show, the second one with its file name next to it.</li>
        </ul>
        <p>
          <span className="font-medium text-danger">Production clusters:</span> Tender can restart, scale and delete in any cluster you add. Deletes always ask first and name the context, but they are real. Add a production kubeconfig only if you mean to work on it here.
        </p>
      </div>

      <ul aria-label="Kubeconfig sources" className="flex flex-col divide-y divide-line rounded-md border border-line">
        {(r?.base ?? []).map((b) => (
          <li key={b.file} className="flex items-start gap-3 px-3 py-2">
            <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-fg">{b.file}</p>
              <p className="text-sm text-muted">{b.error ?? contextsLine(b.contexts)} · always read</p>
            </div>
          </li>
        ))}
        {(r?.added ?? []).map((a) => (
          <li key={a.path} className="flex items-start gap-3 px-3 py-2">
            {a.folder ? <Folder aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" /> : <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />}
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-fg">{a.path}</p>
              {a.error ? (
                <p className="text-sm text-danger">{a.error}</p>
              ) : a.folder ? (
                <ul className="text-sm text-muted">
                  {a.files.map((f) => (
                    <li key={f.file} className="truncate">
                      {f.file.slice(a.path.length + 1)}: {f.error ?? contextsLine(f.contexts)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={a.files[0]?.error ? 'text-sm text-danger' : 'text-sm text-muted'}>{a.files[0]?.error ?? contextsLine(a.files[0]?.contexts ?? [])}</p>
              )}
            </div>
            <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} aria-label={`Stop reading ${a.path}`} onClick={() => void update(settings.kube_sources.filter((p) => p !== a.path))} />
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Button icon={<FilePlus />} onClick={() => void add('file')}>
          Add a kubeconfig file…
        </Button>
        <Button icon={<FolderPlus />} onClick={() => void add('folder')}>
          Add a folder…
        </Button>
        <Button
          variant="ghost"
          icon={<RotateCw />}
          loading={report.isFetching}
          onClick={() => (void report.refetch(), void qc.invalidateQueries({ queryKey: ['kube', 'contexts'] }))}
        >
          Read the files again
        </Button>
      </div>
    </div>
  )
}

const contextsLine = (cs: string[]) => (cs.length ? `${cs.length === 1 ? 'Context' : 'Contexts'}: ${cs.join(', ')}` : 'No contexts in it')
