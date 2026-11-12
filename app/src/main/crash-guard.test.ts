import { describe, expect, it } from 'vitest'
import { harmless } from './crash-guard'

describe('crash guard', () => {
  it('ignores cancelled requests, which are not failures', () => {
    // What closing a pod's log panel used to throw (Electron's raw error box).
    expect(harmless(new DOMException('This operation was aborted', 'AbortError'))).toBe(true)
    expect(harmless(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))).toBe(true)
    expect(harmless(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true)
  })

  it('reports real errors', () => {
    expect(harmless(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(false)
    expect(harmless('a string')).toBe(false)
    expect(harmless(undefined)).toBe(false)
  })
})
