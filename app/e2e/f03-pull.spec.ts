import type { Page } from '@playwright/test'
import { expect, row, test } from './fixtures'

async function startPull(page: Page, ref: string) {
  await page.getByRole('main').getByRole('button', { name: 'Pull', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Pull an image' })
  await dialog.getByLabel('Image').fill(ref)
  await dialog.getByRole('button', { name: 'Pull', exact: true }).click()
  return dialog
}

test.describe('F03 pull an image', () => {
  test('F03-H1 pull shows progress, confirms, and lists the image', async ({ page, open, scan }) => {
    await open('#/images')
    const dialog = await startPull(page, 'httpd:2.4')
    await expect(dialog.getByText(/of \d+ layers complete/)).toBeVisible()
    await scan('S14 pull progress')
    await expect(dialog).toHaveCount(0, { timeout: 20_000 })
    await expect(page.getByText('Pulled httpd:2.4').first()).toBeVisible()
    await expect(row(page, 'Images', 'httpd:2.4')).toHaveCount(1)
  })

  test('F03-N1 a name that does not exist is explained inline', async ({ page, open }) => {
    await open('#/images')
    const dialog = await startPull(page, 'ngnix:latest')
    await expect(dialog.getByText(/No image called ngnix:latest/)).toBeVisible()
    await expect(dialog.getByLabel('Image')).toHaveAttribute('aria-invalid', 'true')
  })

  test('F03-N2 a private image says to log in', async ({ page, open }) => {
    await open('#/images')
    const dialog = await startPull(page, 'private/app:1')
    await expect(dialog.getByText(/docker login/)).toBeVisible()
  })

  test('F03-N3 a malformed reference is refused', async ({ page, open }) => {
    await open('#/images')
    const dialog = await startPull(page, 'Not A Ref!')
    await expect(dialog.getByText(/isn’t a valid image reference/)).toBeVisible()
  })

  test('F03-E1 empty input asks for a reference', async ({ page, open }) => {
    await open('#/images')
    const dialog = await startPull(page, '')
    await expect(dialog.getByText(/Enter an image reference/)).toBeVisible()
  })

  test('F03-E2 cancel stops the pull and adds nothing', async ({ page, open }) => {
    await open('#/images')
    const before = await page.getByRole('table', { name: 'Images' }).locator('tbody tr').count()
    const dialog = await startPull(page, 'redis:8')
    await dialog.getByRole('button', { name: 'Cancel pull' }).click()
    await expect(dialog.getByText('Pull cancelled.')).toBeVisible()
    await page.keyboard.press('Escape')
    expect(await page.getByRole('table', { name: 'Images' }).locator('tbody tr').count()).toBe(before)
  })

  test('F03-E3 hiding the dialog keeps pulling and reports when done', async ({ page, open }) => {
    await open('#/images')
    const dialog = await startPull(page, 'alpine:3.22')
    await dialog.getByRole('button', { name: 'Hide, keep pulling' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('Pulled alpine:3.22').first()).toBeVisible({ timeout: 20_000 })
    await expect(row(page, 'Images', 'alpine:3.22')).toHaveCount(1)
  })
})
