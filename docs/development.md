# Local development

This is the setup a contributor needs before touching code. It gets you a
running local Supabase instance, the test suite green, and the type checker
clean. It does not run an agent — see the README's Status section for what
exists today.

## Prerequisites

- Node >= 22
- Docker, running. Local Supabase is a set of Docker containers; the CLI
  starts and stops them for you, but the Docker daemon itself has to already
  be up.
- `gh`, the GitHub CLI, for opening pull requests.

## Install

```
npm install
```

This is an npm workspaces repo. One install at the root covers
`packages/shared` and the `supabase` test workspace.

## Start local Supabase

```
npm run db:start
```

The first run pulls several Docker images and takes a few minutes. When it
finishes it prints a table including the local API URL and two keys (an
anon key and a service role key).

Copy those into a `.env` file at the repo root — see `.env.example` for the
variable names (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`). `.env` is git-ignored; never commit it, and
never paste the printed keys into a tracked file, a commit message, or a PR
description. They are only ever valid for your local containers.

## Apply the schema

```
npm run db:reset
```

This applies every migration in `supabase/migrations` to your local
instance from scratch. Run it again whenever the schema changes or your
local database drifts from the migrations.

## Run the tests

```
npm run test
```

This runs every test project (`packages/shared` and `supabase`) through a
single root `vitest.config.mts`. The `supabase` project's tests exercise
row-level security against your local instance using the keys from `.env`,
so `db:start` and `db:reset` need to have already succeeded.

## Type-check

```
npm run typecheck
```

This builds every package's source with `tsc --build`, then runs each
package's `typecheck:tests` script, so both source and test files are
checked — including type-level assertions that fail if the hand-written
types in `packages/shared` drift from the SQL schema.

## Regenerating types from the schema

```
npm run db:types
```

Writes `packages/shared/src/database.generated.ts` from your local
instance's current schema. Run this after adding or changing a migration,
then run `npm run typecheck` to confirm the hand-written types in
`packages/shared` still agree with it.

## Stopping

```
npm run db:stop
```

Stops the local Supabase containers. Your data persists across `db:start` /
`db:stop`; `db:reset` is what wipes it back to the migrations.

## If Docker is not running

`npm run db:start` fails outright — the Supabase CLI cannot reach the Docker
daemon. Start Docker Desktop (or your Docker daemon of choice) and run
`npm run db:start` again. Without Docker running you can still run
`npm run typecheck` and the `packages/shared` unit tests, but not the
`supabase` RLS test suite, which needs a live database.

If Docker *is* running but `db:start` fails with a container health-check
timeout (`LegacyHealthCheckTimeoutError`, `LegacyStatusDbNotReadyError`, or a
container-name conflict from a previous run), that's the CLI racing its own
~10-container stack rather than something wrong with this repo. Run
`npm run db:start` again; it is safe to retry.
