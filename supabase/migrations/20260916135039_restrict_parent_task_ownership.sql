drop policy "tasks are created by their owner" on public.tasks;

create policy "tasks are created by their owner"
  on public.tasks for insert
  with check (
    auth.uid() = user_id
    and public.machine_belongs_to_current_user(machine_id)
    and (parent_task_id is null or public.task_belongs_to_current_user(parent_task_id))
  );

drop policy "tasks are updated by their owner" on public.tasks;

create policy "tasks are updated by their owner"
  on public.tasks for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (parent_task_id is null or public.task_belongs_to_current_user(parent_task_id))
  );
