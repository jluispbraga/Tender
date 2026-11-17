import { useSyncExternalStore } from 'react'
import { api, type BuildSpec, type BuildStep, type LogLine } from '@/api'
import { queryClient, keys } from './queries'

// Builds started in this window. They live here, not in a page, so leaving
// the build screen doesn't stop the build or lose its log.

export interface BuildRun {
  id: string
  spec: BuildSpec
  state: 'running' | 'done' | 'failed' | 'cancelled'
  steps: BuildStep[]
  lines: LogLine[]
  startedAt: string
  endedAt?: string
  imageId?: string
  error?: string
}

let runs: BuildRun[] = []
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())
const update = (id: string, f: (r: BuildRun) => BuildRun) => {
  runs = runs.map((r) => (r.id === id ? f(r) : r))
  changed()
}

/** Keeps the log bounded: a noisy build can print hundreds of thousands of lines. */
const MAX_LINES = 20_000

export function startBuild(spec: BuildSpec): string {
  const handle = api.builds.start(spec, (e) => {
    if (e.type === 'steps') update(handle.buildId, (r) => ({ ...r, steps: e.steps }))
    else {
      const ts = new Date().toISOString()
      update(handle.buildId, (r) => ({ ...r, lines: [...r.lines, ...e.lines.map((text) => ({ ts, stream: 'stdout' as const, text }))].slice(-MAX_LINES) }))
    }
  })
  const run: BuildRun = { id: handle.buildId, spec, state: 'running', steps: [], lines: [], startedAt: new Date().toISOString() }
  runs = [run, ...runs].slice(0, 30)
  changed()
  handle.done.then(
    ({ imageId }) => {
      update(handle.buildId, (r) => ({ ...r, state: 'done', imageId, endedAt: new Date().toISOString() }))
      void queryClient.invalidateQueries({ queryKey: keys.images })
    },
    (e: Error & { status?: number }) =>
      update(handle.buildId, (r) => ({ ...r, state: e.status === 499 ? 'cancelled' : 'failed', error: e.message, endedAt: new Date().toISOString() })),
  )
  return handle.buildId
}

export const cancelBuild = (id: string) => api.builds.cancel(id)

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useBuilds = () => useSyncExternalStore(subscribe, () => runs)
