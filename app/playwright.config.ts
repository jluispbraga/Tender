import { defineConfig } from '@playwright/test'

// Web specs: the renderer on the fake engine (fresh seed data per page load).
// Electron specs live in e2e-electron/ and have their own config.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  reporter: [['list'], ['json', { outputFile: 'playwright-report/results.json' }]],
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
