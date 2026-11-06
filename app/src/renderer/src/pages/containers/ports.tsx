import * as RPopover from '@radix-ui/react-popover'
import { ExternalLink } from 'lucide-react'
import { api, type ContainerRow, type PortBinding } from '@/api'
import { browsable, portLabel } from '@/lib/format'

// Ports as `docker ps` shows them: published ones (host:container) and ones
// the image exposes but nobody published (reachable only from containers on
// the same network). Both count; only published TCP ports of a running
// container can open in a browser.

const sorted = (ports: PortBinding[]) => [...ports].sort((a, b) => Number(!!b.publicPort) - Number(!!a.publicPort) || a.privatePort - b.privatePort)
const exposedLabel = (p: PortBinding) => `${p.privatePort}/${p.protocol}`

function Port({ p, c }: { p: PortBinding; c: ContainerRow }) {
  if (!p.publicPort) return <span className="text-muted">{exposedLabel(p)}</span>
  if (browsable(p) && c.state === 'running') {
    return (
      <a
        href={`http://localhost:${p.publicPort}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void api.containers.openPort(p)
        }}
        // The name starts with the visible text so voice control can target it.
        aria-label={`${portLabel(p)}, opens ${c.name} in your browser`}
        className="inline-flex items-center gap-1 text-link underline-offset-2 hover:underline"
      >
        {portLabel(p)}
        <ExternalLink aria-hidden className="size-3" />
      </a>
    )
  }
  return <span className="text-muted">{portLabel(p)}</span>
}

/** Grid cell: the first port, then "+N" opening the full list. */
export function PortCell({ c }: { c: ContainerRow }) {
  const ports = sorted(c.ports)
  if (!ports.length) return <span className="text-muted">—</span>
  return (
    // Block-level flex so the "+N" button never gets clipped by the cell's truncation.
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">
        <Port p={ports[0]} c={c} />
      </span>
      {ports.length > 1 && (
        <RPopover.Root>
          <RPopover.Trigger
            // Name starts with the visible "+N" (voice control), then says what it does.
            aria-label={`+${ports.length - 1}, show all ${ports.length} ports of ${c.name}`}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 rounded-sm px-1 text-xs text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover"
          >
            +{ports.length - 1}
          </RPopover.Trigger>
          <RPopover.Portal>
            <RPopover.Content
              aria-label={`Ports of ${c.name}`}
              align="start"
              sideOffset={4}
              // Events from a portal still bubble to the row in React: keep them from opening it.
              onClick={(e) => e.stopPropagation()}
              className="z-50 flex w-72 flex-col gap-1 rounded-md border border-line bg-raised p-3 text-sm shadow-pop"
            >
              <p className="pb-1 text-xs font-medium text-muted">Ports</p>
              <ul className="flex flex-col gap-1">
                {ports.map((p) => (
                  <li key={`${p.privatePort}/${p.protocol}/${p.publicPort ?? ''}`} className="flex items-baseline justify-between gap-3">
                    <Port p={p} c={c} />
                    {!p.publicPort && <span className="text-right text-xs text-muted">not published</span>}
                  </li>
                ))}
              </ul>
              {ports.some((p) => !p.publicPort) && <p className="pt-1 text-xs text-muted">Unpublished ports are reachable only from containers on the same network.</p>}
            </RPopover.Content>
          </RPopover.Portal>
        </RPopover.Root>
      )}
    </span>
  )
}

/** Detail header: every published port as a link, then the unpublished ones in one line. */
export function PortSummary({ c }: { c: ContainerRow }) {
  const published = sorted(c.ports).filter((p) => p.publicPort)
  const exposed = sorted(c.ports).filter((p) => !p.publicPort)
  if (!published.length && !exposed.length) return <span className="text-muted">none</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {published.map((p) => (
        <Port key={portLabel(p)} p={p} c={c} />
      ))}
      {exposed.length > 0 && <span className="text-muted">{exposed.map(exposedLabel).join(', ')} (not published)</span>}
    </span>
  )
}
