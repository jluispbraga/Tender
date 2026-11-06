import { useEffect, useState } from 'react'
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type EngineEvent, type EngineStatus, type GridView, type Settings, type StatsSample } from '@/api'

export const queryClient = new QueryClient({
  defaultOptions: {
    // Lists stay fresh through the engine's event stream, not by polling.
    queries: { staleTime: Infinity, retry: 1, refetchOnWindowFocus: false },
  },
})

export const keys = {
  engine: ['engine'] as const,
  containers: ['containers'] as const,
  container: (id: string) => ['container', id] as const,
  images: ['images'] as const,
  image: (id: string) => ['image', id] as const,
  diskUsage: ['diskUsage'] as const,
  volumes: ['volumes'] as const,
  volumeUsage: (name: string) => ['volumeUsage', name] as const,
  settings: ['settings'] as const,
  grid: (v: GridView) => ['grid', v] as const,
  notifications: ['notifications'] as const,
  recent: ['recent'] as const,
}

export const useEngine = () => useQuery({ queryKey: keys.engine, queryFn: api.engine.status, staleTime: 0 })
export const useContainers = () => useQuery({ queryKey: keys.containers, queryFn: api.containers.list })
export const useImages = () => useQuery({ queryKey: keys.images, queryFn: api.images.list })
export const useVolumes = () => useQuery({ queryKey: keys.volumes, queryFn: api.volumes.list })
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings.get })
export const useNotifications = () => useQuery({ queryKey: keys.notifications, queryFn: api.notifications.list })

/**
 * One subscription to the engine's event stream for the whole app. Events are
 * batched for 250 ms, then the lists they touch are invalidated once.
 */
export function useEngineEvents() {
  const qc = useQueryClient()
  useEffect(() => {
    let pending: EngineEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      const types = new Set(pending.map((e) => e.type))
      const ids = new Set(pending.map((e) => e.id))
      pending = []
      if (types.has('container')) {
        qc.invalidateQueries({ queryKey: keys.containers })
        ids.forEach((id) => qc.invalidateQueries({ queryKey: keys.container(id) }))
        // A container change can flip an image or volume between in use / unused.
        qc.invalidateQueries({ queryKey: keys.images })
        qc.invalidateQueries({ queryKey: keys.volumes })
        qc.invalidateQueries({ queryKey: ['volumeUsage'] })
      }
      if (types.has('image')) {
        qc.invalidateQueries({ queryKey: keys.images })
        qc.invalidateQueries({ queryKey: keys.diskUsage })
      }
      if (types.has('volume')) qc.invalidateQueries({ queryKey: keys.volumes })
    }
    const offEvents = api.engine.onEvents((events) => {
      pending.push(...events)
      clearTimeout(timer)
      timer = setTimeout(flush, 250)
    })
    const offStatus = api.engine.onStatus((s: EngineStatus) => {
      qc.setQueryData(keys.engine, s)
      // Coming back from an outage: everything may have changed.
      if (s.state === 'running') qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'engine' })
    })
    const offNotif = api.notifications.onNew(() => qc.invalidateQueries({ queryKey: keys.notifications }))
    return () => {
      offEvents()
      offStatus()
      offNotif()
      clearTimeout(timer)
    }
  }, [qc])
}

/** Live stats for a set of containers, keeping the last `keep` samples each. */
export function useStats(ids: string[], keep = 60) {
  const [series, setSeries] = useState<Record<string, StatsSample[]>>({})
  const key = ids.slice().sort().join(',')
  useEffect(() => {
    if (!key) return
    const off = api.stats.subscribe(key.split(','), (samples) =>
      setSeries((prev) => {
        const next = { ...prev }
        for (const s of samples) next[s.id] = [...(next[s.id] ?? []), s].slice(-keep)
        return next
      }),
    )
    return off
  }, [key, keep])
  return series
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  await api.settings.set(key, value)
  queryClient.setQueryData<Settings>(keys.settings, (s) => (s ? { ...s, [key]: value } : s))
}
