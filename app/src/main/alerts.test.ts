import { describe, expect, it, vi } from 'vitest'

vi.mock('./tools/resources', () => ({ status: vi.fn() }))

import { startAlerts } from './alerts'
import type { Engine } from './engine/engine'

type Signal = { kind: 'oom' | 'die'; id: string; name: string; exitCode: number; expected: boolean }

function fakeEngine() {
  let listener: ((s: Signal) => void) | null = null
  const engine = { onContainerSignal: (fn: (s: Signal) => void) => ((listener = fn), () => (listener = null)) } as unknown as Engine
  return { engine, emit: (s: Partial<Signal>) => listener?.({ kind: 'die', id: 'c1', name: 'api', exitCode: 1, expected: false, ...s }) }
}

describe('alerts', () => {
  it('says when a container is killed for memory', () => {
    const { engine, emit } = fakeEngine()
    const notify = vi.fn()
    startAlerts(engine, notify, () => true, 'linux')
    emit({ kind: 'oom' })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'api ran out of memory', objectId: 'c1' }))
  })

  it('says once when a container dies three times in a few minutes', () => {
    const { engine, emit } = fakeEngine()
    const notify = vi.fn()
    startAlerts(engine, notify, () => true, 'linux')
    emit({})
    emit({})
    expect(notify).not.toHaveBeenCalled()
    emit({ exitCode: 3 })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0].title).toBe('api keeps restarting')
    expect(notify.mock.calls[0][0].body).toContain('exit code 3')
    emit({})
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('ignores stops the person asked for, and everything when turned off', () => {
    const { engine, emit } = fakeEngine()
    const notify = vi.fn()
    let on = true
    startAlerts(engine, notify, () => on, 'linux')
    for (let i = 0; i < 5; i++) emit({ expected: true })
    expect(notify).not.toHaveBeenCalled()
    on = false
    emit({ kind: 'oom' })
    expect(notify).not.toHaveBeenCalled()
  })
})
