import { expect, test } from './fixtures'

test.describe('F25 choose the engine', () => {
  test('F25-H1 switch to a WSL distribution and back to automatic', async ({ page, open, scan }) => {
    await open('#/settings/engine')
    const list = page.getByRole('list', { name: 'Engines' })
    await expect(list.getByRole('button', { name: /Automatic/ })).toHaveAttribute('aria-pressed', 'true')
    await scan('settings engine')
    await list.getByRole('button', { name: /WSL: Ubuntu/ }).click()
    await expect(page.getByText('Connected to wsl://Ubuntu').first()).toBeVisible()
    await expect(list.getByRole('button', { name: /WSL: Ubuntu/ })).toHaveAttribute('aria-pressed', 'true')
    await list.getByRole('button', { name: /Automatic/ }).click()
    await expect(list.getByRole('button', { name: /Automatic/ })).toHaveAttribute('aria-pressed', 'true')
  })

  test('F25-H2 connect to a typed address; a bad one is refused', async ({ page, open }) => {
    await open('#/settings/engine')
    const form = page.getByRole('form', { name: 'Another engine' })
    await form.getByLabel('Another engine').fill('http://box:2375')
    await form.getByRole('button', { name: 'Connect' }).click()
    await expect(form.getByText(/Use an address like tcp:\/\/host:2375/)).toBeVisible()
    await form.getByLabel('Another engine').fill('ssh://me@build-box')
    await form.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByRole('list', { name: 'Engines' }).getByRole('button', { name: /Custom address/ })).toHaveAttribute('aria-pressed', 'true')
  })
})
