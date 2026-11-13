export function Table({ label, head, rows, filter, problemsOnly }: { label: string; head: string[]; rows: React.ReactNode[][]; /** The name search, to say why the table is empty. */ filter?: string; problemsOnly?: boolean }) {
  if (!rows.length) {
    const what = label.toLowerCase()
    return <p className="p-6 text-sm text-muted">{problemsOnly ? `No ${what} with a problem${filter ? ` and “${filter}” in the name` : ''}. Everything here is running.` : filter ? `No ${what} with “${filter}” in the name.` : `No ${what} here.`}</p>
  }
  return (
    <table aria-label={label} className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          {head.map((h, i) => (
            <th key={i} scope="col" className="px-2.5 py-2 font-medium">
              {h || <span className="sr-only">Actions</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line">
            {r.map((cell, j) => (
              <td key={j} className="px-2.5 py-1.5 text-fg">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
