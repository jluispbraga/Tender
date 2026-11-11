import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw } from 'lucide-react'
import { api, type Settings } from '@/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ago } from '@/lib/format'

/** Settings › Updates: which version this is, whether a newer one is on GitHub, and installing it. */
export function Updates({ settings, save }: { settings: Settings; save: <K extends keyof Settings>(k: K, v: Settings[K]) => Promise<void> }) {
  const qc = useQueryClient()
  const u = useQuery({ queryKey: ['updates'], queryFn: () => api.updates.status(), refetchInterval: (q) => (q.state.data?.state === 'checking' || q.state.data?.state === 'downloading' ? 1000 : 30_000) })
  const [checking, setChecking] = useState(false)
  const d = u.data
  if (!d) return null

  const check = async () => {
    setChecking(true)
    try {
      qc.setQueryData(['updates'], await api.updates.check())
    } finally {
      setChecking(false)
    }
  }

  const line =
    d.state === 'ready'
      ? `Tender ${d.version} is downloaded and installs when Tender restarts.`
      : d.state === 'downloading'
        ? `Downloading Tender ${d.version}… ${d.percent ?? 0}%`
        : d.state === 'checking'
          ? 'Looking for a new version…'
          : d.state === 'none'
            ? `This is the latest version${d.checkedAt ? ` (checked ${ago(d.checkedAt)})` : ''}.`
            : d.state === 'error'
              ? `Could not check for updates: ${d.error}`
              : d.state === 'off'
                ? 'Tender does not look for new versions.'
                : 'Tender looks for new versions shortly after it starts, then every 6 hours.'

  return (
    <>
      <p className="text-sm text-fg">
        Tender {d.current}
        {d.supported && <span className="text-muted"> · {line}</span>}
      </p>
      {d.supported ? (
        <>
          <Switch label="Download new versions in the background" checked={settings.check_updates} onCheckedChange={(v) => void save('check_updates', v)} />
          <div className="flex flex-wrap gap-2">
            {d.state === 'ready' ? (
              <Button variant="primary" icon={<Download />} onClick={() => void api.updates.install()}>
                Restart and update
              </Button>
            ) : (
              <Button icon={<RefreshCw />} loading={checking || d.state === 'checking'} disabled={d.state === 'downloading'} onClick={() => void check()}>
                Check now
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted">
          This copy of Tender (portable, .deb or a development build) does not update itself. New versions are on{' '}
          <a href={d.releases} onClick={(e) => (e.preventDefault(), void api.updates.openReleases())} className="text-link underline underline-offset-2">
            GitHub Releases
          </a>
          .
        </p>
      )}
    </>
  )
}
