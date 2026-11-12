import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as k8s from '@kubernetes/client-node'
import type { KubeAction, KubeConfigProblem, KubeContext, KubeEnv, KubeOverview, KubeSourceReport } from '../../renderer/src/api/types'

// A view of the clusters in the user's kubeconfig (kind, k3d, minikube, or
// anything else kubectl can reach): pods, deployments, services and pod logs,
// plus the everyday actions a developer reaches for (restart, scale, delete).
// Nothing changes a cluster without an explicit click and, for deletes, a
// confirmation that names the context.

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

const kubeDir = () => join((process.platform === 'win32' && process.env.USERPROFILE) || homedir(), '.kube')

/** Extra kubeconfig files and folders the user added in Settings › Kubernetes. */
let extra: string[] = []
export function setKubeSources(paths: string[]) {
  extra = paths
}

const looksLikeKubeconfig = (f: string) => {
  try {
    const st = statSync(f)
    if (!st.isFile() || st.size > 1_000_000) return false
    const text = readFileSync(f, 'utf8')
    return /^clusters:/m.test(text) && /^contexts:/m.test(text)
  } catch {
    return false
  }
}

/** The kubeconfig files in a folder (not its subfolders), skipping backups and editor leftovers. */
function filesIn(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  return names.filter((n) => !n.startsWith('.') && !/\.(bak|old|orig|lock|tmp|swp|log)$/i.test(n)).map((n) => join(dir, n)).filter(looksLikeKubeconfig)
}

/** The files behind one configured path: the file itself, or the kubeconfigs in the folder. */
function expand(path: string): string[] {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return []
  return st.isDirectory() ? filesIn(path) : [path]
}

/**
 * Every kubeconfig file to read, in order: KUBECONFIG's list (like kubectl) or
 * ~/.kube/config, then what the user added in Settings. Nothing else is read,
 * so a production kubeconfig only shows up when someone adds it on purpose.
 */
/** The files kubectl itself reads: KUBECONFIG's list, or ~/.kube/config. */
const baseFiles = () => (process.env.KUBECONFIG ? process.env.KUBECONFIG.split(delimiter).filter((f) => f && existsSync(f)) : [join(kubeDir(), 'config')].filter((f) => existsSync(f)))

function sources(): string[] {
  const base = baseFiles()
  const seen = new Set(base.map((f) => f.toLowerCase()))
  const out = [...base]
  for (const f of extra.flatMap(expand)) {
    if (seen.has(f.toLowerCase())) continue
    seen.add(f.toLowerCase())
    out.push(f)
  }
  return out
}

/** For Settings: what each configured path brings in, so a wrong pick is visible right away. */
export function sourceReport(): KubeSourceReport {
  const describe = (file: string) => {
    const kc = new k8s.KubeConfig()
    try {
      kc.loadFromFile(file)
      return { file, contexts: kc.getContexts().map((c) => c.name) }
    } catch (e) {
      return { file, contexts: [], error: `Could not read it: ${reason(e)}` }
    }
  }
  const base = process.env.KUBECONFIG ? process.env.KUBECONFIG.split(delimiter).filter(Boolean) : [join(kubeDir(), 'config')]
  return {
    base: base.map((f) => (existsSync(f) ? describe(f) : { file: f, contexts: [], error: 'Not there.' })),
    fromEnv: !!process.env.KUBECONFIG,
    added: extra.map((path) => {
      const st = statSync(path, { throwIfNoEntry: false })
      if (!st) return { path, folder: false, files: [], error: 'Not there any more.' }
      const files = expand(path).map(describe)
      return { path, folder: st.isDirectory(), files, error: st.isDirectory() && !files.length ? 'No kubeconfig files in this folder.' : undefined }
    }),
  }
}

