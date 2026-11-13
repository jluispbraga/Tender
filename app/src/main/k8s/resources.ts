import * as k8s from '@kubernetes/client-node'
import type { KubeAction, KubeData, KubeEvent, KubeItem, KubeKind, KubeRevision, KubeUsage } from '../../renderer/src/api/types'
import { forContext, quick, reason } from './kube'

// The kinds past pods, deployments and services: listed one tab at a time, so
// a cluster where you may not read secrets still shows everything else.

const iso = (d?: Date | string) => (d ? new Date(d).toISOString() : undefined)
const meta = (m?: k8s.V1ObjectMeta) => ({ name: m?.name ?? '', namespace: m?.namespace ?? '', createdAt: iso(m?.creationTimestamp) })
const images = (s?: k8s.V1PodSpec) => (s?.containers ?? []).map((c) => c.image ?? '').join(', ')

/** How long a job ran, as kubectl shows it: 45s, 3m12s, 2h5m. */
export function duration(from?: Date | string, to?: Date | string): string {
  if (!from) return ''
  const s = Math.max(0, Math.round(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? `${Math.floor((s % 3600) / 60)}m` : ''}`
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600) ? `${Math.floor((s % 86400) / 3600)}h` : ''}`
}

export function jobStatus(j: k8s.V1Job): string {
  const c = j.status?.conditions ?? []
  if (c.some((x) => x.type === 'Complete' && x.status === 'True')) return 'Complete'
  if (c.some((x) => x.type === 'Failed' && x.status === 'True')) return 'Failed'
  if (j.spec?.suspend) return 'Suspended'
  return (j.status?.active ?? 0) > 0 ? 'Running' : 'Pending'
}

const bytes = (v: string) => Buffer.byteLength(v, 'utf8')

export async function list(context: string, namespace: string, kind: KubeKind): Promise<KubeItem[]> {
  const kc = forContext(context)
  const all = namespace === '*'
  const ns = { namespace }
  try {
    switch (kind) {
      case 'statefulsets': {
        const apps = kc.makeApiClient(k8s.AppsV1Api)
        const r = await quick(all ? apps.listStatefulSetForAllNamespaces() : apps.listNamespacedStatefulSet(ns), context)
        return r.items.map((s) => ({
          ...meta(s.metadata),
          replicas: s.spec?.replicas ?? 0,
          fields: { ready: `${s.status?.readyReplicas ?? 0}/${s.spec?.replicas ?? 0}`, images: images(s.spec?.template.spec) },
        }))
      }
      case 'jobs': {
        const batch = kc.makeApiClient(k8s.BatchV1Api)
        const r = await quick(all ? batch.listJobForAllNamespaces() : batch.listNamespacedJob(ns), context)
        return r.items.map((j) => ({
          ...meta(j.metadata),
          fields: {
            status: jobStatus(j),
            completions: `${j.status?.succeeded ?? 0}/${j.spec?.completions ?? 1}`,
            // A failed job has no completionTime; it ended when the Failed condition was set.
            duration: duration(j.status?.startTime, j.status?.completionTime ?? j.status?.conditions?.find((x) => x.type === 'Failed' && x.status === 'True')?.lastTransitionTime),
            owner: j.metadata?.ownerReferences?.find((o) => o.kind === 'CronJob')?.name ?? '',
          },
        }))
      }
      case 'cronjobs': {
        const batch = kc.makeApiClient(k8s.BatchV1Api)
        const r = await quick(all ? batch.listCronJobForAllNamespaces() : batch.listNamespacedCronJob(ns), context)
        return r.items.map((c) => ({
          ...meta(c.metadata),
          suspended: !!c.spec?.suspend,
          fields: {
            schedule: c.spec?.schedule ?? '',
            timeZone: c.spec?.timeZone ?? '',
            active: String(c.status?.active?.length ?? 0),
            lastSchedule: iso(c.status?.lastScheduleTime) ?? '',
          },
        }))
      }
      case 'ingresses': {
        const net = kc.makeApiClient(k8s.NetworkingV1Api)
        const r = await quick(all ? net.listIngressForAllNamespaces() : net.listNamespacedIngress(ns), context)
        return r.items.map((i) => ({
          ...meta(i.metadata),
          fields: {
            class: i.spec?.ingressClassName ?? '',
            hosts: [...new Set((i.spec?.rules ?? []).map((x) => x.host ?? '*'))].join(', ') || '*',
            address: (i.status?.loadBalancer?.ingress ?? []).map((x) => x.ip ?? x.hostname ?? '').filter(Boolean).join(', '),
            ports: i.spec?.tls?.length ? '80, 443' : '80',
          },
        }))
      }
      case 'configmaps': {
        const core = kc.makeApiClient(k8s.CoreV1Api)
        const r = await quick(all ? core.listConfigMapForAllNamespaces() : core.listNamespacedConfigMap(ns), context)
        return r.items.map((c) => {
          const keys = [...Object.keys(c.data ?? {}), ...Object.keys(c.binaryData ?? {})]
          return { ...meta(c.metadata), fields: { keys: keys.join(', '), count: String(keys.length) } }
        })
      }
      case 'secrets': {
        const core = kc.makeApiClient(k8s.CoreV1Api)
        const r = await quick(all ? core.listSecretForAllNamespaces() : core.listNamespacedSecret(ns), context)
        // Only names leave this function: the list carries every value, and none of them is shown.
        return r.items.map((s) => {
          const keys = Object.keys(s.data ?? {})
          return { ...meta(s.metadata), fields: { type: s.type ?? 'Opaque', keys: keys.join(', '), count: String(keys.length) } }
        })
      }
    }
  } catch (e) {
    throw new Error(reason(e))
  }
}

export async function data(context: string, namespace: string, kind: 'configmaps' | 'secrets', name: string): Promise<KubeData> {
  const core = forContext(context).makeApiClient(k8s.CoreV1Api)
  try {
    if (kind === 'configmaps') {
      const c = await quick(core.readNamespacedConfigMap({ name, namespace }), context)
      return {
        entries: [
          ...Object.entries(c.data ?? {}).map(([key, value]) => ({ key, bytes: bytes(value), value })),
          ...Object.entries(c.binaryData ?? {}).map(([key, b64]) => ({ key, bytes: Buffer.from(b64, 'base64').length })),
        ].sort((a, b) => a.key.localeCompare(b.key)),
      }
    }
    const s = await quick(core.readNamespacedSecret({ name, namespace }), context)
    return { type: s.type ?? 'Opaque', entries: Object.entries(s.data ?? {}).map(([key, b64]) => ({ key, bytes: Buffer.from(b64, 'base64').length })).sort((a, b) => a.key.localeCompare(b.key)) }
  } catch (e) {
    throw new Error(reason(e))
  }
}

/** A Job name for a manual run, as kubectl create job --from=cronjob would pick it: at most 63 characters. */
export function manualJobName(cronJob: string, now = Date.now()): string {
  const suffix = `-manual-${Math.floor(now / 1000).toString(36)}`
  return cronJob.slice(0, 63 - suffix.length).replace(/-+$/, '') + suffix
}

type MoreAction = Extract<KubeAction, { kind: 'delete' | 'restart-statefulset' | 'run-cronjob' | 'scale-statefulset' | 'suspend-cronjob' | 'rollback-deployment' }>

const singular: Record<KubeKind, string> = { statefulsets: 'StatefulSet', jobs: 'job', cronjobs: 'CronJob', ingresses: 'ingress', configmaps: 'ConfigMap', secrets: 'secret' }

export async function actMore(context: string, a: MoreAction): Promise<string> {
  const kc = forContext(context)
  const apps = kc.makeApiClient(k8s.AppsV1Api)
  const batch = kc.makeApiClient(k8s.BatchV1Api)
  const { name, namespace } = a
  const strategic = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.StrategicMergePatch)
  const merge = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)
  try {
    switch (a.kind) {
      case 'rollback-deployment':
        return await rollback(context, namespace, name, a.revision)
      case 'delete': {
        const core = kc.makeApiClient(k8s.CoreV1Api)
        const net = kc.makeApiClient(k8s.NetworkingV1Api)
        // Background: the pods a StatefulSet, Job or CronJob made go with it, like kubectl delete.
        const bg = { name, namespace, propagationPolicy: 'Background' }
        const del: Record<KubeKind, () => Promise<unknown>> = {
          statefulsets: () => apps.deleteNamespacedStatefulSet(bg),
          jobs: () => batch.deleteNamespacedJob(bg),
          cronjobs: () => batch.deleteNamespacedCronJob(bg),
          ingresses: () => net.deleteNamespacedIngress({ name, namespace }),
          configmaps: () => core.deleteNamespacedConfigMap({ name, namespace }),
          secrets: () => core.deleteNamespacedSecret({ name, namespace }),
        }
        await quick(del[a.resource](), context)
        return `Deleted ${singular[a.resource]} ${name}.`
      }
      case 'restart-statefulset':
        await quick(apps.patchNamespacedStatefulSet({ name, namespace, body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } } }, strategic), context)
        return `Restarting ${name}: its pods are replaced one at a time, highest number first.`
      case 'scale-statefulset':
        await quick(apps.patchNamespacedStatefulSetScale({ name, namespace, body: { spec: { replicas: a.replicas } } }, merge), context)
        return `Scaled ${name} to ${a.replicas} ${a.replicas === 1 ? 'pod' : 'pods'}.`
      case 'suspend-cronjob':
        await quick(batch.patchNamespacedCronJob({ name, namespace, body: { spec: { suspend: a.suspend } } }, merge), context)
        return a.suspend ? `Paused ${name}: no new runs until you resume it.` : `Resumed ${name}: it runs on its schedule again.`
      case 'run-cronjob': {
        // kubectl create job --from=cronjob/NAME: the CronJob's template, owned by it, marked manual.
        const cj = await quick(batch.readNamespacedCronJob({ name, namespace }), context)
        const t = cj.spec?.jobTemplate
        const jobName = manualJobName(name)
        await quick(
          batch.createNamespacedJob({
            namespace,
            body: {
              apiVersion: 'batch/v1',
              kind: 'Job',
              metadata: {
                name: jobName,
                namespace,
                labels: t?.metadata?.labels,
                annotations: { ...(t?.metadata?.annotations ?? {}), 'cronjob.kubernetes.io/instantiate': 'manual' },
                ownerReferences: cj.metadata?.uid ? [{ apiVersion: 'batch/v1', kind: 'CronJob', name, uid: cj.metadata.uid, controller: true }] : undefined,
              },
              spec: t?.spec,
            },
          }),
          context,
        )
        return `Started job ${jobName} from ${name}.`
      }
    }
  } catch (e) {
    throw new Error(reason(e))
  }
}

