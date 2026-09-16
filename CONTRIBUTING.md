# Contributing to remote-hands

Thanks for looking at this. Before anything else, read the "Read this first"
section of the README and `SECURITY.md`. This project runs an autonomous
agent with access to a real, logged-in browser; contributions that touch the
approval gate, the risk classifier, or row-level security need to be held to
that standard.

## Prerequisites

- Node >= 22
- Docker, for running Supabase locally
- `gh`, the GitHub CLI

## Getting started

```
npm install
npm run db:start
```

`db:start` prints the local Supabase URL and keys. Copy them into a `.env`
file at the repo root (see `.env.example` for the variable names). Never
commit `.env` — it is already covered by `.gitignore`, and it should stay
that way.

```
npm run db:reset
npm run test
npm run typecheck
```

`db:reset` applies the migrations in `supabase/migrations` to your local
instance from scratch. Run it again any time the schema changes or your local
database drifts.

## How this project works: test-first

Changes to behavior land with the test that fails without them. If you're
fixing a bug, write a test that reproduces it before you write the fix. If
you're adding a feature, write the test for the behavior you want before the
code that provides it. A pull request that changes behavior without a test
demonstrating that behavior will be asked to add one.

This matters more than usual here because a mistake in the risk classifier or
the RLS policies has real consequences on someone's machine, not just a
failing build.

## Commit conventions

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope):
  subject`, e.g. `fix(daemon): retry heartbeat on transient network error`.
- Subject line, 72 characters or fewer.
- Add a body when the reason for the change isn't obvious from the diff
  itself — explain *why*, not just what changed. The diff already shows what
  changed.

## Security rules for contributions

These are enforced in review, not optional style preferences:

- **Every new table enables row-level security in the same migration that
  creates it.** Not a follow-up migration — the same one. A table that is
  briefly open between migrations is a table someone can query during that
  window.
- **The `service_role` key is confined to test files.** Application and
  daemon code never reads or holds it. If you find yourself reaching for it
  outside a test, that's a sign the change needs a different approach.
- **No secrets in commits.** No API keys, tokens, `.env` contents, or
  real credentials, including in test fixtures or example output. If you
  accidentally commit one, don't just remove it in a follow-up commit — tell
  us so it can be rotated and scrubbed from history.

## Where things live

- `packages/shared` — types shared across the daemon, the phone app, and any
  other process. If you're changing a shape that crosses a process boundary
  (an event, a task, a row shape), it likely belongs here.
- `supabase/migrations` — the schema, as a sequence of SQL migrations. This is
  the source of truth for the database; don't hand-edit a live schema outside
  of a migration.
- `docs/superpowers/specs` — design documents: what a feature is and why it's
  shaped the way it is.
- `docs/superpowers/plans` — implementation plans: the sequenced steps for
  building what a spec describes.

If you're not sure where a change belongs, open a draft PR or an issue with
your question rather than guessing — it's cheaper to redirect early than to
rework a finished change.
