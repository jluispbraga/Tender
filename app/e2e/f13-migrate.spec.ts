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

test.describe('F14 Docker tools on Windows', () => {
  test('F14-H1 the pipe is shared, the CLI installs, the stale context can be switched', async ({ page, open, scan }) => {
    await open('#/settings')
    await expect(page.getByRole('switch', { name: 'Let Docker tools on Windows use this engine' })).toBeChecked()
    await expect(page.getByText('Serving //./pipe/docker_engine from Docker in Ubuntu', { exact: false })).toBeVisible()
    await expect(page.getByText('docker.exe not found')).toBeVisible()
    await scan('S21 settings, Docker on Windows')
    await page.getByRole('button', { name: 'Install the Docker CLI' }).click()
    const progress = page.getByRole('list', { name: 'Install progress' })
    await expect(progress).toContainText('Add to your PATH')
    await expect(page.getByText('Open a new terminal to use docker.')).toBeVisible()
    await expect(page.getByText(/docker 29\.4\.3, installed by Tender/)).toBeVisible()
    await expect(page.getByText('The Docker CLI uses the context “desktop-linux”', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Switch to the default context' }).click()
    await expect(page.getByText('The Docker CLI uses the context', { exact: false })).toHaveCount(0)
  })
})

test.describe('F15 set up Docker in WSL', () => {
  test('F15-H1 pick a distribution, see the plan, install, see every step', async ({ page, open, scan }) => {
    await open('#/setup')
    await expect(page.getByRole('radio', { name: /Ubuntu/ })).toBeChecked()
    const box = page.getByRole('region', { name: 'Docker in Ubuntu' })
    await expect(box).toContainText('No Docker yet')
    await expect(box).toContainText('turn on systemd in /etc/wsl.conf')
    await scan('S27 set up Docker in WSL')
    await page.getByRole('button', { name: 'Install Docker Engine in Ubuntu' }).click()
    await expect(page.getByText('Docker Engine is installed and running in Ubuntu.')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('list', { name: 'Setup progress' })).toContainText('Docker 29.4.3 answers')
    await expect(page.getByLabel('Command output')).toContainText('Setting up docker-ce')
    await scan('S27 set up done')
  })

  test('F15-H2 a distribution that already runs Docker says so', async ({ page, open }) => {
    await open('#/setup')
    await page.getByRole('radio', { name: /Debian/ }).check()
    await expect(page.getByText('Docker Engine is already set up here.')).toBeVisible()
  })
})
