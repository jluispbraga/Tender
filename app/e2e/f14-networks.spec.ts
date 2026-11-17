import { expect, row, test } from './fixtures'

test.describe('F14 networks', () => {
  test('F14-H1 the list shows who is on each network', async ({ page, open, scan }) => {
    await open('#/networks')
    await expect(page.getByRole('heading', { name: 'Networks' })).toBeVisible()
    await expect(row(page, 'Networks', 'shop_default').locator('[title*="shop-web-1"]')).toContainText('4')
    await expect(row(page, 'Networks', 'backend-internal')).toContainText('internal')
    await expect(row(page, 'Networks', 'analytics_default')).toContainText('Unused')
    await expect(row(page, 'Networks', /^host/)).toContainText('built in')
    await scan('networks list')
  })

  test('F14-H2 details list the containers with their addresses', async ({ page, open, scan }) => {
    await open('#/networks')
    await row(page, 'Networks', 'backend-internal').click()
    const members = page.getByRole('table', { name: 'Containers on backend-internal' })
    await expect(members.getByRole('row')).toHaveCount(3) // header + shop-api-1 + shop-db-1
    await expect(members).toContainText('172.30.0.')
    await expect(page.getByText('No (internal)')).toBeVisible()
    await scan('network detail')
  })

  test('F14-H3 create a network, connect a container, disconnect it', async ({ page, open, scan }) => {
    await open('#/networks')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a network' })
    await dialog.getByLabel('Name').fill('payments')
    await dialog.getByLabel('Subnet (optional)').fill('172.40.0.0/24')
    await scan('create network')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByText('Created payments').first()).toBeVisible()
    await expect(page.getByRole('heading', { name: /payments/ })).toBeVisible()
    await expect(page.getByText('No container is on this network.')).toBeVisible()

    await page.getByRole('button', { name: 'Connect container' }).click()
    const connect = page.getByRole('dialog', { name: 'Connect a container to payments' })
    await connect.getByRole('combobox', { name: 'Container' }).click()
    await page.getByRole('option', { name: 'shop-api-1' }).click()
    await connect.getByRole('button', { name: 'Connect', exact: true }).click()
    const members = page.getByRole('table', { name: 'Containers on payments' })
    await expect(members).toContainText('shop-api-1')
    await expect(members).toContainText('172.40.0.2')

    await members.getByRole('button', { name: 'Disconnect shop-api-1' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click()
    await expect(page.getByText('No container is on this network.')).toBeVisible()
  })

  test('F14-E1 a network in use cannot be deleted', async ({ page, open }) => {
    await open('#/networks')
    await row(page, 'Networks', 'shop_default').getByRole('button', { name: 'Actions for shop_default' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Disconnect or remove those containers first.')
    await expect(dialog.getByRole('button', { name: 'Delete network' })).toHaveCount(0)
  })

  test('F14-E2 built-in networks have no delete', async ({ page, open }) => {
    await open('#/networks')
    await row(page, 'Networks', /^none/).getByRole('button', { name: 'Actions for none' }).click()
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
  })

  test('F14-E3 Remove unused deletes only the unused ones', async ({ page, open }) => {
    await open('#/networks')
    await page.getByRole('button', { name: 'Remove unused' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete network' }).click()
    await expect(page.getByText('Deleted analytics_default').first()).toBeVisible()
    await expect(row(page, 'Networks', 'analytics_default')).toHaveCount(0)
    await expect(row(page, 'Networks', 'shop_default')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Remove unused' })).toHaveCount(0)
  })

  test('F14-E4 a bad subnet and a taken name are refused inline', async ({ page, open }) => {
    await open('#/networks')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a network' })
    await dialog.getByLabel('Name').fill('shop_default')
    await dialog.getByLabel('Subnet (optional)').fill('172.30.0/24')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog.getByText('Write it as an IPv4 range, like 172.30.0.0/24.')).toBeVisible()
    await dialog.getByLabel('Subnet (optional)').fill('')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog.getByText('A network called shop_default already exists.')).toBeVisible()
  })
})
