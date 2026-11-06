import type { ContainerRow } from '@/api'
import { StatusChip } from '@/components/ui/status-chip'

/** Exit codes left by a deliberate stop (Ctrl+C, SIGKILL after the stop timeout, SIGTERM), not by a crash. */
export const STOP_CODES = new Set([130, 137, 143])

/** Maps engine state to the chip. A non-zero exit that wasn't a stop shows as Failed with its code. */
export function ContainerStatus({ c }: { c: ContainerRow }) {
  switch (c.state) {
    case 'running':
      return <StatusChip status="running" />
    case 'paused':
      return <StatusChip status="paused" />
    case 'restarting':
      return <StatusChip status="restarting" />
    case 'created':
      return <StatusChip status="created" />
    case 'dead':
      return <StatusChip status="error" />
    default:
      if (!c.exitCode) return <StatusChip status="exited" />
      return STOP_CODES.has(c.exitCode) ? <StatusChip status="exited" detail={String(c.exitCode)} /> : <StatusChip status="error" detail={String(c.exitCode)} />
  }
}
