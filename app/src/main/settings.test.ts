import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../renderer/src/api/types'
import { defaultSettings, Store } from './db'
import { settingValue } from './settings-schema'
import m0001 from './migrations/0001_init.sql?raw'

// A value for each setting that differs from its default, so a save that is
// silently dropped shows up as the default coming back.
const changed: Settings = {
  theme: 'dark',
  start_on_login: true,
  open_on_start: false,
  only_running: true,
  exec_default_shell: '/bin/bash',
  log_tail_lines: 250,
  tray_enabled: false,
  share_docker_pipe: false,
  check_updates: false,
  kube_sources: ['C:\\Users\\you\\.kube\\prod'],
  kube_labels: { 'c:\\users\\you\\.kube\\prod\\flake-prod-kubeconfig#microk8s': { name: 'Flake prod', env: 'prod' } },
}

const keys = Object.keys(settingValue) as (keyof Settings)[]

describe('settings', () => {
  it('every default passes its own validator', () => {
    for (const k of keys) expect(() => settingValue[k].parse(defaultSettings[k]), k).not.toThrow()
  })

  it('every test value passes the validator (so the save test is meaningful)', () => {
    for (const k of keys) {
      expect(() => settingValue[k].parse(changed[k]), k).not.toThrow()
      expect(changed[k], k).not.toEqual(defaultSettings[k])
    }
  })

  it.each(keys)('%s saves and reads back', (k) => {
    const store = new Store(':memory:')
    store.setSetting(k, changed[k] as never)
    expect(store.settings()[k]).toEqual(changed[k])
  })

  describe('a database created by the first release', () => {
    let dir: string | null = null
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
      dir = null
    })

    it('keeps its values and accepts settings added since', () => {
      dir = mkdtempSync(join(tmpdir(), 'tender-db-'))
      const path = join(dir, 'tender.db')
      // Exactly what v0.1 left on disk: schema 0001 and one saved setting.
      const old = new DatabaseSync(path)
      old.exec(m0001)
      old.exec("create table if not exists schema_migrations (version integer primary key, applied_at text not null); insert into schema_migrations values (1, '2026-01-01T00:00:00Z')")
      old.prepare('insert into settings (key, value) values (?, ?)').run('theme', JSON.stringify('light'))
      expect(() => old.prepare('insert into settings (key, value) values (?, ?)').run('check_updates', 'false')).toThrow(/CHECK constraint/)
      old.close()

      const store = new Store(path)
      expect(store.settings().theme).toBe('light')
      for (const k of keys) {
        store.setSetting(k, changed[k] as never)
        expect(store.settings()[k], k).toEqual(changed[k])
      }
      store.close()
    })
  })
})
