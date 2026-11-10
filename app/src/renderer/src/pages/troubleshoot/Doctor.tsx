import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Info, RotateCw, Wrench, X } from 'lucide-react'
import { api, type DoctorCheck } from '@/api'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { keys } from '@/lib/queries'
import { href } from '@/lib/router'

const areaName: Record<DoctorCheck['area'], string> = { wsl: 'WSL', engine: 'Docker Engine', network: 'Network', windows: 'Docker tools on Windows' }

/** Every link Tender depends on, checked, with the fix next to each problem. */
export function Doctor() {
  const checks = useQuery({ queryKey: ['doctor'], queryFn: () => api.doctor.check() })
  const list = checks.data ?? []
  const problems = list.filter((c) => c.status === 'fail' || c.status === 'warn').length
  const areas = [...new Set(list.map((c) => c.area))]

  return (
    <section aria-labelledby="doctor-title" className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <h2 id="doctor-title" className="text-md text-fg">
            Checkup
          </h2>
          <p role="status" className="text-sm text-muted">
            {checks.isFetching ? 'Checking…' : checks.data ? (problems ? `${problems} ${problems === 1 ? 'thing needs' : 'things need'} attention` : 'Everything looks right') : ''}
          </p>
        </div>
        <Button icon={<RotateCw />} loading={checks.isFetching} onClick={() => void checks.refetch()}>
          Check again
        </Button>
      </div>
      {checks.isError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{(checks.error as Error).message}</p>}
      {areas.map((a) => (
        <div key={a} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted">{areaName[a]}</h3>
          <ul className="flex flex-col gap-2">
            {list
              .filter((c) => c.area === a)
              .map((c) => (
                <Row key={c.id} check={c} onFixed={() => void checks.refetch()} />
              ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

function Row({ check: c, onFixed }: { check: DoctorCheck; onFixed: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const icon =
    c.status === 'ok' ? <Check aria-hidden className="size-4 text-success" /> : c.status === 'fail' ? <X aria-hidden className="size-4 text-danger" /> : c.status === 'warn' ? <AlertTriangle aria-hidden className="size-4 text-warning" /> : <Info aria-hidden className="size-4 text-muted" />
  const fix = async () => {
    setBusy(true)
    try {
      const said = await api.doctor.fix(c.fix!.id, c.fix!.distro)
      toast({ kind: 'success', title: said })
      void qc.invalidateQueries({ queryKey: keys.engine })
      onFixed()
    } catch (e) {
      toast({ kind: 'error', title: 'That did not work', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="flex gap-3">
      <span className="mt-0.5">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-base text-fg">
          {c.title}
          <span className="sr-only">: {c.status === 'ok' ? 'fine' : c.status === 'info' ? 'note' : c.status === 'warn' ? 'warning' : 'problem'}</span>
        </p>
        {c.detail && <p className="text-sm break-all text-muted">{c.detail}</p>}
        {c.hint && <p className="text-sm text-muted">{c.hint}</p>}
        {c.fix && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Wrench />} loading={busy} onClick={() => void fix()}>
              {c.fix.label}
            </Button>
            {c.fix.note && <span className="text-sm text-muted">{c.fix.note}</span>}
          </div>
        )}
        {c.link && (
          <a href={href(c.link.route)} className="text-sm text-link underline underline-offset-2">
            {c.link.label}
          </a>
        )}
      </div>
    </li>
  )
}
