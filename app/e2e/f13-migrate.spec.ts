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

test.describe('F16 checkup', () => {
  test('F16-H1 problems show with their fix; fixing one checks again', async ({ page, open, scan }) => {
    await open('#/containers')
    await page.getByRole('link', { name: 'Troubleshoot' }).click()
    const doctor = page.getByRole('region', { name: 'Checkup' })
    await expect(doctor).toContainText('2 things need attention')
    await expect(doctor).toContainText('Docker in Ubuntu lost its socket')
    await scan('S23 checkup')
    await doctor.getByRole('button', { name: 'Repair Docker in Ubuntu' }).click()
    await expect(page.getByText('Docker in Ubuntu has its socket back.', { exact: true })).toBeVisible()
    await expect(doctor).toContainText('Docker Engine runs in Ubuntu')
    await expect(doctor).toContainText('1 thing needs attention')
  })
})

test.describe('F17 WSL memory and disk', () => {
  test('F17-H1 memory reclaim, a sparse disk, giving space back, clearing build cache', async ({ page, open, scan }) => {
    await open('#/containers')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Memory and disk/ }).click()
    await expect(page.getByRole('heading', { name: 'Memory and disk', level: 1 })).toBeVisible()
    await expect(page.getByRole('meter', { name: 'WSL holds' })).toBeVisible()
    await expect(page.getByText('could go back to Windows')).toBeVisible()
    await scan('S28 memory and disk')
    await page.getByRole('combobox', { name: 'Give memory back' }).click()
    await page.getByRole('option', { name: 'Gradually (recommended)' }).click()
    await expect(page.getByRole('combobox', { name: 'Give memory back' })).toContainText('Gradually')
    await page.getByRole('button', { name: 'Make it sparse' }).click()
    await expect(page.getByText('sparse disk', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Give space back now' }).click()
    await expect(page.getByText('trimmed', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Clear unused build cache' }).click()
    await expect(page.getByRole('button', { name: 'Clear unused build cache' })).toBeDisabled()
  })
})

test.describe('F18 Kubernetes (read-only)', () => {
  test('F18-H1 pods, deployments, services, and a pod log', async ({ page, open, scan }) => {
    await open('#/containers')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Kubernetes/ }).click()
    const pods = page.getByRole('table', { name: 'Pods' })
    await expect(pods).toContainText('worker-5c6d7f8-abcde')
    await expect(pods).toContainText('CrashLoopBackOff')
    await expect(page.getByText('Read-only: Tender lists and shows logs', { exact: false })).toBeVisible()
    await scan('S29 kubernetes')
    await page.getByRole('button', { name: 'Logs of web-7d9f8b6c5-x2k4p' }).click()
    await expect(page.getByLabel('Log lines')).toContainText('web-7d9f8b6c5-x2k4p line 2')
    await page.getByRole('tab', { name: /deployments/i }).click()
    await expect(page.getByRole('table', { name: 'Deployments' })).toContainText('shop/web:1.4.2')
    await page.getByRole('tab', { name: /services/i }).click()
    await expect(page.getByRole('table', { name: 'Services' })).toContainText('80:30080/TCP')
  })

  test('F18-E1 a cluster that is not running says so', async ({ page, open }) => {
    await open('#/containers')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Kubernetes/ }).click()
    await page.getByRole('combobox', { name: 'Context' }).click()
    await page.getByRole('option', { name: 'minikube' }).click()
    await expect(page.getByText('minikube did not answer within 6 s. Is the cluster running?')).toBeVisible()
  })
})
