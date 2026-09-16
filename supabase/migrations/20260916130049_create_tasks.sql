create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  machine_id uuid not null references public.machines (id) on delete cascade,
  prompt text not null check (length(prompt) between 1 and 20000),
  kind text not null default 'auto'
    check (kind in ('browser', 'coding', 'mixed', 'auto')),
  workspace_path text,
  model text,
  effort text check (effort is null or effort in ('low', 'medium', 'high')),
  mode text not null default 'default'
    check (mode in ('default', 'accept-edits', 'plan')),
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'running', 'awaiting_approval',
                      'done', 'failed', 'cancelled')),
  conversation_id text,
  parent_task_id uuid references public.tasks (id) on delete set null,
  result_summary text,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index tasks_machine_queued_idx
  on public.tasks (machine_id, created_at)
  where status = 'queued';

create index tasks_user_created_idx on public.tasks (user_id, created_at desc);

alter table public.tasks enable row level security;

create policy "tasks are visible to their owner"
  on public.tasks for select using (auth.uid() = user_id);

create policy "tasks are created by their owner"
  on public.tasks for insert with check (auth.uid() = user_id);

create policy "tasks are updated by their owner"
  on public.tasks for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "tasks are deleted by their owner"
  on public.tasks for delete using (auth.uid() = user_id);
