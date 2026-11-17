import { expect, row, test } from './fixtures'

// shop-api-1: running, listens on 3000. migrate-once: exited.
const api = '#/containers/b7c2e9f0a1b2c3d4/logs'

test.describe('F20 temporary public links', () => {
  test('F20-H1 create a link, see it in the footer, close it', async ({ page, open, scan }) => {
    await open(api)
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Share shop-api-1' })
    await expect(dialog).toContainText('Anyone with the link can reach this port')
    await scan('share dialog')
    await dialog.getByRole('button', { name: 'Create link' }).click()
    const links = dialog.getByRole('list', { name: 'Links to shop-api-1' })
    await expect(links).toContainText(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    await expect(links).toContainText('port 3000 of shop-api-1')
    await dialog.getByRole('button', { name: 'Done' }).click()

    await expect(page.getByRole('button', { name: 'Shared', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '1 public link open' }).click()
    const pop = page.getByRole('dialog', { name: 'Public links' })
    await expect(pop).toContainText('trycloudflare.com')
    await pop.getByRole('button', { name: 'Close link' }).click()
    await expect(page.getByText('Closed the link to shop-api-1:3000').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /public link/ })).toHaveCount(0)
  })

  test('F20-H2 share from the container’s menu in the list', async ({ page, open }) => {
    await open('#/containers')
    const name = 'telemetry-collector-for-the-platform-observability-stack-01'
    await row(page, 'Containers', name).getByRole('button', { name: `Actions for ${name}` }).click()
    await page.getByRole('menuitem', { name: 'Share with a public link…' }).click()
    const dialog = page.getByRole('dialog', { name: `Share ${name}` })
    await dialog.getByRole('button', { name: 'Create link' }).click()
    await expect(dialog.getByRole('list', { name: `Links to ${name}` })).toContainText('trycloudflare.com')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('button', { name: '1 public link open' })).toBeVisible()
  })

  test('F20-E1 a stopped container can’t be shared', async ({ page, open }) => {
    await open('#/containers/e2a7b8c9d0e1f2a3/logs')
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeDisabled()
  })

  test('F20-E2 sharing the same port twice reuses the link', async ({ page, open }) => {
    await open(api)
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Share shop-api-1' })
    await dialog.getByRole('button', { name: 'Create link' }).click()
    await expect(dialog.getByRole('list', { name: 'Links to shop-api-1' }).getByRole('listitem')).toHaveCount(1)
    await dialog.getByRole('button', { name: 'Create link' }).click()
    await expect(dialog.getByRole('button', { name: 'Create link' })).toBeEnabled()
    await expect(dialog.getByRole('list', { name: 'Links to shop-api-1' }).getByRole('listitem')).toHaveCount(1)
  })
})
