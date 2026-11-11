// Smoke for booting WSL (Windows). Run after `wsl --shutdown`, with no distribution running:
//   TENDER_SMOKE=scripts/smoke-boot.js DOCKER_CONTEXT=default npx electron out/main/index.js
// Tender should start the distribution with Docker by itself and list its containers.
;(async () => {
  const t = window.tender
  const t0 = Date.now()
  let s = await t.engine.status()
  while (s.state !== 'running' && Date.now() - t0 < 120_000) {
    await new Promise((r) => setTimeout(r, 500))
    s = await t.engine.status()
  }
  if (s.state !== 'running') return { status: s, waitedMs: Date.now() - t0 }
  const containers = await t.containers.list()
  return { status: { state: s.state, endpoint: s.endpoint, version: s.version }, readyMs: Date.now() - t0, containers: containers.length, running: containers.filter((c) => c.state === 'running').map((c) => c.name) }
})()
