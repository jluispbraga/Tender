import { expect, row, test } from './fixtures'

test.describe('F21 volume backups', () => {
  test('F21-H1 back up a volume and restore it while unused', async ({ page, open, scan }) => {
    await open('#/volumes/old-scratch/containers')
    await page.getByRole('button', { name: 'Back up' }).click()
    await expect(page.getByText('Backed up old-scratch').first()).toBeVisible()
    await expect(page.getByText(/old-scratch-\d{4}-\d{2}-\d{2}\.tar\.gz/).first()).toBeVisible()
    await page.getByRole('button', { name: 'Restore…' }).click()
    await scan('restore volume')
    await page.getByRole('alertdialog').getByRole('button', { name: 'Choose backup…' }).click()
    await expect(page.getByText('Restored old-scratch').first()).toBeVisible()
  })

  test('F21-E1 a volume a running container uses is not restored', async ({ page, open }) => {
    await open('#/volumes/shop-data/containers')
    await page.getByRole('button', { name: 'Restore…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Choose backup…' }).click()
    await expect(page.getByText(/shop-db-1 is using shop-data\. Stop it first/).first()).toBeVisible()
  })

  test('F21-H2 create a volume from a backup', async ({ page, open }) => {
    await open('#/volumes')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a volume' })
    await dialog.getByLabel('Name').fill('restored-db')
    await dialog.getByRole('button', { name: 'From a backup…' }).click()
    await expect(page.getByText('Created restored-db from a backup').first()).toBeVisible()
    await expect(row(page, 'Volumes', 'restored-db')).toHaveCount(1)
  })
})
