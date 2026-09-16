# remote-hands

Send a task to your own computer from your phone. Watch the agent do it in your
real, logged-in browser. Approve anything irreversible before it happens.

## Read this first

remote-hands runs an autonomous agent on your machine with access to your files
and to your signed-in browser sessions — your email, your source control, your
hosting, your bank. Anyone who obtains your credentials for this system obtains
that access. It requires approval for irreversible actions by default, denies on
timeout, and never uses `--dangerously-skip-permissions`. Understand the blast
radius before you run it.

## Status

Foundation only. There is no daemon, no phone app, no browser integration,
and no approval gate yet — none of it runs. What exists today:

- A Supabase schema (`supabase/migrations`) for four tables — `machines`,
  `tasks`, `events`, `approvals` — each with row-level security enabled in
  the migration that creates it, isolating one user's data from another's.
- Two invariants proved by a two-user test suite: the event log is
  append-only, and a task can't be queued onto a machine the caller can't
  see. See `docs/architecture/control-plane.md` for the schema and the
  tests that prove it.
- Shared TypeScript types and runtime (Zod) validation for these shapes in
  `packages/shared`, type-checked against the generated database schema so
  the two can't silently drift apart.

See `docs/development.md` to set up and run the tests locally, and
`docs/superpowers/specs/` and `docs/superpowers/plans/` for the design and
the sequenced plan this came from.
