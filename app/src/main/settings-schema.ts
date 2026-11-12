import { z } from 'zod'
import type { Settings } from '../renderer/src/api/types'

// What settings.set accepts, key by key. Kept apart from ipc.ts (which needs
// Electron) so the unit tests can check it against the defaults and the database.
export const settingValue = {
  theme: z.enum(['system', 'light', 'dark']),
  start_on_login: z.boolean(),
  open_on_start: z.boolean(),
  only_running: z.boolean(),
  exec_default_shell: z.enum(['/bin/sh', '/bin/bash', 'cmd.exe']),
  log_tail_lines: z.number().int().min(50).max(5000),
  tray_enabled: z.boolean(),
  share_docker_pipe: z.boolean(),
  check_updates: z.boolean(),
  kube_sources: z.array(z.string().min(1).max(1000)).max(50),
  kube_labels: z
    .record(z.string().min(1).max(1300), z.object({ name: z.string().trim().max(60).optional(), env: z.enum(['local', 'dev', 'qa', 'prod']).optional() }))
    .refine((r) => Object.keys(r).length <= 300, 'Too many cluster names.'),
} as const

// Compile-time check: every setting has a validator, and every validator a setting.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const settingsCovered: Same<keyof typeof settingValue, keyof Settings> = true
