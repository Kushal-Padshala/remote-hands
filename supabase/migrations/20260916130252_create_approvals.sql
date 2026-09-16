create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action_kind text not null check (action_kind in (
    'publish', 'send', 'pay', 'delete', 'push', 'shell', 'other')),
  summary text not null,
  risk text not null check (risk in ('low', 'medium', 'high')),
  tool_payload jsonb not null default '{}'::jsonb,
  frame_path text,
  decision text not null default 'pending'
    check (decision in ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint decided_rows_have_a_timestamp
    check ((decision = 'pending') = (decided_at is null))
);

create index approvals_task_idx on public.approvals (task_id, created_at desc);
create index approvals_pending_idx on public.approvals (user_id)
  where decision = 'pending';

alter table public.approvals enable row level security;

create policy "approvals are visible to their owner"
  on public.approvals for select using (auth.uid() = user_id);

create policy "approvals are created by their owner"
  on public.approvals for insert with check (auth.uid() = user_id);

create policy "approvals are decided by their owner"
  on public.approvals for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
