# The control plane schema

This describes the Supabase schema in `supabase/migrations`: four tables,
the row-level security policies that isolate one user's data from another's,
and the four invariants the test suite proves hold.

Nothing in this repository writes to these tables yet. There is no daemon
and no phone app — see the README's Status section. The "writes" and "reads"
columns below describe what the design (`docs/superpowers/specs/2026-09-16-remote-hands-design.md`)
assigns to each future process, so a contributor building that process knows
what it's for. Today the only thing that reads or writes these tables is the
test suite in `supabase/tests`.

## Row-level security, in general

Every table enables RLS in the same migration that creates it. Every policy
is scoped to `auth.uid() = user_id` (or, for `tasks` inserts, that plus one
more check — see the invariant below). There is no table a signed-in user
can read or write rows they don't own, and no service-role access from
outside the test suite.

## `machines`

One row per computer paired to run tasks.

| Column | Why it exists |
|---|---|
| `id` | Primary key, referenced by `tasks.machine_id`. |
| `user_id` | Owner. Every RLS policy on this table checks against it. |
| `name` | Human-readable label, unique per owner (`unique (user_id, name)`). |
| `hostname` | What the daemon reports about the machine it's running on. |
| `agy_version`, `daemon_version` | Recorded so a stale daemon or agent build is visible from the phone. |
| `status` | `online` or `offline`, derived from recent heartbeats. |
| `last_seen_at` | Timestamp of the last heartbeat; `status` is computed from how stale this is. |
| `created_at` | Pairing time. |

- **Writes**: the daemon, on pairing and on every heartbeat (`last_seen_at`, `status`).
- **Reads**: the phone app, to list machines and show which are online; the
  daemon's own task-claim query joins through here indirectly via `tasks`.
- **Policies**: SELECT, INSERT, UPDATE, DELETE, all owner-scoped.

## `tasks`

One row per unit of work queued onto a machine.

