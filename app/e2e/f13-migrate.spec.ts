import { expect, test } from './fixtures'

test.describe('F13 move from Docker Desktop', () => {
  test('F13-H1 both engines ready: pick projects, move, see the result', async ({ page, open, scan }) => {
    await open('#/migrate')
    await expect(page.getByRole('heading', { name: 'Move from Docker Desktop' })).toBeVisible()
    await expect(page.getByText('Running, Docker 29.4.3, 9 containers')).toBeVisible()
    await expect(page.getByText('Ubuntu, Docker 28.5.1')).toBeVisible()
    const list = page.getByRole('list', { name: 'Things to move' })
    // Projects and standalone containers are picked, spare images are not.
    await expect(list.getByRole('checkbox', { name: 'Move shop' })).toBeChecked()
    await expect(list.getByRole('checkbox', { name: 'Move Images no container uses (4)' })).not.toBeChecked()
    await expect(list).toContainText('Already in WSL, left as is: grafana')
    await scan('S26 move from Docker Desktop')
    // Leave qdrant out.
    await list.getByRole('checkbox', { name: 'Move qdrant' }).click()
    await page.getByRole('button', { name: /^Move 2 items/ }).click()
    await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 10_000 })
    // shop: 3 images, 1 volume, 3 containers; analytics: 2 + 1 + 1 (grafana is already there).
    await expect(page.getByText('11 moved, 1 already there, 0 failed.')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Progress' })).toContainText('shop-db-1')
    await scan('S26 move done')
    await page.getByRole('button', { name: 'Open containers' }).click()
    await expect(page).toHaveURL(/#\/containers/)
  })

  test('F13-H2 reachable from Settings', async ({ page, open }) => {
    await open('#/settings')
    await page.getByRole('link', { name: 'Move from Docker Desktop' }).click()
    await expect(page.getByRole('heading', { name: 'Move from Docker Desktop' })).toBeVisible()
  })
})
