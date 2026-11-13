import { describe, expect, it } from 'vitest'
import { act, contexts, followLogs, namespaces, overview } from './kube'
import { openExec, podDetails, startForward, stopForward } from './pod-tools'
import { actMore, data, list, yaml } from './resources'

// Against a real cluster: TENDER_KUBE_IT=<context> after applying e2e/kube/fixture.yaml.
// CI runs it on kind (.github/workflows/kube.yml); without the variable it is skipped.
const ctx = process.env.TENDER_KUBE_IT
const ns = 'tender-it'
const secret = 'it-secret-value-123'

async function until<T>(what: string, f: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f().catch(() => undefined)
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

describe.skipIf(!ctx)('Kubernetes, against a real cluster', { timeout: 120_000 }, () => {
  const c = ctx!

  it('reads the context, namespaces and the overview', async () => {
    expect(contexts().map((x) => x.name)).toContain(c)
    expect(await namespaces(c)).toContain(ns)
    const ov = await overview(c, ns)
    expect(ov.deployments.map((d) => d.name)).toContain('web')
    expect(ov.services.find((s) => s.name === 'web')?.portNumbers).toEqual([8080])
    expect(ov.pods.find((p) => p.name.startsWith('fails-'))?.owner).toEqual({ kind: 'Job', name: 'fails' })
  })

  it('lists the other kinds, and never a secret value', async () => {
    expect((await list(c, ns, 'statefulsets')).map((x) => x.name)).toEqual(['db'])
    expect((await list(c, ns, 'jobs')).find((j) => j.name === 'fails')?.fields.status).toBe('Failed')
    expect((await list(c, ns, 'cronjobs')).map((x) => x.fields.schedule)).toEqual(['0 3 * * *'])
    expect((await data(c, ns, 'configmaps', 'web-config')).entries).toEqual([{ key: 'LOG_LEVEL', bytes: 4, value: 'info' }])
    const s = await data(c, ns, 'secrets', 'db-password')
    expect(s.entries).toEqual([{ key: 'password', bytes: secret.length }])
    const y = await yaml(c, 'secrets', ns, 'db-password')
    expect(y).toContain('password: (hidden)')
    expect(JSON.stringify([s, y, await list(c, ns, 'secrets')])).not.toContain(secret)
    expect(JSON.stringify([s, y])).not.toContain(Buffer.from(secret).toString('base64'))
    expect(await yaml(c, 'deployments', ns, 'web')).toMatch(/^apiVersion: apps\/v1\nkind: Deployment\n/)
  })

  it('follows a log, and reads a failed job’s', async () => {
    const pod = (await overview(c, ns)).pods.find((p) => p.name === 'db-0')!
    const lines = await new Promise<string[]>((res, rej) => {
      const got: string[] = []
      const stop = followLogs(c, ns, pod.name, 'db', 5, (ls) => got.push(...ls), rej)
      setTimeout(() => (stop(), res(got)), 4000)
    })
    expect(lines.some((l) => /Z tick \d+$/.test(l))).toBe(true)
    const fails = (await overview(c, ns)).pods.find((p) => p.owner?.name === 'fails')!
    const boom = await new Promise<string[]>((res, rej) => {
      const got: string[] = []
      const stop = followLogs(c, ns, fails.name, 'run', 50, (ls) => got.push(...ls), rej)
      setTimeout(() => (stop(), res(got)), 2000)
    })
    expect(boom.join('\n')).toContain('boom')
  })

  it('shows pod details with the last termination', async () => {
    const fails = (await overview(c, ns)).pods.find((p) => p.owner?.name === 'fails')!
    const d = await podDetails(c, ns, fails.name)
    expect(d.containers[0].state).toMatch(/terminated/i)
  })

  it('runs a command in a pod', async () => {
    let out = ''
    let code = -1
    const s = await openExec(c, ns, 'db-0', 'db', '/bin/sh', 80, 24, (d) => (out += d), (x) => (code = x))
    s.write('echo it-$((40+2)); exit 3\n')
    await until('the shell to exit', async () => code !== -1)
    expect(out).toContain('it-42')
    expect(code).toBe(3)
  })

  it('forwards a service port with a named target to this computer', async () => {
    const f = await startForward(c, 'service', ns, 'web', 8080, 0)
    try {
      const body = await until('nginx through the forward', async () => (await fetch(`http://127.0.0.1:${f.localPort}/`)).text())
      expect(body).toContain('Welcome to nginx')
    } finally {
      stopForward(f.id)
    }
  })

  it('scales and restarts, runs and pauses a CronJob, deletes', async () => {
    expect(await actMore(c, { kind: 'scale-statefulset', namespace: ns, name: 'db', replicas: 2 })).toBe('Scaled db to 2 pods.')
    await until('2 StatefulSet pods', async () => (await list(c, ns, 'statefulsets'))[0].replicas === 2)
    await actMore(c, { kind: 'restart-statefulset', namespace: ns, name: 'db' })
    expect(await act(c, { kind: 'scale-deployment', namespace: ns, name: 'web', replicas: 2 })).toBe('Scaled web to 2 pods.')
    await act(c, { kind: 'restart-deployment', namespace: ns, name: 'web' })
    const started = await actMore(c, { kind: 'run-cronjob', namespace: ns, name: 'nightly' })
    const job = /Started job (\S+) from nightly/.exec(started)![1]
    await until('the manual job to finish', async () => (await list(c, ns, 'jobs')).find((j) => j.name === job)?.fields.status === 'Complete')
    await actMore(c, { kind: 'suspend-cronjob', namespace: ns, name: 'nightly', suspend: true })
    expect((await list(c, ns, 'cronjobs'))[0].suspended).toBe(true)
    expect(await actMore(c, { kind: 'delete', resource: 'configmaps', namespace: ns, name: 'web-config' })).toBe('Deleted ConfigMap web-config.')
    expect(await actMore(c, { kind: 'delete', resource: 'jobs', namespace: ns, name: 'fails' })).toBe('Deleted job fails.')
    await until('the job’s pod to go too', async () => !(await overview(c, ns)).pods.some((p) => p.owner?.name === 'fails'))
  })
})