/** What `kubectl get -o yaml` shows, minus managedFields; a Secret's values are blanked. */
export async function yaml(context: string, kind: 'pods' | 'deployments' | 'services' | KubeKind, namespace: string, name: string): Promise<string> {
  const kc = forContext(context)
  const core = kc.makeApiClient(k8s.CoreV1Api)
  const apps = kc.makeApiClient(k8s.AppsV1Api)
  const batch = kc.makeApiClient(k8s.BatchV1Api)
  const net = kc.makeApiClient(k8s.NetworkingV1Api)
  const at = { name, namespace }
  const read: Record<typeof kind, () => Promise<k8s.KubernetesObject & Record<string, unknown>>> = {
    pods: () => core.readNamespacedPod(at) as never,
    deployments: () => apps.readNamespacedDeployment(at) as never,
    services: () => core.readNamespacedService(at) as never,
    statefulsets: () => apps.readNamespacedStatefulSet(at) as never,
    jobs: () => batch.readNamespacedJob(at) as never,
    cronjobs: () => batch.readNamespacedCronJob(at) as never,
    ingresses: () => net.readNamespacedIngress(at) as never,
    configmaps: () => core.readNamespacedConfigMap(at) as never,
    secrets: () => core.readNamespacedSecret(at) as never,
  }
  try {
    return dumpObject(kind, await quick(read[kind](), context))
  } catch (e) {
    throw new Error(reason(e))
  }
}

