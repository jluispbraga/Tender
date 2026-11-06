import { expect, row, test } from './fixtures'

test.describe('F06 manage a Compose stack', () => {
  test('F06-H1 open the project and restart all', async ({ page, open, scan }) => {
    await open('#/containers')
    await page.getByRole('button', { name: 'Actions for project shop' }).click()
    await page.getByRole('menuitem', { name: 'Open project' }).click()
    await expect(page).toHaveURL(/#\/projects\/shop$/)
    await expect(page.getByRole('table', { name: 'Services in shop' }).locator('tbody tr')).toHaveCount(4)
    await scan('S10 project')
    await page.getByRole('button', { name: 'Restart all' }).click()
    await expect(row(page, 'Services in shop', 'nginx:1.27')).toContainText('Running')
    await expect(page.getByText(/Couldn’t restart/)).toHaveCount(0)
  })

  test('F06-E1 the log filter shows one service', async ({ page, open }) => {
    await open('#/projects/shop')
    await page.getByRole('combobox', { name: 'Show logs from' }).click()
    await page.getByRole('option', { name: 'db' }).click()
    const log = page.getByRole('log', { name: 'Combined logs' })
    await expect(log).toContainText('database system is ready')
    const sources = await log.locator('[data-line] > span:first-child').allInnerTexts()
    expect(new Set(sources)).toEqual(new Set(['db']))
  })

  test('F06-E2 collapse the group; the group checkbox selects its services', async ({ page, open }) => {
    await open('#/containers')
    const toggle = page.getByRole('button', { name: /^shop/, expanded: true })
    await toggle.click()
    await expect(row(page, 'Containers', 'nginx:1.27')).toHaveCount(0)
    await page.getByRole('button', { name: /^shop/, expanded: false }).click()
    await page.getByRole('checkbox', { name: 'Select all in shop' }).check()
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('4 containers selected')
  })

  test('F06-E3 deleting the project containers empties the project page', async ({ page, open }) => {
    await open('#/projects/shop')
    await page.getByRole('button', { name: 'Delete the project’s containers' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete containers' }).click()
    await expect(page.getByRole('heading', { name: 'No containers left in shop' })).toBeVisible()
  })
})
