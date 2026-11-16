import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bell, Box, Download, Database, ExternalLink, FileStack, Gauge, Globe, Hammer, Layers, LifeBuoy, Network, Play, RotateCw, ScrollText, Search, Settings as SettingsIcon, Ship, Square, SquareTerminal } from 'lucide-react'
import { CommandPalette } from '@/components/ui/command-palette'
import { EnginePill, ResourceMeter, SidebarNav } from '@/components/ui/shell'
import { Tooltip } from '@/components/ui/tooltip'
import { useToast } from '@/components/ui/toast'
import { api } from '@/api'
import { bytes, imageName } from '@/lib/format'
import { keys, useContainers, useEngine, useImages, useNetworks, useNotifications, useStats, useVolumes } from '@/lib/queries'
import { href, navigate } from '@/lib/router'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/cn'
import { useBuilds } from '@/lib/builds'
import { TunnelRow, useTunnels } from '@/pages/containers/ShareDialog'
import * as Popover from '@radix-ui/react-popover'

/** S02: sidebar, header, footer, quick search (S19). */
export function AppShell({ section, children }: { section: string; children: ReactNode }) {
  const engine = useEngine()
  const containers = useContainers()
  const images = useImages()
  const volumes = useVolumes()
  const networks = useNetworks()
  const tunnels = useTunnels()
  const openLinks = (tunnels.data ?? []).filter((t) => t.state !== 'stopped')
  const building = useBuilds().filter((b) => b.state === 'running').length
  const notifications = useNotifications()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const toast = useToast()
  const update = useQuery({ queryKey: ['updates'], queryFn: () => api.updates.status(), refetchInterval: 5 * 60_000 })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const running = useMemo(() => (containers.data ?? []).filter((c) => c.state === 'running').map((c) => c.id), [containers.data])
  const stats = useStats(running, 1)
  const cpu = Object.values(stats).reduce((s, v) => s + (v.at(-1)?.cpuPercent ?? 0), 0) / (engine.data?.ncpu ?? 1)
  const mem = Object.values(stats).reduce((s, v) => s + (v.at(-1)?.memUsage ?? 0), 0)
  const unread = (notifications.data ?? []).filter((n) => !n.readAt).length

  const recent = useQuery({ queryKey: keys.recent, queryFn: api.search.recent, enabled: paletteOpen, staleTime: 0 })
  const go = (type: 'container' | 'image' | 'volume', id: string, label: string) => {
    void api.search.recordUse({ type, id, label })
    if (type === 'container') navigate('containers', id, 'logs')
    if (type === 'image') navigate('images', id)
    if (type === 'volume') navigate('volumes', id, 'containers')
  }
  const icon = { container: <Box />, image: <Layers />, volume: <Database /> }

  return (
    <div className="flex h-full min-w-[960px] flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <a href={href('containers')} className="flex w-[196px] items-center gap-2 rounded-sm font-semibold text-fg">
          <span aria-hidden className="grid size-6 place-items-center rounded-md bg-accent text-xs text-on-accent">
            T
          </span>
          Tender
        </a>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-8 w-80 items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-base text-muted hover:border-line-strong"
        >
          <Search aria-hidden className="size-4" />
          <span className="min-w-0 flex-1 truncate text-left">Find a container, image, volume or action</span>
          <kbd className="rounded-sm border border-line px-1.5 font-sans text-xs">Ctrl K</kbd>
        </button>
        <div className="flex-1" />
        {update.data?.state === 'ready' && (
          <button type="button" onClick={() => void api.updates.install()} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-base font-medium text-on-accent hover:opacity-90">
            <Download aria-hidden className="size-4" />
            Restart to update to {update.data.version}
          </button>
        )}
        <Tooltip content="Notifications">
          <a href={href('notifications')} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} className={headerIcon(section === 'notifications')}>
            <Bell aria-hidden className="size-4" />
            {unread > 0 && <span aria-hidden className="absolute top-1 right-1 size-2 rounded-pill bg-danger" />}
          </a>
        </Tooltip>
        <Tooltip content="Troubleshoot">
          <a href={href('troubleshoot')} aria-label="Troubleshoot" className={headerIcon(section === 'troubleshoot')}>
            <LifeBuoy aria-hidden className="size-4" />
          </a>
        </Tooltip>
        <Tooltip content="Settings">
          <a href={href('settings', 'general')} aria-label="Settings" className={headerIcon(section === 'settings')}>
            <SettingsIcon aria-hidden className="size-4" />
          </a>
        </Tooltip>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="shrink-0 border-r border-line bg-surface">
          <SidebarNav
            current={section === 'projects' ? 'containers' : section}
            onSelect={(k) => navigate(k)}
            items={[
              { key: 'containers', label: 'Containers', icon: <Box />, count: containers.data?.length },
              { key: 'compose', label: 'Compose', icon: <FileStack /> },
              { key: 'images', label: 'Images', icon: <Layers />, count: images.data?.length },
              { key: 'builds', label: 'Builds', icon: <Hammer />, count: building || undefined },
              { key: 'volumes', label: 'Volumes', icon: <Database />, count: volumes.data?.length },
              { key: 'networks', label: 'Networks', icon: <Network />, count: networks.data?.length },
              { key: 'kubernetes', label: 'Kubernetes', icon: <Ship /> },
              ...(api.platform === 'win32' ? [{ key: 'resources', label: 'Memory and disk', icon: <Gauge /> }] : []),
            ]}
          />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-4">
        <EnginePill state={engine.data?.state ?? 'starting'} detail={engine.data?.state === 'running' ? `v${engine.data.version}` : undefined} />
        <div className="flex-1" />
        {openLinks.length > 0 && (
          <Popover.Root>
            <Popover.Trigger className="inline-flex h-5 items-center gap-1 rounded-pill bg-warning-bg px-2 text-xs font-medium text-warning">
              <Globe aria-hidden className="size-3" />
              {openLinks.length} public link{openLinks.length === 1 ? '' : 's'} open
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content side="top" align="end" sideOffset={6} aria-label="Public links" className="z-50 w-[420px] rounded-lg border border-line bg-raised p-3 shadow-modal">
                <ul className="flex flex-col gap-2">
                  {openLinks.map((t) => (
                    <TunnelRow key={t.id} t={t} />
                  ))}
                </ul>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
        {engine.data?.state === 'running' && (
          <>
            <ResourceMeter label="CPU" value={Math.round(cpu * 10) / 10} max={100} format={(v) => `${v.toFixed(1)}%`} />
            <ResourceMeter label="RAM" value={mem} max={engine.data.memTotal ?? 1} format={bytes} />
          </>
        )}
      </footer>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        groups={[
          ...(recent.data?.length
            ? [{ heading: 'Recent', items: recent.data.map((r) => ({ id: `r-${r.type}-${r.id}`, label: r.label, hint: r.type, icon: icon[r.type], onSelect: () => go(r.type, r.id, r.label) })) }]
            : []),
          { heading: 'Containers', items: (containers.data ?? []).map((c) => ({ id: c.id, label: c.name, hint: c.image, icon: <Box />, onSelect: () => go('container', c.id, c.name) })) },
          { heading: 'Images', items: (images.data ?? []).map((i) => ({ id: i.id, label: imageName(i.tags, i.id), hint: bytes(i.size), icon: <Layers />, onSelect: () => go('image', i.id, imageName(i.tags, i.id)) })) },
          { heading: 'Volumes', items: (volumes.data ?? []).map((v) => ({ id: v.name, label: v.name, hint: v.usedBy.length ? 'in use' : 'unused', icon: <Database />, onSelect: () => go('volume', v.name, v.name) })) },
          {
            heading: 'Actions',
            searchOnly: true,
            items: [
              { id: 'a-build', label: 'Build an image', icon: <Hammer />, onSelect: () => navigate('builds') },
              { id: 'a-compose', label: 'Open a Compose file', icon: <FileStack />, onSelect: () => navigate('compose') },
              ...(containers.data ?? []).flatMap((c) => {
                const live = c.state === 'running'
                const run = (a: 'start' | 'stop' | 'restart', done: string) => () =>
                  void api.containers.action([c.id], a).then((r) => (r[0]?.ok ? toast({ kind: 'success', title: `${done} ${c.name}` }) : toast({ kind: 'error', title: `Couldn’t ${a} ${c.name}`, body: r[0]?.error })))
                return [
                  live
                    ? { id: `a-stop-${c.id}`, label: `Stop ${c.name}`, icon: <Square />, onSelect: run('stop', 'Stopped') }
                    : { id: `a-start-${c.id}`, label: `Start ${c.name}`, icon: <Play />, onSelect: run('start', 'Started') },
                  ...(live ? [{ id: `a-restart-${c.id}`, label: `Restart ${c.name}`, icon: <RotateCw />, onSelect: run('restart', 'Restarted') }] : []),
                  { id: `a-logs-${c.id}`, label: `Logs of ${c.name}`, icon: <ScrollText />, onSelect: () => navigate('containers', c.id, 'logs') },
                  ...(live ? [{ id: `a-term-${c.id}`, label: `Terminal in ${c.name}`, icon: <SquareTerminal />, onSelect: () => navigate('containers', c.id, 'exec') }] : []),
                  ...(live
                    ? c.ports
                        .filter((p) => p.publicPort && p.protocol === 'tcp')
                        .map((p) => ({ id: `a-open-${c.id}-${p.publicPort}`, label: `Open localhost:${p.publicPort}`, hint: c.name, icon: <ExternalLink />, onSelect: () => void api.containers.openPort(p) }))
                    : []),
                ]
              }),
            ],
          },
          {
            heading: 'Go to',
            searchOnly: true,
            items: (
              [
                ['containers', 'Containers', <Box key="i" />],
                ['compose', 'Compose', <FileStack key="i" />],
                ['images', 'Images', <Layers key="i" />],
                ['builds', 'Builds', <Hammer key="i" />],
                ['volumes', 'Volumes', <Database key="i" />],
                ['networks', 'Networks', <Network key="i" />],
                ['kubernetes', 'Kubernetes', <Ship key="i" />],
                ['notifications', 'Notifications', <Bell key="i" />],
                ['troubleshoot', 'Troubleshoot', <LifeBuoy key="i" />],
                ['settings', 'Settings', <SettingsIcon key="i" />],
              ] as const
            ).map(([k, label, icon]) => ({ id: `go-${k}`, label, icon, onSelect: () => (k === 'settings' ? navigate('settings', 'general') : navigate(k)) })),
          },
          { heading: 'Networks', items: (networks.data ?? []).map((n) => ({ id: `net-${n.id}`, label: n.name, hint: n.subnet ?? n.driver, icon: <Network />, onSelect: () => navigate('networks', n.id) })) },
        ]}
      />
    </div>
  )
}

const headerIcon = (active: boolean) =>
  cn('relative grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg', active && 'bg-selected text-fg')

/** Title row shared by every page. */
export function PageHeader({ title, children, back }: { title: ReactNode; children?: ReactNode; back?: ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
      {back}
      <h1 className="min-w-0 truncate text-lg text-fg">{title}</h1>
      <div className="flex-1" />
      {children}
    </div>
  )
}
