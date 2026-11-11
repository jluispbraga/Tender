import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as k8s from '@kubernetes/client-node'
import type { KubeConfigProblem, KubeContext, KubeOverview } from '../../renderer/src/api/types'

// A read-only view of the clusters in the user's kubeconfig (kind, k3d,
// minikube, or anything else kubectl can reach). Tender lists and reads logs;
// it never creates, deletes, scales or edits anything, so pointing it at a
// production context cannot change that cluster.

function load(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig()
  // KUBECONFIG wins, like kubectl. Otherwise read ~/.kube/config from the real
  // home folder: the client trusts $HOME first, which some shells on Windows
  // set to a path Windows can't open (/c/Users/...).
  const own = join((process.platform === 'win32' && process.env.USERPROFILE) || homedir(), '.kube', 'config')
  if (!process.env.KUBECONFIG && existsSync(own)) kc.loadFromFile(own)
  else kc.loadFromDefault()
  return kc
}

function forContext(name: string): k8s.KubeConfig {
  const kc = load()
  if (!kc.getContextObject(name)) throw new Error(`No context called ${name} in your kubeconfig.`)
  kc.setCurrentContext(name)
  return kc
}

/** Fails fast on a cluster that is not running, instead of the client's long default. */
async function quick<T>(p: Promise<T>, what: string, ms = 6000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s. Is the cluster running?`)), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

const reason = (e: unknown) => {
  const err = e as { body?: { message?: string } | string; code?: string; message?: string }
  const body = typeof err.body === 'string' ? (() => { try { return JSON.parse(err.body as string).message } catch { return err.body } })() : err.body?.message
  return String(body ?? err.message ?? e)
}

export function contexts(): KubeContext[] {
  let kc: k8s.KubeConfig
  try {
    kc = load()
  } catch (e) {
    console.error('[tender] kubeconfig:', e)
    return []
  }
  const current = kc.getCurrentContext()
  return kc.getContexts().map((c) => ({ name: c.name, cluster: c.cluster, server: kc.getCluster(c.cluster)?.server ?? '', namespace: c.namespace ?? 'default', current: c.name === current }))
}

/**
 * Why the kubeconfig gives no usable context, when it has something to say: a file
 * that does not parse, or clusters with no context pointing at them. The common case
 * is minikube or kind after the cluster was deleted or the file was edited by hand.
 */
export function configProblem(): KubeConfigProblem | null {
  const path = process.env.KUBECONFIG || join((process.platform === 'win32' && process.env.USERPROFILE) || homedir(), '.kube', 'config')
  let kc: k8s.KubeConfig
  try {
    kc = load()
  } catch (e) {
    return { path, problem: `Your kubeconfig could not be read: ${reason(e)}`, hint: 'Fix or remove the file, then refresh.' }
  }
  if (kc.getContexts().length) return null
  const clusters = kc.getClusters()
  if (!clusters.length) return null
  const current = kc.getCurrentContext()
  const names = clusters.map((c) => c.name)
  const user = kc.getUsers()[0]?.name
  const first = names[0]
  const hint = names.includes('minikube')
    ? 'Run minikube start: it starts the cluster and writes its context again.'
    : first.startsWith('kind-')
      ? `Run kind export kubeconfig --name ${first.slice(5)} if that kind cluster still exists, or create it again with kind create cluster.`
      : `Recreate the context with kubectl config set-context ${current || first} --cluster ${first}${user ? ` --user ${user}` : ''}, then kubectl config use-context ${current || first}.`
  return {
    path,
    problem: `Your kubeconfig lists the cluster${names.length > 1 ? 's' : ''} ${names.join(', ')} but no context to reach ${names.length > 1 ? 'them' : 'it'}${current ? `, and its current context “${current}” does not exist` : ''}. kubectl cannot use it either.`,
    hint,
  }
}

export async function namespaces(context: string): Promise<string[]> {
  const core = forContext(context).makeApiClient(k8s.CoreV1Api)
  try {
    const r = await quick(core.listNamespace(), context)
    return r.items.map((n) => n.metadata?.name ?? '').filter(Boolean).sort()
  } catch (e) {
    throw new Error(reason(e))
  }
}

const age = (d?: Date | string) => (d ? new Date(d).toISOString() : undefined)

/** Pods, deployments and services of one namespace, or of all of them ('*'). */
export async function overview(context: string, namespace: string): Promise<KubeOverview> {
  const kc = forContext(context)
  const core = kc.makeApiClient(k8s.CoreV1Api)
  const apps = kc.makeApiClient(k8s.AppsV1Api)
  const all = namespace === '*'
  try {
    const [pods, deps, svcs] = await quick(
      Promise.all([
        all ? core.listPodForAllNamespaces() : core.listNamespacedPod({ namespace }),
        all ? apps.listDeploymentForAllNamespaces() : apps.listNamespacedDeployment({ namespace }),
        all ? core.listServiceForAllNamespaces() : core.listNamespacedService({ namespace }),
      ]),
      context,
    )
    return {
      pods: pods.items.map((p) => {
        const cs = p.status?.containerStatuses ?? []
        const waiting = cs.find((c) => c.state?.waiting)?.state?.waiting?.reason
        return {
          name: p.metadata?.name ?? '',
          namespace: p.metadata?.namespace ?? '',
          // What kubectl get pods shows: a waiting reason (CrashLoopBackOff...) wins over the phase.
          status: p.metadata?.deletionTimestamp ? 'Terminating' : (waiting ?? p.status?.phase ?? 'Unknown'),
          ready: `${cs.filter((c) => c.ready).length}/${p.spec?.containers.length ?? cs.length}`,
          restarts: cs.reduce((n, c) => n + (c.restartCount ?? 0), 0),
          node: p.spec?.nodeName,
          containers: p.spec?.containers.map((c) => c.name) ?? [],
          createdAt: age(p.metadata?.creationTimestamp),
        }
      }),
      deployments: deps.items.map((d) => ({
        name: d.metadata?.name ?? '',
        namespace: d.metadata?.namespace ?? '',
        ready: `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 0}`,
        upToDate: d.status?.updatedReplicas ?? 0,
        images: d.spec?.template.spec?.containers.map((c) => c.image ?? '') ?? [],
        createdAt: age(d.metadata?.creationTimestamp),
      })),
      services: svcs.items.map((s) => ({
        name: s.metadata?.name ?? '',
        namespace: s.metadata?.namespace ?? '',
        type: s.spec?.type ?? 'ClusterIP',
        clusterIP: s.spec?.clusterIP ?? '',
        ports: (s.spec?.ports ?? []).map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`),
      })),
    }
  } catch (e) {
    throw new Error(reason(e))
  }
}

/** Follows a pod container's log; returns a function that stops it. */
export function followLogs(context: string, namespace: string, pod: string, container: string, tail: number, onLines: (lines: string[]) => void, onError: (message: string) => void): () => void {
  const out = new PassThrough()
  let buf = ''
  out.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    if (lines.length) onLines(lines)
  })
  let abort: AbortController | null = null
  let stopped = false
  new k8s.Log(forContext(context))
    .log(namespace, pod, container, out, { follow: true, tailLines: tail, timestamps: false })
    .then((a) => {
      abort = a
      if (stopped) a.abort()
    })
    .catch((e) => onError(reason(e)))
  return () => {
    stopped = true
    abort?.abort()
    out.destroy()
  }
}
