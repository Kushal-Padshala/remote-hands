create table public.events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seq integer not null check (seq >= 0),
  kind text not null check (kind in (
    'agent_text', 'thinking', 'tool_call', 'tool_result', 'file_diff',
    'command_output', 'browser_action', 'status', 'approval_requested',
    'error', 'result')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (task_id, seq)
);

create index events_task_seq_idx on public.events (task_id, seq);

alter table public.events enable row level security;

create policy "events are visible to their owner"
  on public.events for select using (auth.uid() = user_id);

create policy "events are created by their owner"
  on public.events for insert with check (auth.uid() = user_id);

create policy "events are deleted by their owner"
  on public.events for delete using (auth.uid() = user_id);
