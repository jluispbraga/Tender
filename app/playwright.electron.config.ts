import { defineConfig } from '@playwright/test'

// Read-only checks of the built app against the real Docker engine.
// npx electron-vite build && npx playwright test -c playwright.electron.config.ts
export default defineConfig({
  testDir: 'e2e-electron',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
})
