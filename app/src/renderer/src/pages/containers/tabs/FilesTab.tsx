import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, Download, File, FileDiff, Folder, Link2, Upload } from 'lucide-react'
import { api, type ContainerRow, type FileEntry } from '@/api'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { ago, bytes, fullDate } from '@/lib/format'
import { cn } from '@/lib/cn'

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const parent = (p: string) => p.replace(/\/[^/]*$/, '') || '/'

/** S08: browse a container's files, copy files in and out, and see what changed against the image. */
export function FilesTab({ c }: { c: ContainerRow }) {
  const [path, setPath] = useState('/')
  const [showChanges, setShowChanges] = useState(false)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-2">
        <Switch label="Show what changed" checked={showChanges} onCheckedChange={setShowChanges} />
      </div>
      {showChanges ? <Changes c={c} onOpen={(p) => (setShowChanges(false), setPath(parent(p)))} /> : <Browser c={c} path={path} setPath={setPath} />}
    </div>
  )
}

function Browser({ c, path, setPath }: { c: ContainerRow; path: string; setPath: (p: string) => void }) {
  const toast = useToast()
  const q = useQuery({ queryKey: ['files', c.id, path], queryFn: () => api.files.list(c.id, path), staleTime: 0, retry: false })
  const [typed, setTyped] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const crumbs = path === '/' ? [] : path.slice(1).split('/')
  const go = (p: string) => (setTyped(null), setPath(p))

  const download = async (e: FileEntry) => {
    const p = join(path, e.name)
    setBusy(p)
    try {
      const saved = await api.files.download(c.id, p, e.type === 'dir')
      if (saved) toast({ kind: 'success', title: `Saved ${e.name}${e.type === 'dir' ? ' as a .tar' : ''}`, body: saved })
    } catch (err) {
      toast({ kind: 'error', title: `Couldn’t download ${e.name}`, body: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const upload = async () => {
    setBusy('upload')
    try {
      const n = await api.files.upload(c.id, path)
      if (n) {
        toast({ kind: 'success', title: `Copied ${n} file${n === 1 ? '' : 's'} into ${path}` })
        void q.refetch()
      }
    } catch (err) {
      toast({ kind: 'error', title: `Couldn’t copy into ${path}`, body: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-2">
        <Button size="sm" iconOnly aria-label="Up one folder" icon={<ArrowUp />} disabled={path === '/'} onClick={() => go(parent(path))} />
        <nav aria-label="Folder path" className="flex min-w-0 flex-1 items-center gap-0.5 font-mono text-xs">
          <button type="button" onClick={() => go('/')} className="rounded-sm px-1 py-0.5 text-link hover:bg-hover">
            /
          </button>
          {crumbs.map((part, i) => {
            const to = '/' + crumbs.slice(0, i + 1).join('/')
            const last = i === crumbs.length - 1
            return (
              <span key={to} className="flex min-w-0 items-center gap-0.5">
                {i > 0 && <span className="text-muted">/</span>}
                <button type="button" aria-current={last ? 'location' : undefined} onClick={() => go(to)} className={cn('truncate rounded-sm px-1 py-0.5 hover:bg-hover', last ? 'text-fg' : 'text-link')}>
                  {part}
                </button>
              </span>
            )
          })}
        </nav>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (typed?.startsWith('/')) go(typed.replace(/\/+$/, '') || '/')
          }}
        >
          <input
            aria-label="Go to path"
            placeholder="/etc/nginx"
            value={typed ?? ''}
            onChange={(e) => setTyped(e.target.value)}
            className="h-7 w-44 rounded-md border border-line-strong bg-bg px-2 font-mono text-xs text-fg outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-focus"
          />
        </form>
        <Button size="sm" icon={<Upload />} loading={busy === 'upload'} onClick={() => void upload()}>
          Upload here
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {q.isError ? (
          <ErrorState what={path} error={q.error} onRetry={() => go(parent(path))} />
        ) : q.isPending ? (
          <p role="status" className="p-5 text-base text-muted">
            Reading {path}…
          </p>
        ) : (
          <>
            {(q.data.truncated || q.data.via === 'archive') && (
              <p className="border-b border-line px-5 py-1.5 text-xs text-muted">
                {q.data.via === 'archive' ? (c.state === 'running' ? 'This container has no shell, so Tender read the folder through the engine.' : 'The container is stopped, so Tender read the folder through the engine.') : ''}
                {q.data.truncated ? ' The folder is big; only part of it is shown.' : ''}
              </p>
            )}
            <table aria-label={`Files in ${path}`} className="w-full table-fixed border-collapse text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="h-8 border-b border-line text-left text-xs text-muted">
                  <th className="px-5 font-medium">Name</th>
                  <th className="w-28 px-3 text-right font-medium">Size</th>
                  <th className="w-32 px-3 font-medium">Modified</th>
                  <th className="w-14 px-3 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.entries.map((e) => (
                  <tr key={e.name} className="group h-9 border-b border-line hover:bg-hover">
                    <td className="truncate px-5">
                      {e.type === 'dir' ? (
                        <button type="button" onClick={() => go(join(path, e.name))} className="inline-flex max-w-full items-center gap-2 truncate font-medium text-fg">
                          <Folder aria-hidden className="size-4 shrink-0 text-muted" />
                          {e.name}
                        </button>
                      ) : (
                        <span className="inline-flex max-w-full items-center gap-2 truncate">
                          {e.type === 'link' ? <Link2 aria-hidden className="size-4 shrink-0 text-muted" /> : <File aria-hidden className="size-4 shrink-0 text-muted" />}
                          {e.name}
                        </span>
                      )}
                    </td>
                    <td className="px-3 text-right text-muted tabular-nums">{e.type === 'file' ? bytes(e.size) : ''}</td>
                    <td className="px-3 text-muted" title={fullDate(e.modifiedAt)}>
                      {ago(e.modifiedAt)}
                    </td>
                    <td className="px-3 text-right">
                      {(e.type === 'file' || e.type === 'dir') && (
                        <Button size="sm" variant="ghost" iconOnly aria-label={`Download ${e.name}`} icon={<Download />} loading={busy === join(path, e.name)} onClick={() => void download(e)} />
                      )}
                    </td>
                  </tr>
                ))}
                {!q.data.entries.length && (
                  <tr>
                    <td colSpan={4} className="px-5 py-3 text-sm text-muted">
                      This folder is empty.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}

const KIND = { added: ['A', 'text-success', 'Added'], changed: ['C', 'text-warning', 'Changed'], deleted: ['D', 'text-danger', 'Deleted'] } as const

function Changes({ c, onOpen }: { c: ContainerRow; onOpen: (path: string) => void }) {
  const q = useQuery({ queryKey: ['changes', c.id], queryFn: () => api.files.changes(c.id), staleTime: 0 })
  if (q.isError) return <ErrorState what="the changes" error={q.error} onRetry={() => void q.refetch()} />
  if (q.isPending) return <p role="status" className="p-5 text-base text-muted">Comparing with the image…</p>
  if (!q.data.length)
    return (
      <p className="flex items-center gap-2 p-5 text-base text-muted">
        <FileDiff aria-hidden className="size-4" />
        Nothing changed: the container’s files match its image.
      </p>
    )
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <p className="border-b border-line px-5 py-1.5 text-xs text-muted">
        {q.data.length} paths differ from the image. Volumes and bind mounts aren’t compared. These changes go away when the container is removed.
      </p>
      <ul aria-label="Changes against the image" className="font-mono text-xs">
        {q.data.map((ch) => (
          <li key={ch.path} className="flex items-center gap-3 border-b border-line px-5 py-1.5">
            <span className={cn('w-4 font-bold', KIND[ch.kind][1])} title={KIND[ch.kind][2]}>
              <span aria-hidden>{KIND[ch.kind][0]}</span>
              <span className="sr-only">{KIND[ch.kind][2]}</span>
            </span>
            {ch.kind === 'deleted' ? (
              <span className="truncate text-muted line-through">{ch.path}</span>
            ) : (
              <button type="button" onClick={() => onOpen(ch.path)} className="truncate text-left text-fg hover:underline" title="Open its folder">
                {ch.path}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