const kinds: Record<string, [string, string]> = {
  pods: ['v1', 'Pod'],
  deployments: ['apps/v1', 'Deployment'],
  services: ['v1', 'Service'],
  statefulsets: ['apps/v1', 'StatefulSet'],
  jobs: ['batch/v1', 'Job'],
  cronjobs: ['batch/v1', 'CronJob'],
  ingresses: ['networking.k8s.io/v1', 'Ingress'],
  configmaps: ['v1', 'ConfigMap'],
  secrets: ['v1', 'Secret'],
}

/** Separate from the read so it can be tested: the hiding of secret values is the part that must not break. */
export function dumpObject(kind: string, o: k8s.KubernetesObject & Record<string, unknown>): string {
  const obj = JSON.parse(JSON.stringify(o)) as Record<string, any>
  obj.apiVersion ??= kinds[kind]?.[0]
  obj.kind ??= kinds[kind]?.[1]
  if (obj.metadata) delete obj.metadata.managedFields
  if (kind === 'secrets') {
    for (const field of ['data', 'stringData']) if (obj[field]) for (const k of Object.keys(obj[field])) obj[field][k] = '(hidden)'
    // kubectl apply keeps the whole manifest, values included, in this annotation.
    if (obj.metadata?.annotations?.['kubectl.kubernetes.io/last-applied-configuration']) obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'] = '(hidden: it holds the values)'
  }
  // kubectl's order. Without apiVersion and kind the client dumps the object as
  // it is instead of re-sorting it through its typed models, so those two go on top by hand.
  const { apiVersion, kind: k, metadata, ...rest } = obj
  return `apiVersion: ${apiVersion}\nkind: ${k}\n` + k8s.dumpYaml({ metadata, ...rest })
}

