import type { ContainerRow } from '@/api'
import { CopyButton } from '@/components/ui/copy-button'
import { href } from '@/lib/router'

/** S09: what is mounted where. Named volumes link to their volume page. */
export function MountsTab({ c }: { c: ContainerRow }) {
  if (!c.mounts.length) {
    return <p className="p-5 text-base text-muted">Nothing is mounted. Data written inside this container is lost when it’s removed.</p>
  }
  return (
    <div className="h-full overflow-auto">
      <table className="w-full table-fixed border-collapse text-sm" aria-label={`Mounts of ${c.name}`}>
        <thead className="sticky top-0 bg-surface">
          <tr className="h-8 border-b border-line text-left text-xs text-muted">
            <th className="w-28 px-5 font-medium">Type</th>
            <th className="px-3 font-medium">Source on the host</th>
            <th className="px-3 font-medium">Path in the container</th>
            <th className="w-24 px-3 font-medium">Access</th>
          </tr>
        </thead>
        <tbody>
          {c.mounts.map((m) => (
            <tr key={m.destination} className="h-9 border-b border-line">
              <td className="px-5 text-muted">{m.type === 'bind' ? 'Bind mount' : m.type === 'volume' ? 'Volume' : 'In memory'}</td>
              <td className="truncate px-3 font-mono text-xs" title={m.source}>
                {m.type === 'volume' ? (
                  <a href={href('volumes', m.source, 'containers')} className="text-link underline-offset-2 hover:underline">
                    {m.source}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    {m.source}
                    <CopyButton label={`Copy path ${m.source}`} value={m.source} />
                  </span>
                )}
              </td>
              <td className="truncate px-3 font-mono text-xs" title={m.destination}>
                {m.destination}
              </td>
              <td className="px-3 text-muted">{m.rw ? 'Read/write' : 'Read-only'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
