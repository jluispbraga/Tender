import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// %UserProfile%\.wslconfig: WSL 2's settings for every distribution (memory,
// networking, disk). An INI file. Tender changes single keys and leaves
// everything else, comments included, as the user wrote it. WSL reads it at
// start, so changes apply after `wsl --shutdown`.

export const wslconfigPath = () => join(process.env.USERPROFILE ?? homedir(), '.wslconfig')

export function readWslconfig(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  if (!existsSync(wslconfigPath())) return out
  let section = ''
  for (const raw of readFileSync(wslconfigPath(), 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const s = /^\[(.+)\]$/.exec(line)
    if (s) {
      section = s[1].trim().toLowerCase()
      continue
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line)
    if (kv && section) (out[section] ??= {})[kv[1].trim().toLowerCase()] = kv[2].trim()
  }
  return out
}

/** Sets one key (null removes it), keeping the rest of the file as it is. */
export function setWslconfig(section: string, key: string, value: string | null) {
  const path = wslconfigPath()
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  const want = section.toLowerCase()
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const s = /^\s*\[(.+)\]\s*$/.exec(lines[i])
    if (!s) continue
    if (start >= 0) {
      end = i
      break
    }
    if (s[1].trim().toLowerCase() === want) start = i
  }
  if (start < 0) {
    if (value === null) return
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(`[${section}]`, `${key}=${value}`)
  } else {
    const at = lines.slice(start + 1, end).findIndex((l) => new RegExp(`^\\s*${key}\\s*=`, 'i').test(l))
    if (at >= 0 && value === null) lines.splice(start + 1 + at, 1)
    else if (at >= 0) lines[start + 1 + at] = `${key}=${value}`
    else if (value === null) return
    else {
      // After the section's last non-empty line.
      let insert = end
      while (insert > start + 1 && lines[insert - 1].trim() === '') insert--
      lines.splice(insert, 0, `${key}=${value}`)
    }
  }
  writeFileSync(path, lines.join('\r\n').replace(/(\r\n)*$/, '\r\n'))
}