| Column | Why it exists |
|---|---|
| `id` | Primary key, referenced by `events.task_id` and `approvals.task_id`. |
| `user_id` | Owner. |
| `machine_id` | Which machine should claim this task. See the second invariant below. |
| `prompt` | What to do, 1-20000 characters. |
| `kind` | `browser` / `coding` / `mixed` / `auto` — routes to the right agent mode. |
| `workspace_path`, `model`, `effort`, `mode` | Per-task agent configuration. |
| `status` | `queued` → `claimed` → `running` → (`awaiting_approval` ⇄ `running`) → `done` / `failed` / `cancelled`. Legal transitions are enforced in application code (`packages/shared/src/task.ts`'s `canTransition`), not by the database. |
| `conversation_id` | Lets a follow-up task resume the same agent conversation. |
| `parent_task_id` | Links a follow-up task to the one it continues. |
| `result_summary`, `error` | Terminal-state output. |
| `created_at`, `started_at`, `finished_at` | Lifecycle timestamps. |

- **Writes**: the phone app inserts (queues a task); the daemon updates
  `status` and the timestamp/result columns as it works the task.
- **Reads**: the daemon polls or subscribes for `queued` tasks on its
  machines; the phone app reads task history and live status.
- **Policies**: SELECT, INSERT, UPDATE, DELETE, all owner-scoped. INSERT
  carries the extra machine-ownership check described below.

## `events`

An append-only log of everything that happens while a task runs — one row
per agent step.

| Column | Why it exists |
|---|---|
| `id` | `bigint identity` primary key; ordering-friendly and cheap to generate at high volume. |
| `task_id` | Which task this event belongs to. |
| `user_id` | Owner, for RLS. Denormalized from the task so the policy doesn't need a join. |
| `seq` | Per-task sequence number; `unique (task_id, seq)` lets a client detect gaps or duplicates. |
| `kind` | One of the eleven event kinds in `packages/shared/src/event.ts` (`agent_text`, `tool_call`, `file_diff`, `browser_action`, `approval_requested`, ...). |
| `payload` | `jsonb`, shaped per `kind` by the Zod schemas in `packages/shared/src/event.ts` at the application layer — the database does not constrain its shape beyond "not null". |
| `created_at` | When the event was recorded. |

- **Writes**: the daemon only, as `agy`'s `stream-json` output is translated
  into rows.
- **Reads**: the phone app, as a live timeline (via `supabase_realtime`) and
  as history.
- **Policies**: SELECT, INSERT, DELETE. **No UPDATE policy exists**, and
  that is deliberate — see the append-only invariant below. INSERT carries
  the extra task-ownership check described below.

## `approvals`

A request to pause an irreversible action until a human decides.

| Column | Why it exists |
|---|---|
| `id` | Primary key. |
| `task_id` | Which task is waiting. |
| `user_id` | Owner, for RLS. |
| `action_kind` | `publish` / `send` / `pay` / `delete` / `push` / `shell` / `other` — what category of action triggered the gate. |
| `summary` | Human-readable description shown on the phone. |
| `risk` | `low` / `medium` / `high`, from the risk classifier. |
| `tool_payload` | The raw tool call being gated, for inspection. |
| `frame_path` | Optional path to a stored screenshot frame, if one was captured for this approval. |
| `decision` | `pending` → `approved` / `rejected` / `expired`. |
| `decided_at` | Set exactly when `decision` leaves `pending`; enforced by the `decided_rows_have_a_timestamp` check constraint. |
| `expires_at` | When an unanswered request is treated as denied. |
| `created_at` | When the gate fired. |

- **Writes**: the daemon inserts a row when the approval hook fires; the
  phone app updates `decision` (and, indirectly through expiry, the daemon
  or a scheduled job would mark `expired` ones — not built yet).
- **Reads**: the phone app, to show pending approvals; the daemon, to learn
  the decision and unblock the task.
- **Policies**: SELECT, INSERT, UPDATE. **No DELETE policy exists**, and
  that is deliberate — see the immutable-audit-trail invariant below. The
  table itself carries a `comment on table` recording this in the schema.
  INSERT carries the extra task-ownership check described below.

## `supabase_realtime`

`tasks`, `events`, and `approvals` are published to `supabase_realtime`
(`20260916130431_enable_realtime.sql`), so the phone app can subscribe to
changes instead of polling. `machines` is not published; heartbeat status is
read on demand.

## The four invariants

These are the properties Plan 1 exists to guarantee. All four are proved by
tests in `supabase/tests/rls.test.ts` and `supabase/tests/schema-invariants.test.ts`,
run against a real local Postgres instance with RLS enabled — not asserted against
application code.

### 1. Events are append-only

Once written, an event row can never be modified, even by its owner. There
is no UPDATE policy on `events` — the table's RLS policy set covers only
SELECT, INSERT, and DELETE, so Postgres rejects any update outright,
regardless of who issues it.

Proved by: **`the append-only event log > refuses an update even from the owner`**
in `supabase/tests/rls.test.ts`. It has the owner (`alice`) attempt to
rewrite her own event's payload and asserts the update affects zero rows.

### 2. A task cannot be queued onto a machine the caller cannot see

`user_id = auth.uid()` alone is not enough to prevent this: a second user
could insert a task with their **own** `user_id` but **someone else's**
`machine_id` as a foreign key reference, and the foreign key constraint
does not consult RLS on the referenced table. The INSERT policy on `tasks`
closes that gap with an extra check, backed by a `security invoker`
function:

```sql
create policy "tasks are created by their owner"
  on public.tasks for insert
  with check (
    auth.uid() = user_id
    and public.machine_belongs_to_current_user(machine_id)
  );
```

`machine_belongs_to_current_user` (added in
`20260916131102_restrict_task_machine_ownership.sql`) runs as the calling
user (`security invoker`), so it is itself subject to RLS on `machines` —
it can only see a machine row if the caller owns it.

This was not a theoretical concern: the fix exists because a test written
against the naive `auth.uid() = user_id` policy failed first, then passed
once the machine-ownership check was added.

Proved by two tests in `supabase/tests/rls.test.ts`, under `a second user`:

- **`cannot queue a task onto someone else machine`** — a second user
  (`mallory`) tries to insert a task with the first user's (`alice`'s)
  `user_id` *and* `machine_id`; rejected because `user_id` doesn't match
  the caller.
