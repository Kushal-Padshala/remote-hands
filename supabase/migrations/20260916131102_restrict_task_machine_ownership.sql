create or replace function public.machine_belongs_to_current_user(machine uuid)
returns boolean
language sql
security invoker
stable
as $$
  select exists (
    select 1 from public.machines m
    where m.id = machine and m.user_id = auth.uid()
  );
$$;

drop policy "tasks are created by their owner" on public.tasks;

create policy "tasks are created by their owner"
  on public.tasks for insert
  with check (
    auth.uid() = user_id
    and public.machine_belongs_to_current_user(machine_id)
  );
