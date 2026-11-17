import { expect, test } from './fixtures'

test.describe('F19 vulnerability scan', () => {
  test('F19-H1 scan an image, filter by severity and by fix', async ({ page, open, scan }) => {
    await open('#/images/sha256%3A7f1e2a9c4b3d')
    await page.getByRole('button', { name: 'Scan', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: /vulnerability database|Scanning packages|Getting the scanner/ })).toBeVisible()
    const table = page.getByRole('table', { name: 'Vulnerabilities in nginx:1.27' })
    await expect(table).toBeVisible({ timeout: 10_000 })
    await expect(table.locator('tbody tr')).toHaveCount(7)
    await scan('image scan results')

    await page.getByRole('group', { name: 'Filter by severity' }).getByRole('button', { name: /High/ }).click()
    await expect(table.locator('tbody tr')).toHaveCount(3)
    await page.getByRole('switch', { name: 'Only with a fix' }).click()
    await expect(table.locator('tbody tr')).toHaveCount(2)
    await expect(table).not.toContainText('zlib1g')
  })

  test('F19-H2 a clean image says so, and the result survives leaving the page', async ({ page, open }) => {
    await open('#/images/sha256%3A1b2c3d4e5f60')
    await page.getByRole('button', { name: 'Scan', exact: true }).click()
    await expect(page.getByText('No known vulnerabilities in this image’s packages.')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('link', { name: 'Back to images' }).click()
    await page.goBack()
    await expect(page.getByText('No known vulnerabilities in this image’s packages.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Scan again' })).toBeVisible()
  })

  test('F19-E1 a scan can be cancelled', async ({ page, open }) => {
    await open('#/images/sha256%3A7f1e2a9c4b3d')
    await page.getByRole('button', { name: 'Scan', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel scan' }).click()
    await expect(page.getByRole('button', { name: 'Scan', exact: true })).toBeVisible()
    await expect(page.getByRole('table', { name: /Vulnerabilities in/ })).toHaveCount(0)
  })
})