- **`cannot forge a task owned by themselves on another machine`** — the
  same second user tries to insert a task with her **own** `user_id` but
  `alice`'s `machine_id`; this is the case that would have passed under
  the naive policy, and it's rejected because
  `machine_belongs_to_current_user` returns false for a machine she
  doesn't own.

### 3. A row can only be attached to a parent the caller can see

The same gap that let a task be queued onto someone else's machine also
existed one level down: `events.task_id` and `approvals.task_id` are
foreign keys into `tasks`, and a foreign key reference does not pass
through row-level security either. A naive `auth.uid() = user_id` insert
policy on `events` or `approvals` lets a second user insert a row with her
**own** `user_id` but **someone else's** `task_id` — forging an event in
another user's task timeline, or forging an approval request against
another user's task. The INSERT policies on both tables close this the
same way `tasks` does, with a `security invoker` function:

```sql
create policy "events are created by their owner"
  on public.events for insert
  with check (
    auth.uid() = user_id
    and public.task_belongs_to_current_user(task_id)
  );

create policy "approvals are created by their owner"
  on public.approvals for insert
  with check (
    auth.uid() = user_id
    and public.task_belongs_to_current_user(task_id)
  );
```

`task_belongs_to_current_user` (added in
`20260916134205_restrict_event_and_approval_task_ownership.sql`) runs as
the calling user (`security invoker`), so it is itself subject to RLS on
`tasks` — it can only see a task row if the caller owns it.

This was proved live before it was fixed: a reviewer, signed in as a
second user, inserted both an event and an approval referencing another
user's `task_id` and got HTTP 201 for both, under the naive policy.

Proved by tests in `supabase/tests/rls.test.ts`:

- **`a second user > cannot insert an event referencing someone else task`**
  — a second user (`mallory`) tries to insert an event with her **own**
  `user_id` but `alice`'s `task_id`; rejected because
  `task_belongs_to_current_user` returns false for a task she doesn't own.
- **`a second user > cannot insert an approval referencing someone else
  task`** — the same forgery against `approvals`, rejected the same way.
- The `approvals` describe block (`the owner sees their own approval`, `a
  second user sees no approvals`, `a second user cannot read one by id`,
  `a second user cannot update someone else approval`) proves the rest of
  `approvals`' isolation, mirroring the coverage `machines`, `tasks` and
  `events` already had.

### 4. Every foreign key into a user-owned table is guarded by an ownership check

A foreign key reference does not pass through row-level security. The same
vulnerability class was found three times by hand in this schema:
`tasks.machine_id`, `events.task_id`/`approvals.task_id`, and `tasks.parent_task_id`.

Because `parent_task_id` is a nullable, self-referencing foreign key into `tasks`,
`20260916135039_restrict_parent_task_ownership.sql` ensures both the INSERT and UPDATE
policies on `tasks` check:

```sql
(parent_task_id is null or task_belongs_to_current_user(parent_task_id))
```

Proved by tests in `supabase/tests/rls.test.ts`:

- **`a second user > cannot create a task referencing someone else task as parent`**
- **`a second user > cannot update a task to reference someone else task as parent`**
- **`a second user > can create a task referencing their own task as parent`**

Mechanically enforced by **`supabase/tests/schema-invariants.test.ts`**:
The test inspects Postgres's `pg_constraint` catalog for every foreign key in `public`
referencing a table with a `user_id` column. It asserts that the referencing table's
INSERT policy contains an ownership check (`auth.uid() = <col>` or `*_belongs_to_current_user(<col>)`).
If a newly added table or foreign key lacks this check, the test fails automatically.
