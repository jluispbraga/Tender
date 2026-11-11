// Smoke for "Restart WSL" (Windows). Stops every distribution, then expects Tender to
// boot the one with Docker again and reconnect:
//   TENDER_SMOKE=scripts/smoke-restart-wsl.js DOCKER_CONTEXT=default npx electron out/main/index.js
;(async () => {
  const t = window.tender
  const t0 = Date.now()
  let s = await t.engine.status()
  while (s.state !== 'running' && Date.now() - t0 < 120_000) {
    await new Promise((r) => setTimeout(r, 500))
    s = await t.engine.status()
  }
  if (s.state !== 'running') return { before: s }
  const checkup = (await t.doctor.check()).map((c) => `${c.status} ${c.title}`)
  const t1 = Date.now()
  const after = await t.engine.restartWsl()
  const containers = after.state === 'running' ? (await t.containers.list()).length : null
  return { before: s.endpoint, checkup, after: { state: after.state, endpoint: after.endpoint, error: after.error }, restartMs: Date.now() - t1, containers }
})()