/** Opens the system picker in ~/.kube. Returns the chosen path, or null. */
export async function pickSource(kind: 'file' | 'folder'): Promise<string | null> {
  const { dialog } = await import('electron')
  const r = await dialog.showOpenDialog({
    title: kind === 'file' ? 'Add a kubeconfig file' : 'Add a folder of kubeconfig files',
    defaultPath: existsSync(kubeDir()) ? kubeDir() : homedir(),
    properties: [kind === 'file' ? 'openFile' : 'openDirectory', 'showHiddenFiles'],
  })
  return r.canceled ? null : (r.filePaths[0] ?? null)
}

interface Entry {
  /** Unique across files: the context name, plus the file name when two files reuse it. */
  id: string
  name: string
  file: string
  kc: k8s.KubeConfig
}

function entries(): Entry[] {
  const out: Entry[] = []
  for (const file of sources()) {
    const kc = new k8s.KubeConfig()
    try {
      kc.loadFromFile(file)
    } catch (e) {
      console.error('[tender] kubeconfig', file, e)
      continue
    }
    for (const c of kc.getContexts()) {
      const id = out.some((x) => x.id === c.name) ? `${c.name} (${basename(file)})` : c.name
      out.push({ id, name: c.name, file, kc })
    }
  }
  return out
}

