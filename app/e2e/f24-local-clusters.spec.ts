import { expect, test } from './fixtures'

test.describe('F24 local clusters', () => {
  test('F24-H1 create a k3d cluster, then delete it', async ({ page, open, scan }) => {
    await open('#/kubernetes')
    await page.getByRole('button', { name: 'Local clusters' }).click()
    const dialog = page.getByRole('dialog', { name: 'Local clusters' })
    const list = dialog.getByRole('list', { name: 'Clusters' })
    await expect(list).toContainText('kind-dev')
    await scan('local clusters')
    await dialog.getByRole('combobox', { name: 'Tool' }).click()
    await page.getByRole('option', { name: 'k3d' }).click()
    await dialog.getByLabel('Name').fill('demo')
    await dialog.getByRole('button', { name: 'Create cluster' }).click()
    await expect(dialog.getByRole('log', { name: 'Cluster output' })).toContainText('Set kubectl context to "k3d-demo"')
    await expect(list).toContainText('k3d-demo')
    await list.getByRole('button', { name: 'Delete demo' }).click()
    await list.getByRole('group', { name: 'Confirm deleting demo' }).getByRole('button', { name: 'Delete' }).click()
    await expect(list).not.toContainText('k3d-demo')
  })

  test('F24-E1 a taken or invalid name is refused', async ({ page, open }) => {
    await open('#/kubernetes')
    await page.getByRole('button', { name: 'Local clusters' }).click()
    const dialog = page.getByRole('dialog', { name: 'Local clusters' })
    await expect(dialog.getByRole('list', { name: 'Clusters' })).toContainText('kind-dev')
    await dialog.getByRole('button', { name: 'Create cluster' }).click()
    await expect(dialog.getByRole('alert')).toContainText('A kind cluster called dev already exists.')
    await dialog.getByLabel('Name').fill('Bad Name')
    await dialog.getByRole('button', { name: 'Create cluster' }).click()
    await expect(dialog.getByRole('alert')).toContainText('lower-case letters')
  })
})
