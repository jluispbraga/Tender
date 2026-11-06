-- Local app state for Tender. Migration 0001.
--
-- The Docker Engine is the source of truth for containers, images and
-- volumes; none of them are stored here. This SQLite file only holds what the
-- engine does not: preferences, endpoints, notifications, history.
--
-- SQLite adaptations of the usual rules:
--   ids        TEXT uuid, generated in the app with crypto.randomUUID()
--   times      TEXT ISO-8601 in UTC ('2026-11-03T14:05:09.123Z')
--   no owner   single-user app; the file lives in the Windows user's
--              %APPDATA%, so the OS account is the owner
--   FKs        enforced only with PRAGMA foreign_keys = ON, set on every
--              connection in the data layer

pragma foreign_keys = on;

-- Engines the app can talk to. Exactly one default. The named pipe row is
-- seeded on first run.
create table engine_endpoints (
  id          text primary key,
  name        text not null,
  kind        text not null check (kind in ('npipe', 'tcp', 'ssh')),
  address     text not null,                 -- //./pipe/docker_engine, tcp://host:2376, ssh://user@host
  tls_ca_path   text,
  tls_cert_path text,
  tls_key_path  text,
  is_default  integer not null default 0 check (is_default in (0, 1)),
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  constraint tls_all_or_none check (
    (tls_ca_path is null and tls_cert_path is null and tls_key_path is null)
    or (tls_ca_path is not null and tls_cert_path is not null and tls_key_path is not null)
  )
);
create unique index engine_endpoints_name_uq on engine_endpoints (name);
create unique index engine_endpoints_one_default on engine_endpoints (is_default) where is_default = 1;

-- App preferences as typed key/value. Keys are a closed list so a typo is a
-- constraint error, not a silent new setting.
create table settings (
  key        text primary key check (key in (
               'theme',               -- "system" | "light" | "dark"
               'start_on_login',      -- boolean
               'open_on_start',       -- boolean
               'only_running',        -- boolean, S03 toggle
               'exec_default_shell',  -- "/bin/sh" | "/bin/bash" | "cmd.exe"
               'log_tail_lines',      -- integer, initial log backlog
               'tray_enabled'         -- boolean
             )),
  value      text not null check (json_valid(value)),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Column picker and sort per list view (S03, S11, S15). One row per view.
create table grid_preferences (
  id         text primary key,
  view       text not null check (view in ('containers', 'images', 'volumes')),
  columns    text not null check (json_valid(columns) and json_type(columns) = 'array'),
  sort_by    text,
  sort_dir   text not null default 'asc' check (sort_dir in ('asc', 'desc')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create unique index grid_preferences_view_uq on grid_preferences (view);

-- Sidebar order and visibility (S02, "customise sidebar").
create table sidebar_items (
  key        text primary key check (key in ('containers', 'images', 'volumes', 'networks')),
  position   integer not null check (position >= 0),
  visible    integer not null default 1 check (visible in (0, 1)),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create unique index sidebar_items_position_uq on sidebar_items (position);

-- Notifications center (S24). Object ids are engine ids, not foreign keys:
-- the container may be gone by the time the user reads the notification.
create table notifications (
  id           text primary key,
  endpoint_id  text references engine_endpoints (id) on delete set null,
  kind         text not null check (kind in ('info', 'success', 'error')),
  title        text not null,
  body         text,
  object_type  text check (object_type in ('container', 'image', 'volume', 'engine')),
  object_id    text,
  read_at      text,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index notifications_endpoint_idx on notifications (endpoint_id);
create index notifications_created_idx  on notifications (created_at desc);
create index notifications_unread_idx   on notifications (created_at desc) where read_at is null;

-- Image pulls (S14, F03): recent references for autocomplete and an outcome
-- log. Progress itself is streamed, never stored.
create table pull_history (
  id           text primary key,
  endpoint_id  text not null references engine_endpoints (id) on delete cascade,
  reference    text not null,               -- nginx:1.27, ghcr.io/org/app@sha256:...
  status       text not null default 'pulling'
               check (status in ('pulling', 'done', 'failed', 'cancelled')),
  error        text,
  started_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at  text,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  constraint finished_after_start check (finished_at is null or finished_at >= started_at),
  constraint finished_when_terminal check ((status = 'pulling') = (finished_at is null))
);
create index pull_history_endpoint_idx  on pull_history (endpoint_id, started_at desc);
create index pull_history_reference_idx on pull_history (reference);
-- one pull of a reference at a time per engine: the double-click race lives here
create unique index pull_history_one_active on pull_history (endpoint_id, reference) where status = 'pulling';

-- Quick search recents (S19 with an empty query).
create table recent_searches (
  id           text primary key,
  endpoint_id  text not null references engine_endpoints (id) on delete cascade,
  object_type  text not null check (object_type in ('container', 'image', 'volume')),
  object_id    text not null,
  label        text not null,
  used_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create unique index recent_searches_object_uq on recent_searches (endpoint_id, object_type, object_id);
create index recent_searches_used_idx on recent_searches (endpoint_id, used_at desc);

-- updated_at maintenance
create trigger engine_endpoints_touch after update on engine_endpoints
  when new.updated_at = old.updated_at
  begin update engine_endpoints set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id; end;
create trigger settings_touch after update on settings
  when new.updated_at = old.updated_at
  begin update settings set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where key = new.key; end;
create trigger grid_preferences_touch after update on grid_preferences
  when new.updated_at = old.updated_at
  begin update grid_preferences set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id; end;
create trigger sidebar_items_touch after update on sidebar_items
  when new.updated_at = old.updated_at
  begin update sidebar_items set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where key = new.key; end;
create trigger notifications_touch after update on notifications
  when new.updated_at = old.updated_at
  begin update notifications set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id; end;
create trigger pull_history_touch after update on pull_history
  when new.updated_at = old.updated_at
  begin update pull_history set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id; end;
create trigger recent_searches_touch after update on recent_searches
  when new.updated_at = old.updated_at
  begin update recent_searches set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id; end;
