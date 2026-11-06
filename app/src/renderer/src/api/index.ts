import { createFakeApi } from './fake/engine'
import type { TenderApi } from './types'

declare global {
  interface Window {
    /** Exposed by the Electron preload via contextBridge (replica-backend). */
    tender?: TenderApi
  }
}

/** The one data layer every screen uses. Real IPC when running in Electron. */
export const api: TenderApi = window.tender ?? createFakeApi()

export * from './types'
