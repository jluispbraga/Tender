import type { Engine } from './engine/engine'
import * as resources from './tools/resources'

// Things worth interrupting for, even with the window closed to the tray:
// a container killed for running out of memory, one stuck restarting, and
// WSL holding disk space Docker no longer uses. Each alert lands in
// Notifications and, when Tender isn't in front, as a system notification.

type Notify = (n: { kind: 'info' | 'error'; title: string; body?: string; objectType?: string; objectId?: string }) => void

const LOOP_COUNT = 3
const LOOP_WINDOW = 3 * 60_000
const LOOP_COOLDOWN = 10 * 60_000
const DISK_EVERY = 30 * 60_000
const DISK_SLACK = 10e9
const DISK_COOLDOWN = 24 * 3600_000

export function startAlerts(engine: Engine, notify: Notify, enabled: () => boolean, platform = process.platform): () => void {
  const dies = new Map<string, number[]>()
  const lastLoop = new Map<string, number>()
  const lastDisk = new Map<string, number>()

  const offEvents = engine.onContainerSignal((s) => {
    if (!enabled()) return
    if (s.kind === 'oom') {
      notify({
        kind: 'error',
        title: `${s.name} ran out of memory`,
        body: 'The kernel stopped it to free memory. Give it a higher memory limit, or free memory for Docker.',
        objectType: 'container',
        objectId: s.id,
      })
      return
    }
    // A die that the person caused (Stop, Compose down) isn't part of a loop.
    if (s.kind !== 'die' || s.expected) return
    const now = Date.now()
    const recent = [...(dies.get(s.id) ?? []), now].filter((t) => now - t < LOOP_WINDOW)
    dies.set(s.id, recent)
    if (recent.length >= LOOP_COUNT && now - (lastLoop.get(s.id) ?? 0) > LOOP_COOLDOWN) {
      lastLoop.set(s.id, now)
      notify({
        kind: 'error',
        title: `${s.name} keeps restarting`,
        body: `It stopped ${recent.length} times in ${Math.round(LOOP_WINDOW / 60_000)} minutes, last with exit code ${s.exitCode}. Its logs usually say why.`,
        objectType: 'container',
        objectId: s.id,
      })
    }
  })

  let timer: NodeJS.Timeout | undefined
  if (platform === 'win32') {
    const check = async () => {
      if (!enabled()) return
      const r = await resources.status(engine).catch(() => null)
      for (const d of r?.disks ?? []) {
        if (d.usedBytes === undefined) continue
        const slack = d.fileBytes - d.usedBytes
        if (slack > DISK_SLACK && Date.now() - (lastDisk.get(d.distro) ?? 0) > DISK_COOLDOWN) {
          lastDisk.set(d.distro, Date.now())
          notify({
            kind: 'info',
            title: `WSL holds ${(slack / 1e9).toFixed(0)} GB it doesn’t use`,
            body: `${d.distro}’s virtual disk is ${(d.fileBytes / 1e9).toFixed(0)} GB on Windows but only ${(d.usedBytes / 1e9).toFixed(0)} GB is in use. Memory and disk can give the rest back.`,
          })
        }
      }
    }
    timer = setInterval(() => void check(), DISK_EVERY)
    // First look a few minutes after start, not during it.
    setTimeout(() => void check(), 5 * 60_000).unref?.()
  }

  return () => {
    offEvents()
    clearInterval(timer)
  }
}
