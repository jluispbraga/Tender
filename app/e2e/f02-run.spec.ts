import type { Page } from '@playwright/test'
import { expect, row, test } from './fixtures'

async function openRun(page: Page, image: string) {
  await row(page, 'Images', image).getByRole('button', { name: `Run ${image}` }).click()
  const dialog = page.getByRole('dialog', { name: `Run ${image}` })
  await expect(dialog).toBeVisible()
  return dialog
}

async function addPort(page: Page, host: string, container: string) {
  const dialog = page.getByRole('dialog')
  const toggle = dialog.getByRole('button', { name: 'Ports, volumes and environment' })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await dialog.getByRole('button', { name: 'Add port' }).click()
  await dialog.getByLabel('Host port 1', { exact: true }).fill(host)
  await dialog.getByLabel('Container port 1', { exact: true }).fill(container)
}

const containerCount = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Containers/ }).innerText()

test.describe('F02 run an image with a port', () => {
  test('F02-H1 run busybox with a name and a port, land on its logs', async ({ page, open, scan }) => {
    await open('#/images')
    await scan('S11 images')
    const dialog = await openRun(page, 'busybox:1.37')
    await dialog.getByLabel('Container name').fill('tiny-box')
    await addPort(page, '8081', '80')
    await scan('S13 run dialog')
    await dialog.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page).toHaveURL(/#\/containers\/[0-9a-f]+\/logs$/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('tiny-box')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Running')
  })

  test('F02-E1 a taken host port is explained and nothing is created', async ({ page, open }) => {
    await open('#/images')
    const before = await containerCount(page)
    const dialog = await openRun(page, 'busybox:1.37')
    await addPort(page, '3000', '80')
    await dialog.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText(/3000 is already used by shop-api-1/)
    await page.keyboard.press('Escape')
    expect(await containerCount(page)).toBe(before)
  })

  test('F02-E2 an invalid port is caught before sending', async ({ page, open }) => {
    await open('#/images')
    const dialog = await openRun(page, 'busybox:1.37')
    await addPort(page, 'abc', '80')
    await dialog.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(dialog.getByText('Both sides need a port number between 1 and 65535.')).toBeVisible()
    await expect(dialog.getByLabel('Host port 1', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  })

  test('F02-E3 a duplicate name is refused', async ({ page, open }) => {
    await open('#/images')
    const dialog = await openRun(page, 'nginx:1.27')
    await dialog.getByLabel('Container name').fill('shop-web-1')
    await dialog.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText(/already exists/)
  })

  test('F02-E4 accents and emoji in the name are refused with a reason', async ({ page, open }) => {
    await open('#/images')
    const before = await containerCount(page)
    const dialog = await openRun(page, 'busybox:1.37')
    await dialog.getByLabel('Container name').fill('café-🚀')
    await dialog.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText(/letters, digits/)
    await page.keyboard.press('Escape')
    expect(await containerCount(page)).toBe(before)
  })

  test('F02-E5 double-clicking Run creates exactly one container', async ({ page, open }) => {
    await open('#/images')
    const before = Number((await containerCount(page)).replace(/\D/g, ''))
    const dialog = await openRun(page, 'busybox:1.37')
    await dialog.getByLabel('Container name').fill('once-only')
    await dialog.getByRole('button', { name: 'Run', exact: true }).dblclick()
    await expect(page).toHaveURL(/#\/containers\/[0-9a-f]+\/logs$/)
    await expect.poll(async () => Number((await containerCount(page)).replace(/\D/g, ''))).toBe(before + 1)
    await page.waitForTimeout(800)
    expect(Number((await containerCount(page)).replace(/\D/g, ''))).toBe(before + 1)
  })

  test('F02-E6 Escape closes the dialog, creates nothing, returns focus', async ({ page, open }) => {
    await open('#/images')
    const trigger = row(page, 'Images', 'busybox:1.37').getByRole('button', { name: 'Run busybox:1.37' })
    await trigger.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByLabel('Container name')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})
