import { expect, test } from './fixtures'

test.describe('F23 Helm releases', () => {
  test('F23-H1 list releases, read values, roll back', async ({ page, open, scan }) => {
    await open('#/kubernetes')
    await page.getByRole('tab', { name: /^Helm/ }).click()
    const table = page.getByRole('table', { name: 'Helm releases' })
    await expect(table).toContainText('nginx-15.4.2')
    await expect(table).toContainText('failed')
    await scan('helm releases')
    await table.getByRole('button', { name: 'web', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Helm release web' })
    await expect(dialog.getByLabel('Values')).toContainText('"replicaCount": 3')
    await expect(dialog.getByLabel('Values')).toContainText('••••')
    await dialog.getByRole('button', { name: /Revision 2/ }).click()
    await expect(dialog.getByLabel('Values')).toContainText('1.27.1')
    await scan('helm release dialog')
    await dialog.getByRole('button', { name: 'Roll back to this' }).click()
    await dialog.getByRole('group', { name: 'Confirm rollback to revision 2' }).getByRole('button', { name: 'Roll back' }).click()
    await expect(page.getByText('Rolled web back to revision 2.').first()).toBeVisible()
  })

  test('F23-E1 problems only keeps the failed release', async ({ page, open }) => {
    await open('#/kubernetes')
    await page.getByRole('tab', { name: /^Helm/ }).click()
    await page.getByRole('combobox', { name: 'Status' }).click()
    await page.getByRole('option', { name: 'Only problems' }).click()
    const table = page.getByRole('table', { name: 'Helm releases' })
    await expect(table).toContainText('cache')
    await expect(table.getByRole('button', { name: 'web', exact: true })).toHaveCount(0)
  })
})
