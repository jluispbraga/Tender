import { expect, test } from './fixtures'

const nginx = '#/images/sha256%3A7f1e2a9c4b3d'

test.describe('F16 registries, tag and push', () => {
  test('F16-H1 a login is checked, saved and can be removed', async ({ page, open, scan }) => {
    await open('#/settings/registries')
    const form = page.getByRole('form', { name: 'Add a login' })
    await form.getByLabel('Registry').fill('ghcr.io')
    await form.getByLabel('User name').fill('me')
    await form.getByLabel('Password or token').fill('wrong')
    await form.getByRole('button', { name: 'Log in' }).click()
    await expect(form.getByText('ghcr.io didn’t accept that user name and password.')).toBeVisible()
    await scan('settings registries')
    await form.getByLabel('Password or token').fill('ghp_token')
    await form.getByRole('button', { name: 'Log in' }).click()
    const saved = page.getByRole('list', { name: 'Saved logins' })
    await expect(saved).toContainText('ghcr.io')
    await expect(form.getByLabel('Password or token')).toHaveValue('')
    await saved.getByRole('button', { name: 'Log out of ghcr.io' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Log out' }).click()
    await expect(page.getByText('No logins yet.')).toBeVisible()
  })

  test('F16-H2 tag an image, push without a login, log in, push again', async ({ page, open, scan }) => {
    await open(nginx)
    await page.getByRole('button', { name: 'Tag', exact: true }).click()
    const tag = page.getByRole('dialog', { name: 'Tag image' })
    await tag.getByLabel('New name').fill('ghcr.io/me/web:1.0')
    await scan('tag image')
    await tag.getByRole('button', { name: 'Tag', exact: true }).click()
    await expect(page.getByText('Tagged as ghcr.io/me/web:1.0').first()).toBeVisible()

    await page.getByRole('button', { name: 'Push', exact: true }).click()
    const push = page.getByRole('dialog', { name: 'Push image' })
    await push.getByRole('combobox', { name: 'Name to push' }).click()
    await page.getByRole('option', { name: 'ghcr.io/me/web:1.0' }).click()
    await push.getByRole('button', { name: 'Push', exact: true }).click()
    await expect(push.getByRole('alert')).toContainText('Pushing to ghcr.io needs a login.')
    await push.getByRole('link', { name: 'Open Registries' }).click()

    const form = page.getByRole('form', { name: 'Add a login' })
    await form.getByLabel('Registry').fill('ghcr.io')
    await form.getByLabel('User name').fill('me')
    await form.getByLabel('Password or token').fill('ghp_token')
    await form.getByRole('button', { name: 'Log in' }).click()
    await expect(page.getByRole('list', { name: 'Saved logins' })).toContainText('ghcr.io')

    await page.goto('/' + nginx)
    await page.getByRole('button', { name: 'Push', exact: true }).click()
    await page.getByRole('combobox', { name: 'Name to push' }).click()
    await page.getByRole('option', { name: 'ghcr.io/me/web:1.0' }).click()
    await page.getByRole('dialog', { name: 'Push image' }).getByRole('button', { name: 'Push', exact: true }).click()
    await expect(page.getByText('Pushed ghcr.io/me/web:1.0').first()).toBeVisible()
  })

  test('F16-E1 a name with capitals is refused before tagging', async ({ page, open }) => {
    await open(nginx)
    await page.getByRole('button', { name: 'Tag', exact: true }).click()
    const tag = page.getByRole('dialog', { name: 'Tag image' })
    await tag.getByLabel('New name').fill('Me/Web')
    await tag.getByRole('button', { name: 'Tag', exact: true }).click()
    await expect(tag.getByText(/Use lower-case letters/)).toBeVisible()
  })
})
