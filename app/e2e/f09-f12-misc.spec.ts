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
