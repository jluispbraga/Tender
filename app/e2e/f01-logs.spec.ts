import { expect, row, setEngine, test } from './fixtures'

test.describe('F01 read a container’s logs', () => {
  test('F01-H1 open logs from the list in two clicks; new lines stream in', async ({ page, open, scan }) => {
    await open('#/containers')
    await scan('S03 containers')
    await row(page, 'Containers', 'node:22-alpine').click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('shop-api-1')
    const log = page.getByRole('log', { name: 'Logs for shop-api-1' })
    await expect(log).toContainText('listening on 0.0.0.0:3000')
    const before = await log.locator('[data-line]').count()
    await expect.poll(() => log.locator('[data-line]').count(), { timeout: 10_000 }).toBeGreaterThan(before)
    await scan('S04 logs')
  })

  test('F01-E1 search highlights matches and counts them', async ({ page, open }) => {
    await open('#/containers/b7c2e9f0a1b2c3d4/logs')
    await page.getByRole('searchbox', { name: 'Search logs' }).fill('slow query')
    await expect(page.getByText(/^\d+ of \d+$/)).toBeVisible()
    await expect(page.getByRole('log').locator('mark').first()).toHaveText(/slow query/i)
    await page.getByRole('searchbox', { name: 'Search logs' }).fill('zzz-nothing')
    await expect(page.getByText('No matches')).toBeVisible()
  })

  test('F01-E2 scrolling up offers a way back to the tail', async ({ page, open }) => {
    await open('#/containers/b7c2e9f0a1b2c3d4/logs')
    const log = page.getByRole('log')
    await expect(log).toContainText('listening')
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
    await log.evaluate((el) => (el.scrollTop = 0))
    await page.getByRole('button', { name: 'Jump to latest' }).click()
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
    expect(await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(10)
  })

  test('F01-E3 keyboard only: Tab to a row, Enter opens it', async ({ page, open }) => {
    await open('#/containers')
    const first = page.getByRole('table', { name: 'Containers' }).locator('tbody tr[tabindex="0"]').first()
    await first.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#\/containers\/[0-9a-f]+\/logs$/)
  })

  test('F01-E4 reload keeps the container and tab', async ({ page, open }) => {
    await open('#/containers/b7c2e9f0a1b2c3d4/mounts')
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('shop-api-1')
    await expect(page.getByRole('tab', { name: 'Mounts' })).toHaveAttribute('aria-selected', 'true')
  })

  test('F01-E5 a 60-character name truncates and keeps the full name in a title', async ({ page, open }) => {
    await open('#/containers/f00dbabe12345678/logs')
    const title = page.getByRole('heading', { level: 1 }).locator('span[title]').first()
    await expect(title).toHaveAttribute('title', 'telemetry-collector-for-the-platform-observability-stack-01')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)
  })

  test('F01-E6 engine going away shows the gate; Retry brings the logs back', async ({ page, open, scan }) => {
    await open('#/containers/b7c2e9f0a1b2c3d4/logs')
    await setEngine(page, 'error', 'open //./pipe/docker_engine: The system cannot find the file specified.')
    await expect(page.getByRole('heading', { name: 'Tender can’t reach the Docker engine' })).toBeVisible()
    await expect(page.getByText('The system cannot find the file specified.')).toBeVisible()
    await scan('S01 engine unreachable')
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('log', { name: 'Logs for shop-api-1' })).toBeVisible({ timeout: 10_000 })
  })

  test('F01-N1 an unknown container id says so and offers a way back', async ({ page, open, scan }) => {
    await open('#/containers/nope/logs')
    await expect(page.getByRole('heading', { name: 'This container no longer exists' })).toBeVisible()
    await scan('S04 not found')
    await page.getByRole('button', { name: 'Back to containers' }).click()
    await expect(page).toHaveURL(/#\/containers$/)
  })

  test('F01-E7 only matching lines, pause, and save to a file', async ({ page, open }) => {
    await open('#/containers/b7c2e9f0a1b2c3d4/logs')
    const log = page.getByRole('log')
    await expect(log).toContainText('listening')
    // Stop scrolling holds the view; new lines keep arriving below.
    await page.getByRole('button', { name: 'Stop scrolling' }).click()
    await expect(page.getByRole('button', { name: 'Follow new lines' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
    await page.getByRole('button', { name: 'Follow new lines' }).click()
    await expect(page.getByRole('button', { name: 'Stop scrolling' })).toBeVisible()
    const only = page.getByRole('button', { name: 'Matching lines only' })
    await expect(only).toBeDisabled()
    await page.getByRole('searchbox', { name: 'Search logs' }).fill('slow query')
    await only.click()
    await expect(only).toHaveAttribute('aria-pressed', 'true')
    const lines = log.locator('[data-line]')
    await expect.poll(() => lines.count()).toBeGreaterThan(0)
    for (const t of await lines.allInnerTexts()) expect(t.toLowerCase()).toContain('slow query')
    await only.click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save logs to a file' }).click()])
    expect(download.suggestedFilename()).toMatch(/\.log$/)
    const body = await download.createReadStream().then(async (st) => {
      let s = ''
      for await (const c of st) s += c
      return s
    })
    expect(body).toContain('listening')
  })
})
