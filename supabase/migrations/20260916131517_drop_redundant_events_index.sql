-- The `unique (task_id, seq)` constraint on public.events already creates
-- its own unique index (events_task_id_seq_key). The redundant
-- events_task_seq_idx duplicates it on the same columns, adding write cost
-- with no benefit.
drop index if exists public.events_task_seq_idx;

-- approvals deliberately has no delete policy: approval decisions are an
-- immutable audit trail, the same spirit as the no-update rule on events.
-- Decisions are never deleted, so the record of what was authorised can
-- never be erased.
comment on table public.approvals is
  'Approval decisions are an immutable audit trail: rows are never deleted, so the record of what was authorised cannot be erased.';
