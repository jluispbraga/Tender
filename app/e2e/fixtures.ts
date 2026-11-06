import { test as base, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

// Shared by every web spec:
// - console errors and uncaught exceptions fail the test (checked after it runs)
// - `scan(name)` runs axe on the current screen and records violations
// - `open(hash)` loads the app at a route on a fresh fake engine and waits for data

type Fixtures = {
  scan: (screen: string) => Promise<void>
  open: (hash: string) => Promise<void>
}

export const test = base.extend<Fixtures>({
  page: async ({ page }, use, info) => {
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    await use(page)
    expect(errors, `console errors in ${info.title}`).toEqual([])
  },
  open: async ({ page }, use) => {
    await use(async (hash: string) => {
      await page.goto('/' + hash)
      await expect(page.getByText('Engine running')).toBeVisible()
    })
  },
  scan: async ({ page }, use) => {
    await use(async (screen: string) => {
      // xterm's hidden helper textarea and canvases aren't ours to fix.
      const r = await new AxeBuilder({ page }).exclude('.xterm-helper-textarea').exclude('.xterm-accessibility').analyze()
      const v = r.violations.map((x) => `${screen}: ${x.id} (${x.impact}) ×${x.nodes.length}: ${x.nodes[0]?.target.join(' ')}`)
      expect.soft(v, `axe on ${screen}`).toEqual([])
    })
  },
})

export { expect }

/** The fake engine's test hook (only exists in the browser build). */
export const setEngine = (page: Page, state: 'running' | 'stopped' | 'error', error?: string) =>
  page.evaluate(([s, e]) => (window as unknown as { __harborFake: { setEngine(s: string, e?: string): void } }).__harborFake.setEngine(s!, e), [state, error] as const)

export const row = (page: Page, table: string, text: string | RegExp) => page.getByRole('table', { name: table }).getByRole('row').filter({ hasText: text })
