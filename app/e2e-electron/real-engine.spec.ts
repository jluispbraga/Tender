import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// The built app on the real Docker engine. READ-ONLY: it lists and opens
// things, never starts, stops, deletes, pulls or prunes. Settings go to a
// throwaway database so the user's own preferences aren't touched.
// Build first: npx electron-vite build

let app: ElectronApplication
let page: Page
const errors: string[] = []

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, TENDER_DB_PATH: join(mkdtempSync(join(tmpdir(), 'tender-e2e-')), 'tender.db') },
  })
  page = await app.firstWindow()
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
})

test.afterAll(async () => {
  await app?.close()
})

test('E-1 the real engine is reached and every list renders real rows', async () => {
  await expect(page.getByText('Engine running')).toBeVisible({ timeout: 20_000 })
  for (const [section, table] of [
    ['Containers', 'Containers'],
    ['Images', 'Images'],
    ['Volumes', 'Volumes'],
  ] as const) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(section) }).click()
    const rows = page.getByRole('table', { name: table }).locator('tbody tr')
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    expect(await rows.count()).toBeGreaterThan(0)
  }
  // Open the first container's logs: a read.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Containers/ }).click()
  await page.getByRole('table', { name: 'Containers' }).locator('tbody tr[tabindex="0"]').first().click()
  await expect(page.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Inspect' }).click()
  await expect(page.getByRole('tree', { name: 'Container details' })).toBeVisible()
  expect(errors).toEqual([])
})

test('E-2 the page has no Node access and the IPC layer rejects bad input', async () => {
  const r = await page.evaluate(async () => {
    const out: Record<string, unknown> = { require: typeof (window as any).require, process: typeof (window as any).process, kind: (window as any).tender.kind }
    try {
      await (window as any).tender.containers.action([], 'start')
    } catch (e) {
      out.bad = { message: (e as Error).message, status: (e as { status?: number }).status }
    }
    try {
      await (window as any).tender.containers.openPort({ publicPort: 8080, protocol: 'udp' })
    } catch (e) {
      out.badPort = (e as { status?: number }).status
    }
    return out
  })
  expect(r).toMatchObject({ require: 'undefined', process: 'undefined', kind: 'ipc', bad: { status: 400 }, badPort: 400 })
})
