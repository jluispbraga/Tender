import { expect, row, test } from './fixtures'

test.describe('F15 remove unused volumes', () => {
  test('F15-H1 Remove unused deletes only volumes no container mounts', async ({ page, open }) => {
    await open('#/volumes')
    await page.getByRole('button', { name: 'Remove unused' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('old-scratch')
    await expect(dialog).not.toContainText('shop-data')
    await dialog.getByRole('button', { name: 'Delete volume' }).click()
    await expect(row(page, 'Volumes', 'old-scratch')).toHaveCount(0)
    await expect(row(page, 'Volumes', 'shop-data')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Remove unused' })).toHaveCount(0)
  })
})
