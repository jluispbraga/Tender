import type { TenderApi } from '../types'

// What the Electron build gets instead of the fake engine (electron.vite.config.ts
// swaps it in): the app always has the real preload API, so the fake and its seed
// data stay out of the bundle. Reaching this means the preload failed to load.
export function createFakeApi(): TenderApi {
  throw new Error('Tender’s preload did not load, so the app cannot reach its engine. Reinstall Tender if this keeps happening.')
}
