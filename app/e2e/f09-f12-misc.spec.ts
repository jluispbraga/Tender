import { expect, row, setEngine, test } from './fixtures'

test.describe('F09 files in a container', () => {
  test('F09-H1 the Files tab is disabled with a reason', async ({ page, open }) => {
    await open('#/containers/b7c2e9f0a1b2c3d4/logs')
    const tab = page.getByRole('tab', { name: 'Files' })
    await expect(tab).toBeDisabled()
    await expect(tab).toHaveAttribute('title', /later milestone/)
  })
})

test.describe('F10 engine not running', () => {
  test('F10-H1 unreachable: the gate explains, Retry recovers', async ({ page, open }) => {
    await open('#/images')
    await setEngine(page, 'error', 'pipe not found')
    await expect(page.getByText('Tried //./pipe/docker_engine')).toBeVisible()
    await expect(page.getByText('Engine unreachable')).toBeVisible()
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('table', { name: 'Images' })).toBeVisible({ timeout: 10_000 })
  })

  test('F10-E1 stopped has its own wording', async ({ page, open }) => {
    await open('#/containers')
    await setEngine(page, 'stopped')
    await expect(page.getByRole('heading', { name: 'The Docker engine is stopped' })).toBeVisible()
  })

  test('F10-E3 Docker in WSL lost its socket: one click repairs it', async ({ page, open, scan }) => {
    await open('#/containers')
    await setEngine(page, 'error', 'connect ENOENT //./pipe/dockerDesktopLinuxEngine', 'Ubuntu')
    await expect(page.getByRole('heading', { name: 'Docker in Ubuntu lost its socket' })).toBeVisible()
    await scan('S01 lost socket')
    await page.getByRole('button', { name: 'Repair Docker in Ubuntu' }).click()
    await expect(page.getByRole('table', { name: 'Containers' })).toBeVisible({ timeout: 10_000 })
  })

  test('F10-E4 WSL is stuck: one click restarts it', async ({ page, open, scan }) => {
    await open('#/containers')
    await setEngine(page, 'error', 'connect ENOENT //./pipe/docker_engine; also looked in WSL: WSL itself is not responding (Wsl/Service/E_UNEXPECTED)', undefined, true)
    await expect(page.getByRole('heading', { name: 'WSL is not responding' })).toBeVisible()
    await scan('S01 WSL stuck')
    await page.getByRole('button', { name: 'Restart WSL' }).click()
    await expect(page.getByRole('table', { name: 'Containers' })).toBeVisible({ timeout: 10_000 })
  })

  test('F10-E2 settings stay usable while the engine is down', async ({ page, open, scan }) => {
    await open('#/containers')
    await setEngine(page, 'error', 'down')
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible()
    await scan('S21 settings')
    await page.getByRole('link', { name: 'Troubleshoot' }).click()
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible()
    await scan('S23 troubleshoot')
  })
})

test.describe('F11 open an app in the browser', () => {
  test('F11-H1 a published port opens http://localhost:<port>', async ({ page, open }) => {
    // Nothing listens on 8080 here; answer the request so the new window loads.
    await page.context().route('http://localhost:8080/**', (r) => r.fulfill({ body: 'ok' }))
    await open('#/containers')
    const popup = page.waitForEvent('popup')
    await row(page, 'Containers', 'nginx:1.27').getByRole('link', { name: /8080/ }).click()
    const p = await popup
    await p.waitForLoadState()
    expect(p.url()).toContain('localhost:8080')
  })

  test('F11-E2 unpublished ports are shown, not hidden behind a dash', async ({ page, open }) => {
    await open('#/containers')
    const worker = row(page, 'Containers', 'shop/worker:dev')
    await expect(worker).toContainText('8080')
    await worker.getByRole('button', { name: 'Show all 2 ports of shop-worker-1' }).click()
    const list = page.getByRole('dialog', { name: 'Ports of shop-worker-1' })
    await expect(list).toContainText('9090/tcp')
    await expect(list).toContainText('not published')
    await expect(list.getByRole('link')).toHaveCount(0)
  })

  test('F11-E3 several published ports: all of them are reachable from the list', async ({ page, open, scan }) => {
    await open('#/containers')
    const name = 'telemetry-collector-for-the-platform-observability-stack-01'
    await page.getByRole('button', { name: `Show all 3 ports of ${name}` }).click()
    const list = page.getByRole('dialog', { name: `Ports of ${name}` })
    // Live stats refresh the list every second; an open popover must survive that (BUG-009).
    await page.waitForTimeout(2500)
    await expect(list.getByRole('link', { name: /4318:4318/ })).toBeVisible()
    await expect(list).toContainText('8125:8125/udp')
    await scan('S03 ports popover')
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
  })

  test('F11-E4 the detail page lists unpublished ports too', async ({ page, open }) => {
    await open('#/containers/e0f1a2b3c4d5e6f7/logs')
    await expect(page.getByText('8080/tcp, 9090/tcp (not published)')).toBeVisible()
  })

  test('F11-E1 ports of a stopped or paused container are not links', async ({ page, open }) => {
    await open('#/containers')
    await expect(row(page, 'Containers', 'redis:7').getByRole('link')).toHaveCount(0)
    await expect(row(page, 'Containers', 'redis:7')).toContainText('6379:6379')
  })
})

test.describe('F12 see what uses a volume', () => {
  test('F12-H1 shop-data shows shop-db-1 and its path', async ({ page, open, scan }) => {
    await open('#/volumes')
    await row(page, 'Volumes', 'shop-data').click()
    const used = page.getByRole('table', { name: 'Containers using shop-data' })
    await expect(used).toContainText('shop-db-1')
    await expect(used).toContainText('/var/lib/postgresql/data')
    await expect(page.getByRole('tab', { name: 'Stored data' })).toBeDisabled()
    await scan('S16 volume detail')
  })

  test('F12-N1 an unknown volume says so', async ({ page, open }) => {
    await open('#/volumes/nope/containers')
    await expect(page.getByRole('heading', { name: 'This volume no longer exists' })).toBeVisible()
  })
})
