# Local development

This documents the setup for contributors. The default self-hosted control plane is Cloudflare (Workers, D1, Durable Objects); Supabase is retained as an optional backend adapter.

## Prerequisites

- **Node.js**: `>=22.0.0`
- **Docker** *(Optional)*: Only required if you are actively working on or testing the optional `supabase/` backend adapter.
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

To run only the daemon foundation tests:

```
npm test -- packages/daemon
```

These tests do not launch `agy` or connect to Supabase. They exercise the
config parser, runtime metadata helper, in-memory task store, `agy` argument
builder, stream parser, and one-cycle daemon coordinator.

## Type-check

```
npm run typecheck
```

This builds every package's source with `tsc --build`, then runs each
package's `typecheck:tests` script, so both source and test files are
checked — including type-level assertions that fail if the hand-written
types in `packages/shared` drift from the SQL schema.

## Daemon development configuration

The daemon package reads its startup configuration from environment variables.
For local development, copy the daemon section from `.env.example` into your
git-ignored `.env` and adjust the machine name and workspace allowlist:

```
REMOTE_HANDS_SUPABASE_URL=http://127.0.0.1:54321
REMOTE_HANDS_SUPABASE_ANON_KEY=replace-me
REMOTE_HANDS_MACHINE_NAME=office-mac
REMOTE_HANDS_AGY_COMMAND=agy
REMOTE_HANDS_WORKSPACE_ALLOWLIST=/Users/you/projects/site:/Users/you/projects/app
REMOTE_HANDS_POLL_INTERVAL_MS=5000
REMOTE_HANDS_HEARTBEAT_INTERVAL_MS=15000
```

The current daemon foundation is intentionally injectable and test-first. It
does not yet start a long-running process, store credentials, subscribe to
Supabase Realtime, capture Chrome frames, or install a launchd agent.

## MCP computer tools, swift cache, warm agy session

### `rh mcp`

- `rh mcp serve` runs a stdio MCP server (the default subcommand) that hosts one long-lived computer session exposing the `desktop_*`, `browser_*` and `computer_batch` tools. It is meant to be launched by an MCP client, not by hand.
- `rh mcp install` registers the server with `agy` by running `agy mcp add rh-computer -- <node> <rh entry path> mcp serve`. It uses the node binary and `rh` entry file of the process that ran the command, so run it from the `rh` you want `agy` to use. It exits 1 with the `agy` error if registration fails (for example when `agy` is not on `PATH`).
- `rh mcp remove` runs `agy mcp remove rh-computer`.

Check the registration with `agy mcp list`.

### Installed `rh` runs a copied bundle

The installed `rh` binary runs the bundle copied to `~/.remote-hands/cli/index.js`, which this repo does not track. After `npm run build`, the new bundle is `packages/cli/dist/index.js`; it must be copied over `~/.remote-hands/cli/index.js` before the installed `rh` (and an `rh mcp install` run from it) picks up your changes. Keep a backup of the old bundle before overwriting it.

### Benchmark

```
node scripts/bench-actions.mjs [runs]
```

`runs` defaults to 5. It runs `rh desktop window list`, `rh desktop snapshot --no-ocr`, `rh browser tabs` and a cold `agy` turn (`gemini-3.8-flash`, low effort), and prints the median wall time in milliseconds for each. It uses the installed `rh` and `agy` from `PATH`. Run it once first so the swift cache is populated.

### Swift binary cache

Desktop actions that previously ran `swift -e <script>` (a compile on every call) now compile once with `swiftc -O` and run the cached binary. Per-call values are passed through environment variables; scripts whose values cannot be hoisted that way run uncached and are never written to disk.

- Location: `~/.remote-hands/swift-cache`, one directory per template hash. Override with `RH_SWIFT_CACHE_DIR`.
- Permissions: the cache and its entries are created with mode `0700`.
- A genuine `swiftc` compile error writes a `failed` marker that makes that template fall back to `swift -e` for 10 minutes; after that it is retried.
- The cache is safe to delete at any time. Binaries are rebuilt on the next call (the first call after deleting is slower).

### Warm agy session

The daemon keeps one long-lived `agy` process per HUD, using `--input-format stream-json --output-format stream-json`, instead of spawning a cold `agy -p` for every task.

- It is prewarmed when the HUD starts listening, with the HUD task mode, so the first task does not pay process start-up.
- Later tasks in the same conversation are sent to the same process.
- The hotkey starts a fresh conversation: the process is reset and a new one is prewarmed. An idle prewarmed process that has never served a turn is kept as is.
- Cancelling a HUD task kills the warm process group, drops the conversation history and prewarms a fresh process immediately.
- The warm process is spawned once, so it does not get the per-task `REMOTE_HANDS_TASK_ID` environment variable. The HUD adds a `Task id: <id>` line to every turn, and approvals must pass it as `rh approve "<action>" --task=<id> ...`.
- There is no per-turn timeout (`--print-timeout 0`); cancel is the way to stop a turn.
- The first turn of a new process is slow because `agy` loads its MCP servers (see the measurements in the fast HUD design spec).

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
