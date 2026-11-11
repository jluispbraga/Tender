import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { GridPrefs, GridView, Notification, RecentItem, Settings } from '../renderer/src/api/types'
import m0001 from './migrations/0001_init.sql?raw'

// Local app state (architecture.md, "Schema"). node:sqlite ships with
// Electron's Node 24, so there is no native module to rebuild. Docker objects
// are never stored here: the engine owns them.

const migrations: [number, string][] = [[1, m0001]]

export const defaultSettings: Settings = {
  theme: 'system',
  start_on_login: false,
  open_on_start: true,
  only_running: false,
  exec_default_shell: '/bin/sh',
  log_tail_lines: 1000,
  tray_enabled: true,
  share_docker_pipe: true,
  check_updates: true,
}

const now = () => new Date().toISOString()

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    // Foreign keys are off per connection unless asked for.
    this.db.exec('pragma foreign_keys = on; pragma journal_mode = wal; pragma busy_timeout = 2000;')
    this.migrate()
  }

  private migrate() {
    this.db.exec('create table if not exists schema_migrations (version integer primary key, applied_at text not null)')
    const done = new Set((this.db.prepare('select version from schema_migrations').all() as { version: number }[]).map((r) => r.version))
    for (const [version, sql] of migrations) {
      if (done.has(version)) continue
      this.db.exec('begin')
      try {
        // The schema file sets pragma foreign_keys itself; harmless inside the transaction.
        this.db.exec(sql)
        this.db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now())
        this.db.exec('commit')
      } catch (e) {
        this.db.exec('rollback')
        throw e
      }
    }
  }

  /** First run: one default endpoint, default grid columns. Settings fall back to defaults in code. */
  seed(endpoint: { name: string; kind: 'npipe' | 'unix' | 'tcp' | 'ssh'; address: string }) {
    // The kind column predates Unix sockets; a socket and a named pipe are both local endpoints.
    endpoint = { ...endpoint, kind: endpoint.kind === 'unix' ? 'npipe' : endpoint.kind }
    const existing = this.db.prepare('select id, address from engine_endpoints where is_default = 1').get() as { id: string; address: string } | undefined
    if (!existing) {
      this.db.prepare('insert into engine_endpoints (id, name, kind, address, is_default) values (?, ?, ?, ?, 1)').run(randomUUID(), endpoint.name, endpoint.kind, endpoint.address)
    } else if (existing.address !== endpoint.address) {
      // The endpoint is re-resolved on every start (DOCKER_HOST, current context); keep the row current.
      this.db.prepare('update engine_endpoints set name = ?, kind = ?, address = ? where id = ?').run(endpoint.name, endpoint.kind, endpoint.address, existing.id)
    }
    this.db.prepare("insert or ignore into grid_preferences (id, view, columns) values (?, 'containers', ?)").run(randomUUID(), JSON.stringify(['created']))
  }

  get endpointId(): string {
    return (this.db.prepare('select id from engine_endpoints where is_default = 1').get() as { id: string }).id
  }

  // ---- settings -------------------------------------------------------------
  settings(): Settings {
    const rows = this.db.prepare('select key, value from settings').all() as { key: keyof Settings; value: string }[]
    const out = { ...defaultSettings } as Record<string, unknown>
    for (const r of rows) out[r.key] = JSON.parse(r.value)
    return out as unknown as Settings
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, JSON.stringify(value))
  }

  // ---- grid preferences -----------------------------------------------------
  // The table stores hidden column ids in `columns` (the picker only toggles visibility).
  grid(view: GridView): GridPrefs {
    const row = this.db.prepare('select columns from grid_preferences where view = ?').get(view) as { columns: string } | undefined
    return { hidden: row ? JSON.parse(row.columns) : [] }
  }

  setGrid(view: GridView, prefs: GridPrefs) {
    this.db
      .prepare('insert into grid_preferences (id, view, columns) values (?, ?, ?) on conflict(view) do update set columns = excluded.columns')
      .run(randomUUID(), view, JSON.stringify(prefs.hidden))
  }

  // ---- notifications ------------------------------------------------------------
  addNotification(n: Pick<Notification, 'kind' | 'title' | 'body'> & { objectType?: string; objectId?: string }): Notification {
    const row: Notification = { id: randomUUID(), kind: n.kind, title: n.title, body: n.body, createdAt: now() }
    this.db
      .prepare('insert into notifications (id, endpoint_id, kind, title, body, object_type, object_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, this.endpointId, row.kind, row.title, row.body ?? null, n.objectType ?? null, n.objectId ?? null, row.createdAt)
    return row
  }

  notifications(): Notification[] {
    const rows = this.db.prepare('select id, kind, title, body, created_at, read_at from notifications order by created_at desc limit 200').all() as {
      id: string
      kind: Notification['kind']
      title: string
      body: string | null
      created_at: string
      read_at: string | null
    }[]
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body ?? undefined, createdAt: r.created_at, readAt: r.read_at ?? undefined }))
  }

  markRead(ids: string[]) {
    const stmt = this.db.prepare('update notifications set read_at = ? where id = ? and read_at is null')
    const at = now()
    for (const id of ids) stmt.run(at, id)
  }

  // ---- pull history -----------------------------------------------------------
  /** Returns null when the same reference is already being pulled (partial unique index). */
  startPull(reference: string): string | null {
    const id = randomUUID()
    try {
      this.db.prepare('insert into pull_history (id, endpoint_id, reference) values (?, ?, ?)').run(id, this.endpointId, reference)
      return id
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) return null
      throw e
    }
  }

  finishPull(id: string, status: 'done' | 'failed' | 'cancelled', error?: string) {
    this.db.prepare('update pull_history set status = ?, error = ?, finished_at = ? where id = ?').run(status, error ?? null, now(), id)
  }

  /** Pulls left "pulling" by a crash or quit can't be running any more. */
  abandonPulls() {
    this.db.prepare("update pull_history set status = 'cancelled', finished_at = ? where status = 'pulling'").run(now())
  }

  // ---- recent searches ----------------------------------------------------------
  recent(): RecentItem[] {
    const rows = this.db.prepare('select object_type, object_id, label from recent_searches where endpoint_id = ? order by used_at desc limit 6').all(this.endpointId) as {
      object_type: RecentItem['type']
      object_id: string
      label: string
    }[]
    return rows.map((r) => ({ type: r.object_type, id: r.object_id, label: r.label }))
  }

  recordUse(item: RecentItem) {
    this.db
      .prepare(
        'insert into recent_searches (id, endpoint_id, object_type, object_id, label, used_at) values (?, ?, ?, ?, ?, ?) on conflict(endpoint_id, object_type, object_id) do update set label = excluded.label, used_at = excluded.used_at',
      )
      .run(randomUUID(), this.endpointId, item.type, item.id, item.label, now())
  }

  // ---- housekeeping (architecture.md, Jobs) ---------------------------------------------
  housekeep() {
    this.db.prepare("delete from notifications where created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')").run()
    this.db.prepare('delete from pull_history where id not in (select id from pull_history order by started_at desc limit 200)').run()
    this.abandonPulls()
  }
}