function forContext(id: string): k8s.KubeConfig {
  const e = entries().find((x) => x.id === id)
  if (!e) throw new Error(`No context called ${id} in your kubeconfig files.`)
  e.kc.setCurrentContext(e.name)
  return e.kc
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

/** "flake-prod-kubeconfig", "kubeconfig-qa.yaml" → "flake-prod", "qa". */
export const fileStem = (file: string) =>
  basename(file)
    .replace(/\.(ya?ml|conf|config|json)$/i, '')
    .replace(/(^|[-_.])kubeconfig([-_.]|$)/i, (_m, a: string, b: string) => (a && b ? a : ''))
    .trim()

/** Tender's guess at what a cluster is for, from its names and address. The user can override it. */
export function guessEnv(...hints: string[]): KubeEnv | undefined {
  const h = hints.join(' ').toLowerCase()
  if (/(^|[^a-z])(prod|prd|production|producao|produção)([^a-z]|$)/.test(h)) return 'prod'
  if (/(^|[^a-z])(qa|stg|stage|staging|hml|homolog|homologacao|homologação|uat)([^a-z]|$)/.test(h)) return 'qa'
  if (/(^|[^a-z])(dev|develop|development|desenv)([^a-z]|$)/.test(h)) return 'dev'
  if (/minikube|(^|[^a-z])(kind|k3d|k3s)-|docker-desktop|rancher-desktop|orbstack|127\.0\.0\.1|localhost|\[::1\]/.test(h)) return 'local'
  return undefined
}

export function contexts(): KubeContext[] {
  const all = entries()
  // The current context is the first file's (~/.kube/config), like kubectl.
  // kubectl's own files keep their context names; added files are named after the file.
  const base = new Set(baseFiles().map((f) => f.toLowerCase()))
  const first = all.find((e) => base.has(e.file.toLowerCase()))
  const current = first?.kc.getCurrentContext()
  return all.map((e) => {
    const c = e.kc.getContextObject(e.name)!
    const server = e.kc.getCluster(c.cluster)?.server ?? ''
    // Added files are usually one per cluster with a default context name (microk8s,
    // default, admin@k8s): the file name is what tells them apart.
    const stem = base.has(e.file.toLowerCase()) ? '' : fileStem(e.file)
    const inFile = e.kc.getContexts().length
    const defaultLabel = !stem ? e.name : inFile > 1 ? `${stem} / ${e.name}` : stem
    return {
      name: e.id,
      context: e.name,
      key: `${e.file.toLowerCase()}#${e.name}`,
      defaultLabel,
      // The file and context names say the most; the folder (~/.kube/prod/...) only when they say nothing.
      guessedEnv: guessEnv(stem, e.name, c.cluster, server) ?? guessEnv(e.file.slice(0, -basename(e.file).length)),
      cluster: c.cluster,
      server,
      namespace: c.namespace ?? 'default',
      current: e.file === first?.file && e.name === current,
      file: e.file,
    }
  })
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
        // A container that just exited (Error, OOMKilled, Completed), as kubectl shows it.
        const terminated = cs.find((c) => c.state?.terminated)?.state?.terminated?.reason
        return {
          name: p.metadata?.name ?? '',
          namespace: p.metadata?.namespace ?? '',
          // What kubectl get pods shows: a waiting reason (CrashLoopBackOff...) wins over the phase.
          status: p.metadata?.deletionTimestamp ? 'Terminating' : (waiting ?? terminated ?? p.status?.phase ?? 'Unknown'),
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
        replicas: d.spec?.replicas ?? 0,
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

/**
 * Follows a pod container's log; returns a function that stops it. With `previous`,
 * reads the log of the run before the last restart instead (kubectl logs --previous),
 * which is where a CrashLoopBackOff's reason is.
 */
export function followLogs(context: string, namespace: string, pod: string, container: string, tail: number, onLines: (lines: string[]) => void, onError: (message: string) => void, previous = false): () => void {
  let stopped = false
  const out = new PassThrough()
  // The client pipes the HTTP body into `out` and never listens for its errors, so
  // aborting the request on stop (closing the log panel) threw an uncaught
  // AbortError in the main process. Catch it on the source as it is attached.
  out.on('pipe', (src) => src.on('error', (e: Error) => !stopped && onError(reason(e))))
  out.on('error', () => {})
  let buf = ''
  out.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    if (lines.length) onLines(lines)
  })
  let abort: AbortController | null = null
  new k8s.Log(forContext(context))
    .log(namespace, pod, container, out, { follow: !previous, previous, tailLines: tail, timestamps: false })
    .then((a) => {
      abort = a
      if (stopped) a.abort()
    })
    .catch((e) => {
      const why = reason(e)
      // The client drops the API's reason on a 400; for --previous it means there was no earlier run.
      onError(previous && /previous terminated container|not found|HTTP-Code: 400/i.test(why) ? `${container} has not restarted since this pod started, so there is no previous run to show.` : why)
    })
  return () => {
    stopped = true
    abort?.abort()
    out.destroy()
  }
}

/** Restarts, scales or deletes one object, like the matching kubectl command. Returns what happened. */
export async function act(context: string, a: KubeAction): Promise<string> {
  const kc = forContext(context)
  const core = kc.makeApiClient(k8s.CoreV1Api)
  const apps = kc.makeApiClient(k8s.AppsV1Api)
  const { name, namespace } = a
  try {
    switch (a.kind) {
      case 'delete-pod':
        await quick(core.deleteNamespacedPod({ name, namespace }), context)
        return `Deleted pod ${name}.`
      case 'delete-deployment':
        await quick(apps.deleteNamespacedDeployment({ name, namespace, propagationPolicy: 'Background' }), context)
        return `Deleted deployment ${name} and its pods.`
      case 'delete-service':
        await quick(core.deleteNamespacedService({ name, namespace }), context)
        return `Deleted service ${name}.`
      case 'restart-deployment':
        // What kubectl rollout restart does: a new template annotation rolls every pod.
        await quick(
          apps.patchNamespacedDeployment(
            { name, namespace, body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } } },
            k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.StrategicMergePatch),
          ),
          context,
        )
        return `Restarting ${name}: new pods replace the old ones one by one.`
      case 'scale-deployment':
        await quick(apps.patchNamespacedDeploymentScale({ name, namespace, body: { spec: { replicas: a.replicas } } }, k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)), context)
        return `Scaled ${name} to ${a.replicas} ${a.replicas === 1 ? 'pod' : 'pods'}.`
    }
  } catch (e) {
    throw new Error(reason(e))
  }
}
