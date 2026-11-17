import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, posix } from 'node:path'
import type { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { ApiError, type ContainerChange, type FileEntry, type FileListing } from '../../renderer/src/api/types'

// Files inside a container: list a folder, download, upload, and what changed
// against the image. Listing asks the container's own `stat` when it has a
// shell; distroless and stopped containers are read through the engine's
// archive API instead, which needs nothing inside the container.

const MAX_LIST = 2000
/** Reading a folder as a tar walks everything under it: stop early on big trees. */
const MAX_TAR_BYTES = 256 * 1024 * 1024
const MAX_DOWNLOAD = 2 * 1024 * 1024 * 1024
const MAX_UPLOAD = 512 * 1024 * 1024

export const normalise = (p: string) => posix.normalize('/' + p.replace(/\\/g, '/')).replace(/\/+$/, '') || '/'

async function execStat(c: Docker.Container, dir: string): Promise<FileEntry[] | null> {
  // One line per entry: type|size|mtime|name. BusyBox and GNU stat both take -c.
  const script = 'cd -- "$1" 2>/dev/null || exit 3; for f in .* *; do [ "$f" = . ] || [ "$f" = .. ] || { [ -e "$f" ] || [ -L "$f" ]; } && stat -c "%F|%s|%Y|%n" -- "$f"; done'
  try {
    const ex = await c.exec({ Cmd: ['sh', '-c', script, 'sh', dir], AttachStdout: true, AttachStderr: true })
    const stream = (await ex.start({ hijack: true, stdin: false })) as unknown as Readable
    const out: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      // Multiplexed: 8-byte frame headers; stdout frames have type 1.
      let buf = Buffer.alloc(0)
      stream.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        while (buf.length >= 8) {
          const len = buf.readUInt32BE(4)
          if (buf.length < 8 + len) break
          if (buf[0] === 1) out.push(buf.subarray(8, 8 + len))
          buf = buf.subarray(8 + len)
        }
      })
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    const info = await ex.inspect()
    if (info.ExitCode === 3) throw new ApiError(`${dir} isn’t a folder in this container.`, 404)
    if (info.ExitCode !== 0 && !out.length) return null
    return Buffer.concat(out)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [type, size, mtime, ...name] = l.split('|')
        return {
          name: name.join('|'),
          type: /directory/.test(type) ? 'dir' : /symbolic link/.test(type) ? 'link' : /regular/.test(type) ? 'file' : 'other',
          size: Number(size) || 0,
          modifiedAt: new Date(Number(mtime) * 1000).toISOString(),
        } satisfies FileEntry
      })
  } catch (e) {
    if (e instanceof ApiError) throw e
    return null
  }
}

/** Minimal tar reading: ustar headers, GNU long names (L) and pax paths (x). */
export function* tarEntries(buf: Buffer): Generator<{ name: string; type: string; size: number; mtime: number; data: Buffer; linkname: string }> {
  let off = 0
  let longName: string | null = null
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every((b) => b === 0)) return
    const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(str(124, 12).trim() || '0', 8)
    const type = str(156, 1) || '0'
    const prefix = str(345, 155)
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100))
    longName = null
    const data = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      if (m) longName = m[1]
      continue
    }
    if (type === 'g') continue
    yield { name, type, size, mtime: parseInt(str(136, 12).trim() || '0', 8), data, linkname: str(157, 100) }
  }
}

/** One regular file as a tar, for putArchive. Names over 100 bytes use a GNU long-name entry. */
export function tarOf(files: { name: string; data: Buffer; mode?: number }[]): Buffer {
  const blocks: Buffer[] = []
  const header = (name: string, size: number, type: string, mode: number) => {
    const h = Buffer.alloc(512, 0)
    h.write(name.slice(0, 100), 0, 'utf8')
    h.write(mode.toString(8).padStart(7, '0') + '\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(size.toString(8).padStart(11, '0') + '\0', 124)
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136)
    h.write('        ', 148)
    h.write(type, 156)
    h.write('ustar\0', 257)
    h.write('00', 263)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return h
  }
  const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512, 0)
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    if (nameBuf.length > 100) blocks.push(header('././@LongLink', nameBuf.length + 1, 'L', 0o644), nameBuf, Buffer.from([0]), pad(nameBuf.length + 1))
    blocks.push(header(f.name, f.data.length, '0', f.mode ?? 0o644), f.data, pad(f.data.length))
  }
  blocks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(blocks)
}

async function readStream(s: Readable, limit: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  await new Promise<void>((resolve, reject) => {
    s.on('data', (c: Buffer) => {
      chunks.push(c)
      total += c.length
      if (total > limit) {
        truncated = true
        s.destroy()
        resolve()
      }
    })
    s.on('end', resolve)
    s.on('close', resolve)
    s.on('error', (e) => (truncated ? resolve() : reject(e)))
  })
  return { buf: Buffer.concat(chunks), truncated }
}

