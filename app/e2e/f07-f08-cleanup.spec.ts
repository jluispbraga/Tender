import { expect, row, test } from './fixtures'

test.describe('F07 free disk space from images', () => {
  test('F07-H1 filter Untagged, select, delete', async ({ page, open }) => {
    await open('#/images')
    await page.getByRole('combobox', { name: 'Show' }).click()
    await page.getByRole('option', { name: 'Untagged' }).click()
    const rows = page.getByRole('table', { name: 'Images' }).locator('tbody tr')
    await expect(rows).toHaveCount(1)
    await page.getByRole('checkbox', { name: 'Select all' }).check()
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText(/frees about/)
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete image' }).click()
    await expect(page.getByText('Deleted 1 image').first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No images match' })).toBeVisible()
  })

  test('F07-H2 Clean up removes untagged images', async ({ page, open, scan }) => {
    await open('#/images')
    await page.getByRole('button', { name: 'Clean up' }).click()
    const dialog = page.getByRole('dialog', { name: 'Clean up images' })
    await expect(dialog.getByRole('radio', { name: /Untagged images only/ })).toBeChecked()
    await scan('S20 clean up')
    await dialog.getByRole('button', { name: 'Remove 1 image' }).click()
    await expect(page.getByText('Removed 1 image').first()).toBeVisible()
    await expect(row(page, 'Images', '<untagged>')).toHaveCount(0)
  })

  test('F07-E1 an image in use cannot be deleted', async ({ page, open }) => {
    await open('#/images')
    await row(page, 'Images', 'nginx:1.27').getByRole('button', { name: 'Actions for nginx:1.27' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('used by containers')
    await expect(dialog.getByRole('button', { name: /Delete/ })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(row(page, 'Images', 'nginx:1.27')).toHaveCount(1)
  })

  test('F07-E2 a mixed selection deletes the unused one and keeps the other', async ({ page, open }) => {
    await open('#/images')
    await row(page, 'Images', 'python:3.13-slim').getByRole('checkbox').check()
    await row(page, 'Images', 'nginx:1.27').getByRole('checkbox').check()
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Delete' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Images still used by a container are kept.')
    await dialog.getByRole('button', { name: 'Delete images' }).click()
    await expect(row(page, 'Images', 'python:3.13-slim')).toHaveCount(0)
    await expect(row(page, 'Images', 'nginx:1.27')).toHaveCount(1)
    await expect(page.getByText(/Kept 1 image/).first()).toBeVisible()
  })
})

test.describe('F08 delete volumes', () => {
  test('F08-H1 delete an unused volume', async ({ page, open, scan }) => {
    await open('#/volumes')
    await scan('S15 volumes')
    await row(page, 'Volumes', 'old-scratch').getByRole('button', { name: 'Actions for old-scratch' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete volume' }).click()
    await expect(row(page, 'Volumes', 'old-scratch')).toHaveCount(0)
  })

  test('F08-N1 a volume in use is blocked and names its container', async ({ page, open }) => {
    await open('#/volumes')
    await row(page, 'Volumes', 'shop-data').getByRole('button', { name: 'Actions for shop-data' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('shop-db-1 is using this volume')
    await expect(dialog.getByRole('button', { name: 'Delete volume' })).toHaveCount(0)
  })

  test('F08-E1 after removing its container, the volume deletes', async ({ page, open }) => {
    await open('#/containers')
    await row(page, 'Containers', 'redis:7').getByRole('button', { name: 'Actions for cache' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete container' }).click()
    await expect(row(page, 'Containers', 'redis:7')).toHaveCount(0)
    await page.getByRole('link', { name: /Volumes/ }).click()
    await expect(row(page, 'Volumes', 'cache-data')).toContainText('Unused')
    await row(page, 'Volumes', 'cache-data').getByRole('button', { name: 'Actions for cache-data' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete volume' }).click()
    await expect(row(page, 'Volumes', 'cache-data')).toHaveCount(0)
  })

  test('F08-E2 creating a volume with a taken name is refused inline', async ({ page, open, scan }) => {
    await open('#/volumes')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a volume' })
    await dialog.getByLabel('Name').fill('shop-data')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog.getByText('A volume called shop-data already exists.')).toBeVisible()
    await scan('S17 create volume')
  })

  test('F08-E3 accents in a volume name are refused inline', async ({ page, open }) => {
    await open('#/volumes')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a volume' })
    await dialog.getByLabel('Name').fill('dados-ção')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true')
  })
})
