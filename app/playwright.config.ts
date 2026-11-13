import { defineConfig } from '@playwright/test'

// Web specs: the renderer on the fake engine (fresh seed data per page load).
// Electron specs live in e2e-electron/ and have their own config.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  // CI runners are slower and noisier: one retry, and a retried pass still shows as flaky in the report.
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  // On CI, failures also show as annotations on the run page (readable without signing in).
  reporter: [['list'], ['json', { outputFile: 'playwright-report/results.json' }], ...(process.env.CI ? [['github'] as const] : [])],
  use: {
    baseURL: 'http://localhost:5174',
    // The installed Chrome; no browser download needed.
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:design',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
