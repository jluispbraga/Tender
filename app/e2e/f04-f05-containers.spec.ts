import { expect, row, test } from './fixtures'

test.describe('F04 open a shell in a container', () => {
  test('F04-H1 row menu → Open terminal connects and runs a command', async ({ page, open, scan }) => {
    await open('#/containers')
    await row(page, 'Containers', 'node:22-alpine').getByRole('button', { name: 'Actions for shop-api-1' }).click()
    await page.getByRole('menuitem', { name: 'Open terminal' }).click()
    await expect(page.getByText(/^Connected\./)).toBeVisible()
    await page.locator('.xterm-helper-textarea').focus()
    for (const k of 'hostname') await page.keyboard.press(k)
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText('b7c2e9f0a1b2', { timeout: 5000 })
    await scan('S06 terminal')
  })

  test('F04-E1 a stopped container offers to start instead', async ({ page, open }) => {
    await open('#/containers/e2a7b8c9d0e1f2a3/exec')
    await expect(page.getByText('migrate-once isn’t running')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start container' })).toBeVisible()
  })

  test('F04-E2 an image without a shell says so and offers to reconnect', async ({ page, open }) => {
    await open('#/containers/f00dbabe12345678/exec')
    await expect(page.getByText('This image has no shell')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible()
  })

  test('F04-E3 switching tabs quickly causes no errors', async ({ page, open }) => {
    await open('#/containers/b7c2e9f0a1b2c3d4/exec')
    for (let i = 0; i < 4; i++) {
      await page.getByRole('tab', { name: 'Logs' }).click()
      await page.getByRole('tab', { name: 'Terminal' }).click()
    }
    await expect(page.getByText(/^Connected\./)).toBeVisible()
    await page.waitForTimeout(500)
  })
})

test.describe('F05 stop, start, pause, delete', () => {
  test('F05-H1 stop then start a container from its row', async ({ page, open }) => {
    await open('#/containers')
    const web = row(page, 'Containers', 'nginx:1.27')
    await web.getByRole('button', { name: 'Stop shop-web-1' }).click()
    await expect(web).toContainText('Exited')
    await web.getByRole('button', { name: 'Start shop-web-1' }).click()
    await expect(web).toContainText('Running')
  })

  test('F05-E1 bulk start with mixed states starts all, no error', async ({ page, open, scan }) => {
    await open('#/containers')
    await row(page, 'Containers', 'nginx:1.27').getByRole('checkbox').check()
    await row(page, 'Containers', 'shop/migrate').getByRole('checkbox').check()
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('2 containers selected')
    await scan('S03 bulk selection')
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Start' }).click()
    // migrate-once exits again with code 1 by design (it fails its migration); no toast about the request itself.
    await expect(row(page, 'Containers', 'nginx:1.27')).toContainText('Running')
    await expect(page.getByText(/Couldn’t start/)).toHaveCount(0)
  })

  test('F05-E2 double-clicking Stop ends stopped without an error', async ({ page, open }) => {
    await open('#/containers')
    const db = row(page, 'Containers', 'postgres:17')
    await db.getByRole('button', { name: 'Stop shop-db-1' }).dblclick()
    await expect(db).toContainText('Exited')
    await expect(page.getByText(/Couldn’t stop/)).toHaveCount(0)
  })

  test('F05-E3 pause and resume from the detail page', async ({ page, open }) => {
    await open('#/containers/a1f3c2d4e5b6a7c8/logs')
    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Paused')
    await page.getByRole('button', { name: 'Resume' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Running')
  })

  test('F05-E4 delete a running container: Cancel has focus, confirm removes it', async ({ page, open, scan }) => {
    await open('#/containers')
    await row(page, 'Containers', 'nginx:1.27').getByRole('button', { name: 'Actions for shop-web-1' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Running containers are stopped first')
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await scan('S18 confirm delete')
    await dialog.getByRole('button', { name: 'Delete container' }).click()
    await expect(row(page, 'Containers', 'nginx:1.27')).toHaveCount(0)
  })
})
