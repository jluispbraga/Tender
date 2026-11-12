import { createServer, type Server } from 'node:net'
import { PassThrough } from 'node:stream'
import * as k8s from '@kubernetes/client-node'
import type { KubeForward, KubePodDetails } from '../../renderer/src/api/types'
import { forContext, quick, reason } from './kube'

// What a developer reaches for after seeing a pod in the list: why it is not
// healthy (details and events), a shell inside it, and a local port into it.

const iso = (d?: Date | string) => (d ? new Date(d).toISOString() : undefined)

/** kubectl describe pod, the useful part: containers, conditions and recent events. */
export async function podDetails(context: string, namespace: string, name: string): Promise<KubePodDetails> {
  const core = forContext(context).makeApiClient(k8s.CoreV1Api)
  try {
    const [pod, events] = await quick(
      Promise.all([core.readNamespacedPod({ name, namespace }), core.listNamespacedEvent({ namespace, fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${name}` })]),
      context,
    )
    const statuses = pod.status?.containerStatuses ?? []
    return {
      node: pod.spec?.nodeName,
      ip: pod.status?.podIP,
      startedAt: iso(pod.status?.startTime),
      conditions: (pod.status?.conditions ?? []).map((c) => ({ type: c.type, ok: c.status === 'True', reason: c.reason, message: c.message })),
      containers: (pod.spec?.containers ?? []).map((c) => {
        const s = statuses.find((x) => x.name === c.name)
        const state = s?.state?.running ? 'running' : s?.state?.waiting ? `waiting: ${s.state.waiting.reason ?? ''}` : s?.state?.terminated ? `terminated: ${s.state.terminated.reason ?? ''} (exit ${s.state.terminated.exitCode})` : 'unknown'
        const last = s?.lastState?.terminated
        return {
          name: c.name,
          image: c.image ?? '',
          ready: !!s?.ready,
          restarts: s?.restartCount ?? 0,
          state,
          message: s?.state?.waiting?.message ?? s?.state?.terminated?.message,
          lastTermination: last ? { reason: last.reason ?? 'Terminated', exitCode: last.exitCode, finishedAt: iso(last.finishedAt) } : undefined,
          ports: (c.ports ?? []).map((p) => ({ port: p.containerPort, name: p.name, protocol: p.protocol ?? 'TCP' })),
        }
      }),
      events: events.items
        .map((e) => ({ type: e.type ?? 'Normal', reason: e.reason ?? '', message: e.message ?? '', count: e.count ?? 1, lastSeen: iso(e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp) }))
        .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')),
    }
  } catch (e) {
    throw new Error(reason(e))
  }
}

// ---- terminal -------------------------------------------------------------------------

/** A shell in a pod's container; same contract as a container exec session. */
export async function openExec(
  context: string,
  namespace: string,
  pod: string,
  container: string,
  shell: 'auto' | '/bin/sh' | '/bin/bash',
  cols: number,
  rows: number,
  onData: (d: string) => void,
  onExit: (code: number) => void,
): Promise<{ write(d: string): void; resize(c: number, r: number): void; close(): void }> {
  // The client sends terminal sizes when stdout looks like a TTY stream: columns, rows and 'resize'.
  const stdout = Object.assign(new PassThrough(), { columns: cols, rows })
  const stdin = new PassThrough()
  stdout.on('data', (b: Buffer) => onData(b.toString('utf8')))
  let exited = false
  const exit = (code: number) => {
    if (exited) return
    exited = true
    onExit(code)
  }
  // bash when the image has it, else sh: most images ship one or the other.
  const command = shell === 'auto' ? ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'] : [shell]
  let ws: Awaited<ReturnType<k8s.Exec['exec']>>
  try {
    ws = await quick(
      new k8s.Exec(forContext(context)).exec(namespace, pod, container, command, stdout, stdout, stdin, true, (s) => {
        const code = s.status === 'Success' ? 0 : Number(s.details?.causes?.find((c) => c.reason === 'ExitCode')?.message ?? 1)
        exit(Number.isFinite(code) ? code : 1)
      }),
      context,
      10_000,
    )
  } catch (e) {
    throw new Error(reason(e))
  }
  ws.on('close', () => exit(0))
  ws.on('error', () => exit(1))
  return {
    write: (d) => stdin.write(d),
    resize: (c, r) => {
      stdout.columns = c
      stdout.rows = r
      stdout.emit('resize')
    },
    close: () => {
      stdin.end()
      try {
        ws.close()
      } catch {
        // Already closed.
      }
    },
  }
}

// ---- port forwarding ------------------------------------------------------------------

interface Live {
  info: KubeForward
  server: Server
}
const forwards = new Map<string, Live>()
let nextId = 1

export const listForwards = (): KubeForward[] => [...forwards.values()].map((f) => f.info)

/** The pod port behind a service port, resolving a named targetPort on one of its pods. */
async function servicePortTarget(core: k8s.CoreV1Api, namespace: string, service: string, port: number): Promise<number> {
  const svc = await core.readNamespacedService({ name: service, namespace })
  const p = (svc.spec?.ports ?? []).find((x) => x.port === port)
  if (!p) throw new Error(`${service} has no port ${port}.`)
  if (typeof p.targetPort === 'number') return p.targetPort
  if (p.targetPort === undefined || p.targetPort === '') return p.port
  if (/^\d+$/.test(String(p.targetPort))) return Number(p.targetPort)
  const selector = Object.entries(svc.spec?.selector ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
  const pods = await core.listNamespacedPod({ namespace, labelSelector: selector })
  for (const pod of pods.items) for (const c of pod.spec?.containers ?? []) for (const cp of c.ports ?? []) if (cp.name === p.targetPort) return cp.containerPort
  throw new Error(`No pod behind ${service} names a port ${p.targetPort}.`)
}

/**
 * Listens on 127.0.0.1:localPort and tunnels each connection to the pod (or to a
 * ready pod behind the service), like kubectl port-forward. Only this computer can
 * connect: it never listens on other interfaces.
 */
export async function startForward(context: string, kind: 'pod' | 'service', namespace: string, name: string, port: number, localPort: number): Promise<KubeForward> {
  const kc = forContext(context)
  const core = kc.makeApiClient(k8s.CoreV1Api)
  let target = port
  try {
    if (kind === 'service') target = await quick(servicePortTarget(core, namespace, name, port), context)
    else await quick(core.readNamespacedPod({ name, namespace }), context)
  } catch (e) {
    throw new Error(reason(e))
  }
  const pf = new k8s.PortForward(kc, true)
  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy())
    const open = kind === 'service' ? pf.portForwardService(namespace, name, [target], socket, null, socket) : pf.portForward(namespace, name, [target], socket, null, socket)
    open.catch(() => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${localPort} on this computer is already in use. Pick another one.` : e.code === 'EACCES' ? `Port ${localPort} needs administrator rights here. Pick one above 1024.` : e.message)))
    server.listen(localPort, '127.0.0.1', () => resolve())
  })
  server.on('error', () => {})
  const actual = (server.address() as { port: number }).port
  const info: KubeForward = { id: String(nextId++), context, kind, namespace, name, port, localPort: actual, startedAt: new Date().toISOString() }
  forwards.set(info.id, { info, server })
  return info
}

export function stopForward(id: string) {
  const f = forwards.get(id)
  if (!f) return
  f.server.close()
  forwards.delete(id)
}
