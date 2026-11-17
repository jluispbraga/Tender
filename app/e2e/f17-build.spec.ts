import { expect, row, test } from './fixtures'

const openDialog = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Build', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Build an image' })
  await dialog.getByRole('button', { name: 'Choose…' }).click()
  await expect(dialog.getByText(String.raw`C:\code\shop`)).toBeVisible()
  return dialog
}

test.describe('F17 build an image', () => {
  test('F17-H1 build from a folder, follow the steps, open the image', async ({ page, open, scan }) => {
    await open('#/images')
    const dialog = await openDialog(page)
    await expect(dialog.getByLabel('Name and tag')).toHaveValue('shop:dev')
    await dialog.getByRole('button', { name: 'Add argument' }).click()
    await dialog.getByRole('textbox', { name: 'Name 1' }).fill('NODE_ENV')
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('production')
    await scan('build dialog')
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()

    await expect(page.getByRole('heading', { name: /shop:dev/ })).toBeVisible()
    const steps = page.getByRole('list', { name: 'Build steps' })
    await expect(steps).toContainText('[4/5] RUN npm ci --omit=dev')
    await expect(page.getByText('Built', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(steps).toContainText('cached')
    await scan('build detail')
    await page.getByRole('button', { name: 'Open image' }).click()
    await expect(page.getByRole('heading', { name: /shop:dev/ })).toBeVisible()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Images/ }).click()
    await expect(row(page, 'Images', 'shop:dev')).toHaveCount(1)
  })

  test('F17-H2 a failing build shows the error and the failed step', async ({ page, open }) => {
    await open('#/builds')
    await page.getByRole('button', { name: 'Build', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Build an image' })
    await dialog.getByRole('button', { name: 'Choose…' }).click()
    await expect(dialog.getByText(String.raw`C:\code\shop`)).toBeVisible()
    await dialog.getByLabel('Name and tag').fill('shop:fail')
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('did not complete successfully', { timeout: 10_000 })
    await expect(page.getByText('Failed', { exact: true })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Build steps' }).getByLabel('Failed')).toHaveCount(1)
    await page.getByRole('link', { name: 'Back to builds' }).click()
    await expect(page.getByRole('list', { name: 'Builds' })).toContainText('shop:fail')
  })

  test('F17-E1 a build can be cancelled', async ({ page, open }) => {
    await open('#/images')
    const dialog = await openDialog(page)
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel build' }).click()
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Build again' })).toBeVisible()
  })

  test('F17-E2 no folder, no build', async ({ page, open }) => {
    await open('#/images')
    await page.getByRole('button', { name: 'Build', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Build an image' })
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Choose the folder to build.')
  })
})
