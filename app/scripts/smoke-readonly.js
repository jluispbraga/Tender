// Read-only smoke test against the real engine: lists, inspects and reads
// logs, changes nothing in Docker. Local settings go to TENDER_DB_PATH.
// Run: TENDER_SMOKE=scripts/smoke-readonly.js TENDER_DB_PATH=<tmp db> npx electron-vite dev
;(async () => {
  const h = window.tender
  const r = { kind: h?.kind }
  const t = async (name, fn) => {
    const t0 = performance.now()
    try {
      r[name] = await fn()
    } catch (e) {
      r[name] = { error: e.message, status: e.status }
    }
    r[name + '_ms'] = Math.round(performance.now() - t0)
  }
  // Wait for the first ping.
  for (let i = 0; i < 40 && (await h.engine.status()).state !== 'running'; i++) await new Promise((x) => setTimeout(x, 250))
  await t('status', async () => {
    const s = await h.engine.status()
    return { state: s.state, endpoint: s.endpoint, version: s.version, os: s.os, ncpu: s.ncpu }
  })
  let containers = []
  await t('containers', async () => {
    containers = await h.containers.list()
    return { count: containers.length, projects: [...new Set(containers.map((c) => c.project).filter(Boolean))], sample: containers.slice(0, 2).map((c) => ({ name: c.name, state: c.state, exitCode: c.exitCode, ports: c.ports.length, mounts: c.mounts.length, startedAt: !!c.startedAt })) }
  })
  await t('inspect', async () => (containers[0] ? Object.keys(await h.containers.inspect(containers[0].id)).length : 'none'))
  await t('runCommand', async () => (containers[0] ? (await h.containers.runCommand(containers[0].id)).split('\n')[0] : 'none'))
  await t('logs', () =>
    new Promise((resolve) => {
      if (!containers[0]) return resolve('none')
      let got = []
      const off = h.logs.subscribe(containers[0].id, { tail: 20 }, (lines) => (got = got.concat(lines)))
      setTimeout(() => (off(), resolve({ lines: got.length, streams: [...new Set(got.map((l) => l.stream))], tsOk: got.every((l) => /^\d{4}-/.test(l.ts)) })), 1500)
    }),
  )
  let images = []
  await t('images', async () => {
    images = await h.images.list()
    return { count: images.length, inUse: images.filter((i) => i.inUse).length, dangling: images.filter((i) => i.dangling).length, emulated: images.filter((i) => i.emulated).map((i) => i.tags[0]) }
  })
  await t('imageInspect', async () => {
    const d = await h.images.inspect(images[0].id)
    return { tag: d.image.tags[0], layers: d.layers.length, cmd: d.cmd.slice(0, 40), ports: d.exposedPorts }
  })
  await t('imageMissing', () => h.images.inspect('sha256:does-not-exist'))
  await t('diskUsage', async () => {
    const d = await h.images.diskUsage()
    return { totalGB: +(d.imagesTotal / 1e9).toFixed(2), reclaimableGB: +(d.imagesReclaimable / 1e9).toFixed(2) }
  })
  await t('volumes', async () => {
    const v = await h.volumes.list()
    return { count: v.length, inUse: v.filter((x) => x.usedBy.length).length, sized: v.filter((x) => x.size > 0).length }
  })
  await t('volumeUsage', async () => {
    const v = (await h.volumes.list()).find((x) => x.usedBy.length)
    return v ? await h.volumes.usage(v.name) : 'none in use'
  })
  await t('badInput', () => h.containers.action([], 'start'))
  await t('settings', async () => {
    await h.settings.set('log_tail_lines', 1234)
    const s = await h.settings.get()
    return s.log_tail_lines
  })
  await t('badSetting', () => h.settings.set('log_tail_lines', 9))
  await t('grid', async () => {
    await h.grid.set('images', { hidden: ['id'] })
    return h.grid.get('images')
  })
  await t('recent', async () => {
    await h.search.recordUse({ type: 'image', id: images[0].id, label: images[0].tags[0] ?? 'x' })
    return (await h.search.recent()).length
  })
  await t('notifications', async () => (await h.notifications.list()).length)
  await t('noNodeInPage', () => typeof require + '/' + typeof process)
  return r
})()
