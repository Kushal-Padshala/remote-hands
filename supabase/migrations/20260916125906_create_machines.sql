create table public.machines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  hostname text not null,
  agy_version text,
  daemon_version text,
  status text not null default 'offline' check (status in ('online', 'offline')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create index machines_user_id_idx on public.machines (user_id);

alter table public.machines enable row level security;

create policy "machines are visible to their owner"
  on public.machines for select using (auth.uid() = user_id);

create policy "machines are created by their owner"
  on public.machines for insert with check (auth.uid() = user_id);

create policy "machines are updated by their owner"
  on public.machines for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "machines are deleted by their owner"
  on public.machines for delete using (auth.uid() = user_id);
