// Screenshots for the README, taken from the renderer on the fake engine.
// Start `npm run dev:design` first, then: node scripts/shots.mjs
// Output: ../docs/screenshots/*.png (sample data only, nothing from this machine).
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url))
mkdirSync(out, { recursive: true })

const base = process.env.SHOTS_URL ?? 'http://localhost:5174'
const shots = [
  { name: 'containers', hash: '#/containers', scheme: 'dark' },
  { name: 'logs', hash: '#/containers/b7c2e9f0a1b2c3d4/logs', scheme: 'dark' },
  { name: 'images', hash: '#/images', scheme: 'light' },
  { name: 'kubernetes', hash: '#/kubernetes', scheme: 'dark' },
  { name: 'resources', hash: '#/resources', scheme: 'light' },
]

const browser = await chromium.launch({ channel: 'chrome' })
for (const s of shots) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: s.scheme,
    locale: 'en-US',
    // The fake engine takes its platform from the user agent: show the Windows app.
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  })
  await page.goto(base + '/' + s.hash)
  await page.getByText('Engine running').waitFor()
  await page.locator('[data-page-loading]').waitFor({ state: 'detached' }).catch(() => {})
  await page.waitForTimeout(1500) // charts and live logs fill in
  await page.screenshot({ path: `${out}${s.name}.png` })
  await page.close()
  console.log('saved', s.name)
}
await browser.close()
