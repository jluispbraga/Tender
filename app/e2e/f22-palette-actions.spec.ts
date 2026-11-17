import { expect, row, test } from './fixtures'

test.describe('F22 actions in quick search', () => {
  test('F22-H1 actions show only once something is typed', async ({ page, open }) => {
    await open('#/containers')
    await page.keyboard.press('Control+k')
    const box = page.getByRole('combobox')
    await expect(page.getByRole('option', { name: /^Stop / })).toHaveCount(0)
    await box.fill('stop shop-web')
    await expect(page.getByRole('option', { name: 'Stop shop-web-1' })).toBeVisible()
  })

  test('F22-H2 stop a container from quick search', async ({ page, open }) => {
    await open('#/containers')
    await page.keyboard.press('Control+k')
    await page.getByRole('combobox').fill('stop telemetry')
    await page.getByRole('option', { name: /^Stop telemetry-collector/ }).click()
    await expect(page.getByText(/^Stopped telemetry-collector/).first()).toBeVisible()
    await expect(row(page, 'Containers', 'telemetry-collector')).toContainText('Exited')
  })

  test('F22-H3 go to a page from quick search', async ({ page, open }) => {
    await open('#/containers')
    await page.keyboard.press('Control+k')
    await page.getByRole('combobox').fill('networks')
    await page.getByRole('option', { name: 'Networks' }).first().click()
    await expect(page.getByRole('heading', { name: 'Networks' })).toBeVisible()
  })
})
