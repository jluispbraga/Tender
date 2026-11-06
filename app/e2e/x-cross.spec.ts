import { expect, test } from './fixtures'

test.describe('cross-cutting', () => {
  test('X1 axe on the remaining screens', async ({ page, open, scan }) => {
    for (const [hash, name] of [
      ['#/containers/b7c2e9f0a1b2c3d4/inspect', 'S05 inspect'],
      ['#/containers/b7c2e9f0a1b2c3d4/mounts', 'S09 mounts'],
      ['#/containers/b7c2e9f0a1b2c3d4/stats', 'S08 stats'],
      ['#/images/sha256:2b8d0c6e1f4a', 'S12 image detail'],
      ['#/notifications', 'S24 notifications'],
      ['#/settings/engine', 'S22 engine settings'],
    ] as const) {
      await open(hash)
      await page.waitForTimeout(hash.endsWith('stats') ? 2500 : 400)
      await scan(name)
    }
  })

  test('X3 the minimum window has no horizontal scroll', async ({ page, open }) => {
    await page.setViewportSize({ width: 960, height: 640 })
    for (const hash of ['#/containers', '#/images', '#/volumes', '#/projects/shop']) {
      await open(hash)
      await page.waitForTimeout(300)
      const overflow = await page.evaluate(() => [...document.querySelectorAll('main *')].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'hidden' && el.tagName === 'DIV' && getComputedStyle(el).overflowX !== 'visible'))
      expect(overflow, `horizontal scroll on ${hash}`).toBe(false)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  })

  test('X4 quick search jumps to an image and remembers it', async ({ page, open, scan }) => {
    await open('#/containers')
    await page.keyboard.press('Control+k')
    const box = page.getByRole('combobox')
    await box.fill('postgres:17')
    await scan('S19 quick search')
    await page.getByRole('option', { name: /postgres:17.*438 MB/ }).click()
    await expect(page).toHaveURL(/#\/images\/sha256(:|%3A)9a4c3e7d2b1f$/)
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('group', { name: 'Recent' })).toContainText('postgres:17')
  })

  test('X6 light theme applies and keeps the layout', async ({ page, open }) => {
    await open('#/settings/general')
    await page.getByRole('combobox', { name: 'Theme' }).click()
    await page.getByRole('option', { name: 'Light' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByRole('link', { name: /Containers/ }).click()
    await expect(page.getByRole('table', { name: 'Containers' })).toBeVisible()
  })
})

test.describe('X5 time words in another locale', () => {
  test.use({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })
  test('X5 relative times stay English under pt-BR', async ({ page, open }) => {
    await open('#/containers')
    await expect(page.getByRole('table', { name: 'Containers' })).toContainText('ago')
    await expect(page.getByRole('main')).not.toContainText(/\bhá \d|horas|ontem/)
  })
})
