// Smoke for the Kubernetes page against a real cluster (minikube, kind...). Needs a
// deployment that logs, for example:
//   kubectl create deployment ticker --image=busybox:1.36 --replicas=2 -- sh -c 'i=0; while true; do i=$((i+1)); echo "tick $i"; sleep 1; done'
//   kubectl expose deployment ticker --port=80
//   TENDER_SMOKE=scripts/smoke-kube.js npx electron out/main/index.js
// Reads a pod's log for 4 s, then restarts and scales the deployment and deletes a pod.
;(async () => {
  const t = window.tender
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const ctx = (await t.kube.contexts()).find((c) => c.current)?.name
  const before = await t.kube.overview(ctx, 'default')
  const pod = before.pods.find((p) => p.name.startsWith('ticker-'))
  if (!pod) return { ctx, error: 'no ticker pod', pods: before.pods.map((p) => p.name) }
  const events = []
  const stop = t.kube.logs(ctx, pod.namespace, pod.name, pod.containers[0], (e) => events.push(e))
  await sleep(4000)
  stop()
  const lines = events.filter((e) => e.type === 'lines').flatMap((e) => e.lines)
  const errors = events.filter((e) => e.type === 'error').map((e) => e.message)
  const acts = {}
  for (const a of [
    { kind: 'restart-deployment', namespace: 'default', name: 'ticker' },
    { kind: 'scale-deployment', namespace: 'default', name: 'ticker', replicas: 3 },
    { kind: 'delete-pod', namespace: 'default', name: pod.name },
  ]) {
    try {
      acts[a.kind] = await t.kube.act(ctx, a)
    } catch (e) {
      acts[a.kind] = `ERROR ${e.message}`
    }
  }
  await sleep(3000)
  const after = await t.kube.overview(ctx, 'default')
  return { ctx, pod: pod.name, lineCount: lines.length, first: lines.slice(0, 3), last: lines.slice(-2), errors, acts, deployment: after.deployments.find((d) => d.name === 'ticker') }
})()
