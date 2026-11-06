// Smoke for the WSL bridge (Windows). Run with TENDER_DEFAULT_PIPE=<missing pipe>
// and DOCKER_CONTEXT=default so Tender falls back to looking inside WSL:
//   TENDER_SMOKE=scripts/smoke-wsl.js TENDER_DEFAULT_PIPE=nope DOCKER_CONTEXT=default npx electron out/main/index.js
// Read-only: status, lists, one log tail and a few seconds of stats.
;(async () => {
  const t = window.tender
  const deadline = Date.now() + 30_000
  let s = await t.engine.status()
  while (s.state !== 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    s = await t.engine.status()
  }
  if (s.state !== 'running') return { status: s }
  const t0 = performance.now()
  const containers = await t.containers.list()
  const listMs = Math.round(performance.now() - t0)
  const t1 = performance.now()
  const each = {}
  const tm = (k, p) => { const a = performance.now(); return p.then(() => (each[k] = Math.round(performance.now() - a))) }
  await Promise.all([tm("images", t.images.list()), tm("volumes", t.volumes.list()), tm("containers", t.containers.list())])
  const parallelMs = Math.round(performance.now() - t1)
  const t2 = performance.now()
  await Promise.all([t.images.list(), t.volumes.list(), t.containers.list()])
  const warmMs = Math.round(performance.now() - t2)
  const running = containers.filter((c) => c.state === 'running').slice(0, 5).map((c) => c.id)
  const samples = {}
  const stop = t.stats.subscribe(running, (b) => b.forEach((x) => (samples[x.id] = true)))
  await new Promise((r) => setTimeout(r, 4000))
  stop()
  return { status: { state: s.state, endpoint: s.endpoint, version: s.version }, containers: containers.length, running: running.length, statsFor: Object.keys(samples).length, listMs, parallelMs, each, warmMs }
})()
