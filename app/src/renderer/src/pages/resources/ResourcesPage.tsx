import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HardDrive, Loader2, MemoryStick, Scissors, Trash2 } from 'lucide-react'
import { api, type ResourceAction } from '@/api'
import { PageHeader } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { bytes } from '@/lib/format'

/**
 * Windows: WSL's memory and disks. WSL's own answers to "the VM eats RAM" and
 * "the disk only grows", which live in .wslconfig and `wsl --manage`, with
 * what each one costs.
 */
export function ResourcesPage() {
  const r = useQuery({ queryKey: ['resources'], queryFn: () => api.resources.status(), refetchInterval: 10_000 })
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const d = r.data

  const act = async (key: string, a: ResourceAction) => {
    setBusy(key)
    try {
      toast({ kind: 'success', title: await api.resources.act(a) })
      await r.refetch()
    } catch (e) {
      toast({ kind: 'error', title: 'That did not work', body: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader title="Memory and disk" />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {!d ? (
          <p role="status" className="inline-flex items-center gap-2 text-sm text-muted">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Reading WSL’s memory and disks…
          </p>
        ) : (
          <div className="flex max-w-3xl flex-col gap-6">
            <section aria-labelledby="mem-title" className="flex flex-col gap-4 rounded-lg border border-line p-4">
              <div className="flex items-center gap-2">
                <MemoryStick aria-hidden className="size-5 text-muted" />
                <h2 id="mem-title" className="text-md text-fg">
                  Memory
                </h2>
              </div>
              <Meter label="WSL holds" value={d.memory.vmBytes} max={d.memory.hostBytes} />
              <p className="text-sm text-muted">Linux keeps what it once used as cache, so WSL rarely gives memory back to Windows by itself. Reclaim makes it return what it no longer needs.</p>
              <div className="flex flex-wrap items-end gap-6">
                <div className="flex w-56 flex-col gap-1">
                  <span aria-hidden className="text-sm text-fg">
                    Give memory back
                  </span>
                  <Select
                    label="Give memory back"
                    value={d.memory.reclaim}
                    onValueChange={(v) => void act('reclaim', { kind: 'reclaim', mode: v as 'gradual' | 'dropCache' | 'disabled' })}
                    options={[
                      { value: 'gradual', label: 'Gradually (recommended)' },
                      { value: 'dropCache', label: 'When idle, all at once' },
                      { value: 'disabled', label: 'Never (WSL’s default)' },
                    ]}
                  />
                </div>
                <div className="flex w-56 flex-col gap-1">
                  <span aria-hidden className="text-sm text-fg">
                    Most WSL may use
                  </span>
                  <Select
                    label="Most WSL may use"
                    value={d.memory.limit ?? 'default'}
                    onValueChange={(v) => void act('limit', { kind: 'limit', gb: v === 'default' ? null : Number(v) })}
                    options={[{ value: 'default', label: 'Half your RAM (default)' }, ...[4, 6, 8, 12, 16, 24, 32].filter((g) => g * 1e9 < d.memory.hostBytes).map((g) => ({ value: String(g), label: `${g} GB` }))].concat(
                      d.memory.limit && !/^\d+GB$/i.test(d.memory.limit) ? [{ value: d.memory.limit, label: d.memory.limit }] : [],
                    )}
                  />
                </div>
              </div>
              <p className="text-xs text-muted">Saved in {d.wslconfig}. WSL reads it when it starts: changes apply after wsl --shutdown, which stops every distribution.</p>
            </section>

            <section aria-labelledby="disk-title" className="flex flex-col gap-4 rounded-lg border border-line p-4">
              <div className="flex items-center gap-2">
                <HardDrive aria-hidden className="size-5 text-muted" />
                <h2 id="disk-title" className="text-md text-fg">
                  Disk
                </h2>
              </div>
              <p className="text-sm text-muted">Each distribution keeps its files in one virtual disk. A regular disk only grows: deleting images frees space inside Linux, not on Windows. A sparse disk gives it back.</p>
              {d.disks.map((x) => (
                <div key={x.distro} className="flex flex-col gap-2 rounded-md bg-surface p-3">
                  <p className="text-base text-fg">
                    {x.distro} <span className="text-sm text-muted">· {x.sparse ? 'sparse disk' : 'regular disk'}</span>
                  </p>
                  <p className="text-sm text-muted">
                    {bytes(x.fileBytes)} on Windows
                    {x.usedBytes !== undefined && `, ${bytes(x.usedBytes)} used inside`}
                    {x.usedBytes !== undefined && x.fileBytes > x.usedBytes * 1.1 && ` · about ${bytes(x.fileBytes - x.usedBytes)} could go back to Windows`}
                  </p>
                  <p className="text-xs break-all text-muted">{x.path}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {!x.sparse && x.version === 2 && (
                      <>
                        <Button size="sm" icon={<HardDrive />} loading={busy === `sparse-${x.distro}`} onClick={() => void act(`sparse-${x.distro}`, { kind: 'make-sparse', distro: x.distro })}>
                          Make it sparse
                        </Button>
                        <span className="text-sm text-muted">Restarts {x.distro}: what runs in it stops for a moment.</span>
                      </>
                    )}
                    {x.sparse && x.running && (
                      <Button size="sm" icon={<Scissors />} loading={busy === `trim-${x.distro}`} onClick={() => void act(`trim-${x.distro}`, { kind: 'trim', distro: x.distro })}>
                        Give space back now
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              <Switch label="Give new distributions a sparse disk" checked={d.sparseByDefault} onCheckedChange={(on) => void act('sparse-default', { kind: 'sparse-default', on })} />
              {d.buildCache && (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-muted">
                    Build cache: {bytes(d.buildCache.total)}, {bytes(d.buildCache.reclaimable)} not in use.
                  </p>
                  <Button size="sm" variant="danger" icon={<Trash2 />} disabled={!d.buildCache.reclaimable} loading={busy === 'prune'} onClick={() => void act('prune', { kind: 'prune-build-cache' })}>
                    Clear unused build cache
                  </Button>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  )
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-sm">
        <span className="text-fg">{label}</span>
        <span className="text-muted tabular-nums">
          {bytes(value)} of {bytes(max)}
        </span>
      </div>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${bytes(value)} of ${bytes(max)}`} className="h-2 overflow-hidden rounded-full bg-surface">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
