create table if not exists machines (
  id text primary key,
  owner_id text not null,
  name text not null,
  hostname text not null,
  daemon_version text,
  agy_version text,
  status text not null check (status in ('online', 'offline')),
  last_seen_at text,
  created_at text not null,
  unique (owner_id, name)
);

create index if not exists idx_machines_owner on machines(owner_id);

create table if not exists tasks (
  id text primary key,
  owner_id text not null,
  machine_id text not null references machines(id),
  prompt text not null,
  kind text not null,
  workspace_path text,
  model text,
  effort text,
  mode text not null,
  status text not null,
  conversation_id text,
  parent_task_id text references tasks(id),
  result_summary text,
  error text,
  created_at text not null,
  started_at text,
  finished_at text
);

create index if not exists idx_tasks_owner on tasks(owner_id);
create index if not exists idx_tasks_machine on tasks(machine_id);
create index if not exists idx_tasks_status on tasks(status);

create table if not exists events (
  id integer primary key autoincrement,
  task_id text not null references tasks(id),
  owner_id text not null,
  seq integer not null,
  kind text not null,
  payload text not null,
  created_at text not null,
  unique (task_id, seq)
);

create index if not exists idx_events_task on events(task_id);

create table if not exists approvals (
  id text primary key,
  task_id text not null references tasks(id),
  owner_id text not null,
  action_kind text not null,
  summary text not null,
  risk text not null,
  tool_payload text not null,
  frame_path text,
  decision text not null,
  decided_at text,
  expires_at text not null,
  created_at text not null
);

create index if not exists idx_approvals_task on approvals(task_id);
create index if not exists idx_approvals_owner on approvals(owner_id);

create table if not exists pairing_tokens (
  id text primary key,
  owner_id text not null,
  machine_name text not null,
  code_hash text not null,
  expires_at text not null,
  claimed_at text,
  created_at text not null
);

create index if not exists idx_pairing_tokens_expires on pairing_tokens(expires_at);

create table if not exists sessions (
  id text primary key,
  owner_id text not null,
  machine_id text,
  kind text not null check (kind in ('phone', 'daemon')),
  token_hash text not null,
  expires_at text not null,
  created_at text not null
);

create index if not exists idx_sessions_token_hash on sessions(token_hash);
create index if not exists idx_sessions_expires on sessions(expires_at);

create table if not exists schema_migrations (
  version text primary key,
  applied_at text not null
);
