import type { KubeItem, KubeKind, KubeOverview } from '@/api'

/** "1/3": fewer ready than wanted. */
export const short = (ready: string) => {
  const [have, want] = ready.split('/').map(Number)
  return Number.isFinite(have) && Number.isFinite(want) && have < want
}

/** Down, crashing, stuck starting, or running but not ready. A finished pod is fine. */
export const podProblem = (p: KubeOverview['pods'][number]) => (/^(Completed|Succeeded)$/.test(p.status) ? false : p.status !== 'Running' || short(p.ready))

export const deploymentProblem = (d: KubeOverview['deployments'][number]) => short(d.ready)

/** The kinds that have a state to judge; the others are just configuration. */
export const hasStatus = (k: KubeKind) => k === 'statefulsets' || k === 'jobs' || k === 'cronjobs'

export function itemProblem(kind: KubeKind, i: KubeItem): boolean {
  if (kind === 'statefulsets') return short(i.fields.ready)
  if (kind === 'jobs') return i.fields.status === 'Failed'
  if (kind === 'cronjobs') return !!i.suspended
  return false
}
