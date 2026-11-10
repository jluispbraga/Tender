import { useSyncExternalStore } from 'react'

// Hash routing: the renderer is loaded from a file:// URL in Electron, where
// history routing has nothing to fall back on. Routes:
//
//   #/containers                       S03
//   #/containers/:id/:tab              S04-S09 (logs | inspect | mounts | exec | files | stats)
//   #/projects/:name                   S10
//   #/images                           S11
//   #/images/:id                       S12
//   #/volumes                          S15
//   #/volumes/:name/:tab               S16 (containers | data)
//   #/settings/:section                S21, S22 (general | engine)
//   #/troubleshoot                     S23
//   #/notifications                    S24
//   #/migrate                          move from Docker Desktop (Windows)
//   #/setup                            install Docker Engine in WSL (Windows)
//   #/design                           design-system gallery

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
  return parts.length ? parts : ['containers']
}

/** Query string after the route, e.g. #/containers?q=nginx (used to pre-filter a list). */
export const routeQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '')

export function navigate(...parts: string[]) {
  window.location.hash = '/' + parts.map(encodeURIComponent).join('/')
}

export function navigateWithQuery(query: Record<string, string>, ...parts: string[]) {
  window.location.hash = '/' + parts.map(encodeURIComponent).join('/') + '?' + new URLSearchParams(query)
}

export const href = (...parts: string[]) => '#/' + parts.map(encodeURIComponent).join('/')
