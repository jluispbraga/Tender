import { defineConfig } from 'vitest/config'

// Unit tests for the main process (plain Node, no Electron). The web UI is
// covered by Playwright in e2e/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // node:sqlite needs this flag before Node 22.13 (it is a no-op after).
    poolOptions: { forks: { execArgv: ['--experimental-sqlite', '--no-warnings'] } },
  },
})