// ---- events, rollouts, usage -----------------------------------------------------------

/** What happened in a namespace (or all), newest first: kubectl get events, the useful part. */
export async function events(context: string, namespace: string): Promise<KubeEvent[]> {
  const core = forContext(context).makeApiClient(k8s.CoreV1Api)
  try {
    const r = await quick(namespace === '*' ? core.listEventForAllNamespaces({ limit: 500 }) : core.listNamespacedEvent({ namespace, limit: 500 }), context)
    return r.items
      .map((e) => ({
        type: e.type ?? 'Normal',
        reason: e.reason ?? '',
        message: (e.message ?? '').trim(),
        kind: e.involvedObject?.kind ?? '',
        name: e.involvedObject?.name ?? '',
        namespace: e.involvedObject?.namespace ?? e.metadata?.namespace ?? '',
        count: e.count ?? e.series?.count ?? 1,
        lastSeen: iso(e.lastTimestamp ?? e.series?.lastObservedTime ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp),
      }))
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
      .slice(0, 300)
  } catch (e) {
    throw new Error(reason(e))
  }
}

/** A deployment's ReplicaSets, newest revision first: kubectl rollout history. */
export async function rollouts(context: string, namespace: string, name: string): Promise<KubeRevision[]> {
  const apps = forContext(context).makeApiClient(k8s.AppsV1Api)
  try {
    const d = await quick(apps.readNamespacedDeployment({ name, namespace }), context)
    const selector = Object.entries(d.spec?.selector?.matchLabels ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    const rs = await quick(apps.listNamespacedReplicaSet({ namespace, labelSelector: selector }), context)
    const current = d.metadata?.annotations?.['deployment.kubernetes.io/revision']
    return rs.items
      .filter((r) => r.metadata?.ownerReferences?.some((o) => o.uid === d.metadata?.uid))
      .map((r) => {
        const revision = Number(r.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0)
        return {
          revision,
          current: String(revision) === current,
          images: (r.spec?.template?.spec?.containers ?? []).map((c) => c.image ?? ''),
          changeCause: r.metadata?.annotations?.['kubernetes.io/change-cause'],
          createdAt: iso(r.metadata?.creationTimestamp),
          pods: r.status?.replicas ?? 0,
        }
      })
      .sort((a, b) => b.revision - a.revision)
  } catch (e) {
    throw new Error(reason(e))
  }
}

/** kubectl rollout undo --to-revision: the deployment takes that ReplicaSet's pod template back. */
export async function rollback(context: string, namespace: string, name: string, revision: number): Promise<string> {
  const apps = forContext(context).makeApiClient(k8s.AppsV1Api)
  try {
    const d = await quick(apps.readNamespacedDeployment({ name, namespace }), context)
    const rs = await quick(apps.listNamespacedReplicaSet({ namespace }), context)
    const target = rs.items.find((r) => r.metadata?.ownerReferences?.some((o) => o.uid === d.metadata?.uid) && r.metadata?.annotations?.['deployment.kubernetes.io/revision'] === String(revision))
    if (!target?.spec?.template) throw new Error(`${name} has no revision ${revision} any more.`)
    const template = JSON.parse(JSON.stringify(target.spec.template)) as k8s.V1PodTemplateSpec
    // The ReplicaSet's own label; the deployment adds the right one itself.
    if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash']
    await quick(apps.patchNamespacedDeployment({ name, namespace, body: [{ op: 'replace', path: '/spec/template', value: template }] }, k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch)), context)
    return `Rolling ${name} back to revision ${revision}: ${(template.spec?.containers ?? []).map((c) => c.image).join(', ')}.`
  } catch (e) {
    throw new Error(reason(e))
  }
}

