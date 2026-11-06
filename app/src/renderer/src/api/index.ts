import { createFakeApi } from './fake/engine'
import type { HarborApi } from './types'

declare global {
  interface Window {
    /** Exposed by the Electron preload via contextBridge (replica-backend). */
    harbor?: HarborApi
  }
}

/** The one data layer every screen uses. Real IPC when running in Electron. */
export const api: HarborApi = window.harbor ?? createFakeApi()

export * from './types'
