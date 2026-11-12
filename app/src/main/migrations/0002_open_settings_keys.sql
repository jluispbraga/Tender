-- 0001 limited settings.key to the first seven settings, so every setting added
-- since (share_docker_pipe, check_updates, kube_sources) failed to save with a
-- CHECK constraint error. The main process validates keys and values with zod
-- before writing (ipc.ts, settingValue), so the table keeps only the JSON check.
create table settings_new (
  key        text primary key,
  value      text not null check (json_valid(value)),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
insert into settings_new (key, value, updated_at) select key, value, updated_at from settings;
drop table settings;
alter table settings_new rename to settings;