/** "250m" or "123456789n" → millicores. */
export function cpuMilli(q: string): number {
  const m = /^([\d.]+)([numk]?)$/.exec(q.trim())
  if (!m) return 0
  const v = Number(m[1])
  return { n: v / 1e6, u: v / 1e3, m: v, k: v * 1e6, '': v * 1000 }[m[2] as 'n' | 'u' | 'm' | 'k' | '']
}

/** "34Mi", "1Gi", "512000Ki", "1048576" → bytes. */
export function memBytes(q: string): number {
  const m = /^([\d.]+)([KMGTP]i?|[kmgtp]?)$/.exec(q.trim())
  if (!m) return 0
  const pow: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50 }
  return Number(m[1]) * (pow[m[2]] ?? 1)
}

/** CPU and memory per pod from metrics-server; null when the cluster has none. */
export async function podUsage(context: string, namespace: string): Promise<KubeUsage | null> {
  const metrics = new k8s.Metrics(forContext(context))
  try {
    const r = await quick(metrics.getPodMetrics(namespace === '*' ? undefined : namespace), context)
    const out: KubeUsage = {}
    for (const p of r.items) {
      out[`${p.metadata.namespace}/${p.metadata.name}`] = {
        cpuMilli: Math.round(p.containers.reduce((n, c) => n + cpuMilli(c.usage.cpu), 0)),
        memoryBytes: p.containers.reduce((n, c) => n + memBytes(c.usage.memory), 0),
      }
    }
    return out
  } catch {
    // No metrics-server, or one still starting (it answers 404/503 or plain text for a
    // minute): no numbers, not an error. A cluster that is down shows on the rest of the page.
    return null
  }
}
