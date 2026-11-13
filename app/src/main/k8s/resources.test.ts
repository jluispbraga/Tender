import { describe, expect, it } from 'vitest'
import type { V1Job } from '@kubernetes/client-node'
import { duration, jobStatus, manualJobName } from './resources'

describe('duration: how long a job ran, as kubectl shows it', () => {
  const t0 = '2026-01-01T00:00:00Z'
  const at = (s: number) => new Date(Date.parse(t0) + s * 1000).toISOString()
  it.each([
    [0, '0s'],
    [45, '45s'],
    [60, '1m'],
    [192, '3m12s'],
    [3600, '1h'],
    [7500, '2h5m'],
    [90000, '1d1h'],
  ])('%is → %s', (s, text) => expect(duration(t0, at(s))).toBe(text))
  it('is empty for a job that has not started', () => expect(duration(undefined, at(5))).toBe(''))
})

describe('jobStatus', () => {
  const job = (status: V1Job['status'], suspend = false): V1Job => ({ spec: { template: {}, suspend }, status })
  it('reads the conditions first', () => {
    expect(jobStatus(job({ conditions: [{ type: 'Complete', status: 'True' }] }))).toBe('Complete')
    expect(jobStatus(job({ conditions: [{ type: 'Failed', status: 'True' }], active: 0 }))).toBe('Failed')
  })
  it('then suspended, running or pending', () => {
    expect(jobStatus(job({}, true))).toBe('Suspended')
    expect(jobStatus(job({ active: 1 }))).toBe('Running')
    expect(jobStatus(job({}))).toBe('Pending')
  })
})

describe('manualJobName: a run started by hand from a CronJob', () => {
  it('adds a manual suffix', () => expect(manualJobName('nightly', 1_700_000_000_000)).toMatch(/^nightly-manual-[0-9a-z]+$/))
  it('stays within the 63 characters a name may have', () => {
    const n = manualJobName('a'.repeat(70) + '-report', 1_700_000_000_000)
    expect(n.length).toBeLessThanOrEqual(63)
    expect(n).toMatch(/^a+-manual-[0-9a-z]+$/)
  })
})
