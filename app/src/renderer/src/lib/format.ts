import type { ContainerRow, PortBinding } from '@/api'

export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`
  return `${Math.round(n)} B`
}

// Words follow the UI language (English for now); absolute dates use the
// system locale's format.
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "3 hours ago". Input is a UTC ISO string. */
export function ago(iso?: string): string {
  if (!iso) return '—'
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  const abs = Math.abs(s)
  if (abs < 45) return 'just now'
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  if (abs < 86400 * 45) return rtf.format(Math.round(s / 86400), 'day')
  return rtf.format(Math.round(s / (86400 * 30)), 'month')
}

export const fullDate = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—')

export const portLabel = (p: PortBinding) =>
  p.publicPort ? `${p.publicPort}:${p.privatePort}${p.protocol === 'udp' ? '/udp' : ''}` : `${p.privatePort}${p.protocol === 'udp' ? '/udp' : ''}`

/** Ports a browser can open: published TCP ports. */
export const browsable = (p: PortBinding) => p.protocol === 'tcp' && !!p.publicPort

export const shortId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12)

export const isLive = (c: ContainerRow) => c.state === 'running' || c.state === 'paused' || c.state === 'restarting'

export const imageName = (tags: string[], id: string) => tags[0] ?? `<untagged> ${shortId(id)}`
