import { expect, test } from './fixtures'

const services = (page: import('@playwright/test').Page, project: string) => page.getByRole('table', { name: `Services in ${project}` })
const svc = (page: import('@playwright/test').Page, project: string, name: string) => services(page, project).getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })

test.describe('F18 Compose files', () => {
  test('F18-H1 the list has the running project and the added file', async ({ page, open, scan }) => {
    await open('#/compose')
    const list = page.getByRole('list', { name: 'Compose files' })
    await expect(list).toContainText('shop')
    await expect(list).toContainText('analytics')
    await expect(list.getByRole('link', { name: /analytics/ })).toContainText('down')
    await scan('compose list')
  })

  test('F18-H2 up a project that is down, then take it down', async ({ page, open, scan }) => {
    await open('#/compose')
    await page.getByRole('link', { name: /analytics/ }).click()
    await expect(svc(page, 'analytics', 'grafana')).toContainText('Not created')
    await scan('compose detail')
    await page.getByRole('button', { name: 'Up', exact: true }).click()
    await expect(page.getByRole('log', { name: 'Compose output' })).toContainText('Container analytics-grafana-1  Started', { timeout: 10_000 })
    await expect(page.getByText('Started analytics').first()).toBeVisible()
    await expect(svc(page, 'analytics', 'grafana')).toContainText('Running')

    await page.getByRole('button', { name: 'More for analytics' }).click()
    await page.getByRole('menuitem', { name: 'Down (remove containers)' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Take down' }).click()
    await expect(page.getByText('Took down analytics').first()).toBeVisible({ timeout: 10_000 })
    await expect(svc(page, 'analytics', 'grafana')).toContainText('Not created')
  })

  test('F18-H3 stop and start one service from its row', async ({ page, open }) => {
    await open('#/compose')
    await page.getByRole('link', { name: /shop/ }).click()
    await expect(svc(page, 'shop', 'web')).toContainText('Running')
    await svc(page, 'shop', 'web').getByRole('button', { name: 'Actions for web' }).click()
    await page.getByRole('menuitem', { name: 'Stop' }).click()
    await expect(page.getByText('Stopped web').first()).toBeVisible()
    await expect(svc(page, 'shop', 'web')).toContainText('Exited')
    await svc(page, 'shop', 'web').getByRole('button', { name: 'Actions for web' }).click()
    await page.getByRole('menuitem', { name: 'Start', exact: true }).click()
    await expect(svc(page, 'shop', 'web')).toContainText('Running')
  })

  test('F18-H4 edit and save the .env', async ({ page, open }) => {
    await open('#/compose')
    await page.getByRole('link', { name: /shop/ }).click()
    await page.getByRole('tab', { name: '.env' }).click()
    const box = page.getByRole('textbox', { name: '.env contents' })
    await expect(box).toHaveValue(/POSTGRES_PASSWORD=dev/)
    await box.fill('POSTGRES_PASSWORD=dev\nAPI_PORT=3100\n')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Saved .env').first()).toBeVisible()
    await page.getByRole('link', { name: 'Back to Compose files' }).click()
    await page.getByRole('link', { name: /shop/ }).click()
    await page.getByRole('tab', { name: '.env' }).click()
    await expect(page.getByRole('textbox', { name: '.env contents' })).toHaveValue(/API_PORT=3100/)
  })

  test('F18-E1 a running project links to its Compose file', async ({ page, open }) => {
    await open('#/projects/shop')
    await page.getByRole('link', { name: 'Open its Compose file' }).click()
    await expect(services(page, 'shop')).toBeVisible()
  })
})
