// Runs the unit tests (Vitest) on Electron's own Node, the runtime the main
// process ships with, instead of whatever Node is on the PATH.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')
const vitest = require.resolve('vitest/vitest.mjs')
const r = spawnSync(electron, [vitest, 'run', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
process.exit(r.status ?? 1)