async function tarList(c: Docker.Container, dir: string): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  let s: Readable
  try {
    s = (await c.getArchive({ path: dir })) as unknown as Readable
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    if (status === 404) throw new ApiError(`${dir} doesn’t exist in this container.`, 404)
    throw e
  }
  const { buf, truncated } = await readStream(s, MAX_TAR_BYTES)
  const seen = new Map<string, FileEntry>()
  const root = dir === '/' ? '' : basename(dir)
  for (const e of tarEntries(buf)) {
    // Names are relative to the folder's parent: "app/src/x.js" for /app.
    const rel = e.name.replace(/^\.?\//, '').replace(/\/$/, '')
    const inside = root ? (rel === root ? '' : rel.startsWith(root + '/') ? rel.slice(root.length + 1) : null) : rel
    if (!inside) continue
    const [first, ...rest] = inside.split('/')
    if (rest.length) {
      if (!seen.has(first)) seen.set(first, { name: first, type: 'dir', size: 0, modifiedAt: new Date(e.mtime * 1000).toISOString() })
      continue
    }
    seen.set(first, { name: first, type: e.type === '5' ? 'dir' : e.type === '2' ? 'link' : e.type === '0' || e.type === '7' ? 'file' : 'other', size: e.size, modifiedAt: new Date(e.mtime * 1000).toISOString() })
    if (seen.size >= MAX_LIST) break
  }
  return { entries: [...seen.values()], truncated }
}

export async function list(d: Docker, id: string, rawPath: string): Promise<FileListing> {
  const path = normalise(rawPath)
  const c = d.getContainer(id)
  const info = await c.inspect()
  let entries = info.State.Running && !info.State.Paused ? await execStat(c, path) : null
  let truncated = false
  let via: FileListing['via'] = 'exec'
  if (!entries) {
    const t = await tarList(c, path)
    entries = t.entries
    truncated = t.truncated
    via = 'archive'
  }
  entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
  return { path, entries: entries.slice(0, MAX_LIST), truncated: truncated || entries.length > MAX_LIST, via }
}

/** Saves a file as itself, a folder as a .tar. Returns where it went, or null if the person cancelled. */
export async function download(d: Docker, id: string, rawPath: string, isDir: boolean, choose: (defaultName: string, folder: boolean) => Promise<string | null>): Promise<string | null> {
  const path = normalise(rawPath)
  if (path === '/') throw new ApiError('Download a folder inside the container, not all of it.', 400)
  const c = d.getContainer(id)
  const target = await choose(isDir ? `${basename(path)}.tar` : basename(path), isDir)
  if (!target) return null
  let s: Readable
  try {
    s = (await c.getArchive({ path })) as unknown as Readable
  } catch (e) {
    throw new ApiError((e as { statusCode?: number }).statusCode === 404 ? `${path} doesn’t exist in this container.` : 'The engine couldn’t read that path.', (e as { statusCode?: number }).statusCode)
  }
  const { buf, truncated } = await readStream(s, MAX_DOWNLOAD)
  if (truncated) throw new ApiError('That is over 2 GB. Use docker cp for something this big.', 413)
  if (isDir) writeFileSync(target, buf)
  else {
    const first = tarEntries(buf).next().value
    if (!first) throw new ApiError('The engine sent an empty archive.', 502)
    writeFileSync(target, first.data)
  }
  return target
}

export async function upload(d: Docker, id: string, rawDir: string, files: string[]): Promise<number> {
  const dir = normalise(rawDir)
  let total = 0
  const entries = files.map((f) => {
    const size = statSync(f).size
    total += size
    if (total > MAX_UPLOAD) throw new ApiError('That is over 512 MB. Use docker cp, or a volume, for something this big.', 413)
    return { name: basename(f), data: readFileSync(f) }
  })
  try {
    await d.getContainer(id).putArchive(tarOf(entries), { path: dir })
  } catch (e) {
    const err = e as { statusCode?: number; json?: { message?: string } }
    if (err.statusCode === 403) throw new ApiError(`${dir} is read-only in this container.`, 403)
    if (err.statusCode === 404) throw new ApiError(`${dir} doesn’t exist in this container.`, 404)
    throw new ApiError(err.json?.message ?? 'The engine refused the upload.', err.statusCode)
  }
  return entries.length
}

export async function changes(d: Docker, id: string): Promise<ContainerChange[]> {
  const list = ((await d.getContainer(id).changes()) ?? []) as { Path: string; Kind: number }[]
  return list.map((x) => ({ path: x.Path, kind: x.Kind === 1 ? 'added' : x.Kind === 2 ? 'deleted' : 'changed' }) satisfies ContainerChange).sort((a, b) => a.path.localeCompare(b.path))
}
