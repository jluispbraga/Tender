import { createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import type Docker from 'dockerode'
import { ApiError } from '../../renderer/src/api/types'

// Volume backups as .tar.gz files. A helper container is created with the
// volume mounted but never started: the engine's archive API reads and writes
// the volume through it, so nothing runs and the volume's own containers
// aren't touched.

const HELPER_IMAGE = 'busybox:1.36'

async function ensureImage(d: Docker) {
  if (await d.getImage(HELPER_IMAGE).inspect().catch(() => null)) return
  const s = (await d.pull(HELPER_IMAGE)) as unknown as Readable
  await new Promise<void>((resolve, reject) => d.modem.followProgress(s, (err: unknown) => (err ? reject(err) : resolve())))
}

async function withHelper<T>(d: Docker, volume: string, readOnly: boolean, f: (c: Docker.Container) => Promise<T>): Promise<T> {
  await ensureImage(d)
  const c = await d.createContainer({
    Image: HELPER_IMAGE,
    Cmd: ['true'],
    Labels: { 'io.github.tender.helper': 'snapshot' },
    HostConfig: { Binds: [`${volume}:/data${readOnly ? ':ro' : ''}`] },
  })
  try {
    return await f(c)
  } finally {
    await c.remove({ force: true }).catch(() => undefined)
  }
}

/** Writes the volume's files to `file` as a gzipped tar. Entries start with data/. */
export async function exportVolume(d: Docker, volume: string, file: string): Promise<number> {
  await d
    .getVolume(volume)
    .inspect()
    .catch(() => {
      throw new ApiError(`There is no volume called ${volume}.`, 404)
    })
  return withHelper(d, volume, true, async (c) => {
    const tar = (await c.getArchive({ path: '/data' })) as unknown as Readable
    try {
      await pipeline(tar, createGzip({ level: 6 }), createWriteStream(file))
    } catch (e) {
      try {
        unlinkSync(file)
      } catch {
        // Nothing was written.
      }
      throw new ApiError(`Couldn’t write the backup: ${(e as Error).message}`)
    }
    return statSync(file).size
  })
}

/** The first entry's name: Tender's own backups start with data/, other tars may not. */
async function firstEntry(file: string, gz: boolean): Promise<string> {
  const src = createReadStream(file)
  const s: Readable = gz ? src.pipe(createGunzip()) : src
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    const done = (name: string) => {
      src.destroy()
      s.destroy()
      resolve(name)
    }
    s.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c])
      if (buf.length >= 512) done(buf.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''))
    })
    s.on('error', () => done(''))
    s.on('end', () => done(''))
  })
}

/**
 * Copies a backup into a volume, creating the volume if needed. Files with
 * the same name are replaced; others stay. Refused while a running
 * container uses the volume: a database copied under its feet breaks.
 */
export async function restoreVolume(d: Docker, volume: string, file: string): Promise<void> {
  const gz = /\.(tgz|gz)$/i.test(file)
  const running = await d.listContainers({ filters: { volume: [volume], status: ['running', 'paused', 'restarting'] } })
  if (running.length) {
    const names = running.map((c) => (c.Names?.[0] ?? c.Id).replace(/^\//, ''))
    throw new ApiError(`${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} using ${volume}. Stop ${names.length === 1 ? 'it' : 'them'} first, then restore.`, 409)
  }
  const first = await firstEntry(file, gz)
  if (!first) throw new ApiError('That file isn’t a tar archive, or it is empty.', 400)
  // Tender's backups hold data/…; put them at /. Anything else goes into /data.
  const into = /^(\.\/)?data(\/|$)/.test(first) ? '/' : '/data'
  if (!(await d.getVolume(volume).inspect().catch(() => null))) await d.createVolume({ Name: volume })
  await withHelper(d, volume, false, async (c) => {
    const src = createReadStream(file)
    await c.putArchive(gz ? src.pipe(createGunzip()) : src, { path: into }).catch((e: { json?: { message?: string } }) => {
      throw new ApiError(e.json?.message ?? 'The engine refused the archive.', 422)
    })
  })
}
