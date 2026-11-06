import { useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { queryClient, useEngineEvents, useSettings } from '@/lib/queries'
import { useRoute } from '@/lib/router'
import { AppShell } from './AppShell'
import { EngineGate } from './EngineGate'
import { ContainersPage } from '@/pages/containers/ContainersPage'
import { ContainerDetail } from '@/pages/containers/ContainerDetail'
import { ProjectDetail } from '@/pages/containers/ProjectDetail'
import { ImagesPage } from '@/pages/images/ImagesPage'
import { ImageDetail } from '@/pages/images/ImageDetail'
import { VolumesPage } from '@/pages/volumes/VolumesPage'
import { VolumeDetail } from '@/pages/volumes/VolumeDetail'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { TroubleshootPage } from '@/pages/troubleshoot/TroubleshootPage'
import { NotificationsPage } from '@/pages/notifications/NotificationsPage'
import { NotFound } from '@/pages/NotFound'

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
    default:
      page = <NotFound />
  }

  // Settings, troubleshoot and notifications stay reachable with the engine down.
  const needsEngine = !['settings', 'troubleshoot', 'notifications'].includes(section)
  return (
    <AppShell section={section}>
      {needsEngine ? <EngineGate>{page}</EngineGate> : page}
    </AppShell>
  )
}
