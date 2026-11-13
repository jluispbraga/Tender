import { Suspense, lazy, useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { queryClient, useEngineEvents, useSettings } from '@/lib/queries'
import { useRoute } from '@/lib/router'
import { AppShell } from './AppShell'
import { EngineGate } from './EngineGate'
import { ContainersPage } from '@/pages/containers/ContainersPage'
import { NotFound } from '@/pages/NotFound'

// The containers list is the first screen and loads with the app. Every other page
// (and the terminal, xterm, inside the detail pages) loads the first time it is opened.
const loaders: (() => Promise<unknown>)[] = []
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType<any>>>, name: K) => {
  loaders.push(load)
  return lazy(() => load().then((m) => ({ default: m[name] })))
}
// Once the first screen is up, fetch the rest in the background: the start stays light
// and moving between pages never shows a blank frame.
const preload = () => setTimeout(() => loaders.forEach((l) => void l().catch(() => {})), 800)
const ContainerDetail = named(() => import('@/pages/containers/ContainerDetail'), 'ContainerDetail')
const ProjectDetail = named(() => import('@/pages/containers/ProjectDetail'), 'ProjectDetail')
const ImagesPage = named(() => import('@/pages/images/ImagesPage'), 'ImagesPage')
const ImageDetail = named(() => import('@/pages/images/ImageDetail'), 'ImageDetail')
const VolumesPage = named(() => import('@/pages/volumes/VolumesPage'), 'VolumesPage')
const VolumeDetail = named(() => import('@/pages/volumes/VolumeDetail'), 'VolumeDetail')
const SettingsPage = named(() => import('@/pages/settings/SettingsPage'), 'SettingsPage')
const TroubleshootPage = named(() => import('@/pages/troubleshoot/TroubleshootPage'), 'TroubleshootPage')
const NotificationsPage = named(() => import('@/pages/notifications/NotificationsPage'), 'NotificationsPage')
const MigratePage = named(() => import('@/pages/migrate/MigratePage'), 'MigratePage')
const SetupPage = named(() => import('@/pages/setup/SetupPage'), 'SetupPage')
const ResourcesPage = named(() => import('@/pages/resources/ResourcesPage'), 'ResourcesPage')
const KubernetesPage = named(() => import('@/pages/kubernetes/KubernetesPage'), 'KubernetesPage')

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <Root />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function Root() {
  useEngineEvents()
  const settings = useSettings()
  const [section, a, b] = useRoute()

  useEffect(() => {
    const t = preload()
    return () => clearTimeout(t)
  }, [])

  // S21 theme: "system" removes the attribute so prefers-color-scheme decides.
  useEffect(() => {
    const t = settings.data?.theme
    if (!t || t === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
  }, [settings.data?.theme])

  let page
  switch (section) {
    case 'containers':
      page = a ? <ContainerDetail id={a} tab={b ?? 'logs'} /> : <ContainersPage />
      break
    case 'projects':
      page = <ProjectDetail name={a ?? ''} />
      break
    case 'images':
      page = a ? <ImageDetail id={a} /> : <ImagesPage />
      break
    case 'volumes':
      page = a ? <VolumeDetail name={a} tab={b ?? 'containers'} /> : <VolumesPage />
      break
    case 'settings':
      page = <SettingsPage section={a ?? 'general'} />
      break
    case 'troubleshoot':
      page = <TroubleshootPage />
      break
    case 'notifications':
      page = <NotificationsPage />
      break
    case 'migrate':
      page = <MigratePage />
      break
    case 'setup':
      page = <SetupPage />
      break
    case 'resources':
      page = <ResourcesPage />
      break
    case 'kubernetes':
      page = <KubernetesPage />
      break
    default:
      page = <NotFound />
  }

  // Settings, troubleshoot and notifications stay reachable with the engine down.
  const needsEngine = !['settings', 'troubleshoot', 'notifications', 'migrate', 'setup', 'resources', 'kubernetes'].includes(section)
  return (
    <AppShell section={section}>
      <Suspense fallback={<PageLoading />}>{needsEngine ? <EngineGate>{page}</EngineGate> : page}</Suspense>
    </AppShell>
  )
}

/** While a page's code loads, the first time it is opened (a few milliseconds from disk). */
function PageLoading() {
  return <div aria-busy data-page-loading className="flex-1" />
}
