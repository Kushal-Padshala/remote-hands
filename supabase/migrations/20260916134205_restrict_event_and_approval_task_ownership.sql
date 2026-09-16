create or replace function public.task_belongs_to_current_user(task uuid)
returns boolean
language sql
security invoker
stable
as $$
  select exists (
    select 1 from public.tasks t
    where t.id = task and t.user_id = auth.uid()
  );
$$;

drop policy "events are created by their owner" on public.events;

create policy "events are created by their owner"
  on public.events for insert
  with check (
    auth.uid() = user_id
    and public.task_belongs_to_current_user(task_id)
  );

drop policy "approvals are created by their owner" on public.approvals;

create policy "approvals are created by their owner"
  on public.approvals for insert
  with check (
    auth.uid() = user_id
    and public.task_belongs_to_current_user(task_id)
  );
