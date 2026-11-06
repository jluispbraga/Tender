// Write smoke test against the real engine. Only creates objects named
// tender-test-*, from an image already on the machine (redis:latest), and
// removes them at the end. Never pulls, never prunes, never touches anything else.
;(async () => {
  const h = window.tender
  const r = { steps: {} }
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms))
  const step = async (name, fn) => {
    try {
      r.steps[name] = await fn()
    } catch (e) {
      r.steps[name] = { error: e.message, status: e.status }
    }
  }
  const find = async (name) => (await h.containers.list()).find((c) => c.name === name)
  for (let i = 0; i < 40 && (await h.engine.status()).state !== 'running'; i++) await sleep(250)

  const pre = (await h.containers.list()).filter((c) => c.name.startsWith('tender-test-')).map((c) => c.name)
  const preV = (await h.volumes.list()).filter((v) => v.name.startsWith('tender-test-')).map((v) => v.name)
  if (pre.length || preV.length) return { aborted: 'tender-test-* objects already exist', pre, preV }
  if (!(await h.images.list()).some((i) => i.tags.includes('redis:latest'))) return { aborted: 'redis:latest is not on this machine' }

  const events = []
  const offEv = h.engine.onEvents((e) => events.push(...e.map((x) => `${x.type}:${x.action}`)))
  let id
  try {
    await step('run', async () => {
      id = (await h.images.run({ image: 'redis:latest', name: 'tender-test-redis', ports: [{ host: '16379', container: '6379' }], volumes: [{ source: 'tender-test-vol', target: '/data' }], env: [{ key: 'TENDER_TEST', value: '1' }] })).containerId
      await sleep(800)
      const c = await find('tender-test-redis')
      return { state: c?.state, ports: c?.ports, mounts: c?.mounts.map((m) => `${m.type}:${m.source}->${m.destination}`) }
    })
    await step('portTaken', async () => {
      try {
        await h.images.run({ image: 'redis:latest', name: 'tender-test-redis2', ports: [{ host: '16379', container: '6379' }], volumes: [], env: [] })
        return 'UNEXPECTED: started'
      } catch (e) {
        return { error: e.message, status: e.status, leftover: !!(await find('tender-test-redis2')) }
      }
    })
    await step('duplicateName', async () => {
      try {
        await h.images.run({ image: 'redis:latest', name: 'tender-test-redis', ports: [], volumes: [], env: [] })
        return 'UNEXPECTED'
      } catch (e) {
        return { error: e.message, status: e.status }
      }
    })
    await step('logs', () =>
      new Promise((resolve) => {
        let got = []
        const off = h.logs.subscribe(id, { tail: 50 }, (l) => (got = got.concat(l)))
        setTimeout(() => (off(), resolve({ lines: got.length, last: got.at(-1)?.text?.slice(0, 60) })), 1500)
      }),
    )
    await step('stats', () =>
      new Promise((resolve) => {
        const got = []
        const off = h.stats.subscribe([id], (s) => got.push(...s))
        setTimeout(() => (off(), resolve({ samples: got.length, memMB: got.at(-1) && +(got.at(-1).memUsage / 1e6).toFixed(1), cpu: got.at(-1)?.cpuPercent?.toFixed(2), pids: got.at(-1)?.pids })), 3500)
      }),
    )
    await step('exec', async () => {
      let out = ''
      let exit = null
      const s = await h.exec.open(id, { shell: '/bin/sh', cols: 80, rows: 24 }, (d) => (out += d), (c) => (exit = c))
      await sleep(400)
      s.write('echo tender-$TENDER_TEST-$((20+22))\r')
      await sleep(600)
      s.resize(100, 30)
      s.write('exit 3\r')
      await sleep(800)
      return { sawOutput: out.includes('tender-1-42'), exit }
    })
    await step('execMissingShell', async () => {
      let out = ''
      let exit = null
      await h.exec.open(id, { shell: 'cmd.exe', cols: 80, rows: 24 }, (d) => (out += d), (c) => (exit = c))
      await sleep(1500)
      return { exit, hint: /has no cmd\.exe/.test(out) }
    })
    await step('inspect', async () => {
      const d = await h.containers.inspect(id)
      return { name: d.Name, env: d.Config.Env.includes('TENDER_TEST=1') }
    })
    await step('runCommand', () => h.containers.runCommand(id))
    await step('pause', async () => (await h.containers.action([id], 'pause'), (await find('tender-test-redis')).state))
    await step('unpause', async () => (await h.containers.action([id], 'unpause'), (await find('tender-test-redis')).state))
    await step('startWhileRunning304', () => h.containers.action([id], 'start'))
    await step('restart', async () => (await h.containers.action([id], 'restart'), (await find('tender-test-redis')).state))
    await step('volumeInUse', async () => ({ remove: await h.volumes.remove(['tender-test-vol']), usage: await h.volumes.usage('tender-test-vol') }))
    await step('removeRunningNoForce', () => h.containers.remove([id], false))
    await step('stop', async () => (await h.containers.action([id], 'stop'), await find('tender-test-redis')).state)
    await step('stopAgain304', () => h.containers.action([id], 'stop'))
    await step('volumeCreateDup', async () => {
      await h.volumes.create('tender-test-vol2')
      try {
        await h.volumes.create('tender-test-vol2')
        return 'UNEXPECTED'
      } catch (e) {
        return { error: e.message, status: e.status }
      }
    })
    await step('notifications', async () => (await h.notifications.list()).map((n) => n.title))
  } finally {
    // Cleanup, whatever happened above.
    const cs = (await h.containers.list()).filter((c) => c.name.startsWith('tender-test-'))
    r.cleanupContainers = cs.length ? await h.containers.remove(cs.map((c) => c.id), true) : []
    await sleep(500)
    const vs = (await h.volumes.list()).filter((v) => v.name.startsWith('tender-test-'))
    r.cleanupVolumes = vs.length ? await h.volumes.remove(vs.map((v) => v.name)) : []
    offEv()
    r.events = [...new Set(events)]
  }
  return r
})()
