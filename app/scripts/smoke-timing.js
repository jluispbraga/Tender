// Read-only: how fast the lists answer, cold and warm.
;(async () => {
  const h = window.tender
  for (let i = 0; i < 40 && (await h.engine.status()).state !== 'running'; i++) await new Promise((x) => setTimeout(x, 250))
  const time = async (fn) => { const t = performance.now(); const v = await fn(); return [Math.round(performance.now() - t), v] }
  const events = []
  h.engine.onEvents((e) => events.push(...e.map((x) => x.action)))
  const [c1, l1] = await time(() => h.containers.list())
  await new Promise((x) => setTimeout(x, 4000))
  const [c2, l2] = await time(() => h.containers.list())
  const [i1] = await time(() => h.images.list())
  const [i2] = await time(() => h.images.list())
  const [v1] = await time(() => h.volumes.list())
  const [d1] = await time(() => h.images.diskUsage())
  return { containersCold: c1, startedKnownCold: l1.filter((c) => c.startedAt).length, containersWarm: c2, startedKnownWarm: l2.filter((c) => c.startedAt).length, of: l2.length, imagesCold: i1, imagesWarm: i2, volumes: v1, diskUsageAfterVolumes: d1, events }
})()
