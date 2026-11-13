export function Table({ label, head, rows }: { label: string; head: string[]; rows: React.ReactNode[][] }) {
  if (!rows.length) return <p className="p-6 text-sm text-muted">No {label.toLowerCase()} here.</p>
  return (
    <table aria-label={label} className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          {head.map((h, i) => (
            <th key={i} scope="col" className="px-3 py-2 font-medium">
              {h || <span className="sr-only">Actions</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line">
            {r.map((cell, j) => (
              <td key={j} className="px-3 py-1.5 text-fg">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
