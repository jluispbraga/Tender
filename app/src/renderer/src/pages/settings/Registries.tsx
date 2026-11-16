import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LogOut } from 'lucide-react'
import { api, type RegistryLogin } from '@/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { ago, fullDate } from '@/lib/format'

const key = ['registries'] as const

/**
 * Logins for pull and push. The registry checks each one before it is kept;
 * the password is encrypted by the main process and never comes back here.
 */
export function Registries() {
  const qc = useQueryClient()
  const toast = useToast()
  const logins = useQuery({ queryKey: key, queryFn: api.registries.list, staleTime: 0 })
  const [server, setServer] = useState('docker.io')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ server?: string; username?: string; password?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState<RegistryLogin | null>(null)

  const submit = async () => {
    const e: typeof errors = {}
    if (!server.trim()) e.server = 'Enter the registry address.'
    if (!username.trim()) e.username = 'Enter the user name.'
    if (!password) e.password = 'Enter the password or token.'
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      const l = await api.registries.login(server.trim(), username.trim(), password)
      toast({ kind: 'success', title: `Logged in to ${l.server}`, body: `Pulls and pushes to ${l.server} use ${l.username}.` })
      setPassword('')
      setUsername('')
      void qc.invalidateQueries({ queryKey: key })
    } catch (err) {
      const message = (err as Error).message
      setErrors(/accept/.test(message) ? { password: message } : /reach|address/i.test(message) ? { server: message } : { form: message })
    } finally {
      setBusy(false)
    }
  }

  const logout = async (l: RegistryLogin) => {
    await api.registries.logout(l.server)
    toast({ kind: 'success', title: `Logged out of ${l.server}` })
    void qc.invalidateQueries({ queryKey: key })
  }

  return (
    <div className="flex flex-col gap-5">
      {logins.isError ? (
        <ErrorState what="registry logins" error={logins.error} onRetry={() => void logins.refetch()} />
      ) : logins.data?.length ? (
        <ul aria-label="Saved logins" className="flex flex-col divide-y divide-line rounded-md border border-line">
          {logins.data.map((l) => (
            <li key={l.server} className="flex items-center gap-3 px-3 py-2">
              <KeyRound aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium text-fg">{l.server}</span>
                <span className="truncate text-sm text-muted" title={fullDate(l.savedAt)}>
                  {l.username} · saved {ago(l.savedAt)}
                </span>
              </span>
              <Button size="sm" icon={<LogOut />} onClick={() => setLeaving(l)} aria-label={`Log out of ${l.server}`}>
                Log out
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{logins.isPending ? 'Loading…' : 'No logins yet. Public images pull without one.'}</p>
      )}

      <form
        aria-label="Add a login"
        className="flex flex-col gap-3 rounded-md border border-line p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h3 className="text-base font-medium text-fg">Add a login</h3>
        <Input label="Registry" placeholder="docker.io, ghcr.io, myregistry.example:5000" value={server} onChange={(e) => (setServer(e.target.value), setErrors({}))} error={errors.server} autoComplete="off" spellCheck={false} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="User name" value={username} onChange={(e) => (setUsername(e.target.value), setErrors({}))} error={errors.username} autoComplete="username" spellCheck={false} />
          <Input
            label="Password or token"
            type="password"
            value={password}
            onChange={(e) => (setPassword(e.target.value), setErrors({}))}
            error={errors.password}
            autoComplete="current-password"
          />
        </div>
        <p className="text-sm text-muted">Prefer an access token to your account password. Tender keeps it encrypted for your Windows user and checks it with the registry first.</p>
        {errors.form && (
          <p role="alert" className="text-sm text-danger">
            {errors.form}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" icon={<KeyRound />} loading={busy}>
            Log in
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={!!leaving}
        onOpenChange={(o) => !o && setLeaving(null)}
        title={`Log out of ${leaving?.server ?? ''}?`}
        items={leaving ? [`${leaving.username} on ${leaving.server}`] : []}
        impact="Tender forgets this login. Private images from this registry won’t pull or push until you log in again."
        confirmLabel="Log out"
        onConfirm={() => (leaving ? logout(leaving) : undefined)}
      />
    </div>
  )
}
