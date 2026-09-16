# remote-hands — Daemon Foundation Design

**Date:** 2026-09-16
**Status:** Approved for implementation
**Repository:** https://github.com/Kushal-Padshala/remote-hands

---

## 1. Summary

Phase 2 starts the local machine daemon without taking on the full browser
streaming problem yet. This slice creates `packages/daemon`: a Node 22
TypeScript package that can load configuration, describe a local machine,
claim queued tasks, heartbeat while work is active, translate agent output into
append-only events, and run `agy` behind a small testable boundary.

The package must be useful before a real Supabase connection is wired end to
end. To keep the foundation safe and testable, the core daemon loop depends on
interfaces rather than directly constructing network clients or child processes.
Later slices can attach Supabase Realtime, Chrome CDP screencast streaming, and
approval hooks without changing the lifecycle contract.

## 2. Scope

This phase builds the daemon foundation only:

- `packages/daemon` workspace package with strict TypeScript and Vitest tests.
- Environment/config parsing for Supabase URL, anon key, machine name,
  workspace allowlist, polling/heartbeat intervals, and `agy` command path.
- Host identity helpers for machine registration metadata.
- A task lifecycle coordinator that claims one queued task, marks it running,
  streams ordered events, and completes or fails the task.
- A heartbeat helper that reports `online` and `last_seen_at` while the daemon
  is alive.
- An `agy` command builder and stream parser for newline-delimited JSON records.
- Documentation for running the daemon package in development.

Out of scope for this phase:

- Pairing UX and durable credential storage.
- Supabase Realtime subscription implementation.
- Chrome CDP screencast capture.
- Approval hook integration.
- launchd installation.

## 3. Boundaries

### 3.1 `config`

Configuration is parsed from a plain environment object. Tests pass explicit
objects; production entrypoints pass `process.env`.

Required variables:

- `REMOTE_HANDS_SUPABASE_URL`
- `REMOTE_HANDS_SUPABASE_ANON_KEY`
- `REMOTE_HANDS_MACHINE_NAME`

Optional variables:

- `REMOTE_HANDS_AGY_COMMAND`, default `agy`
- `REMOTE_HANDS_WORKSPACE_ALLOWLIST`, path-list separated by `:`
- `REMOTE_HANDS_POLL_INTERVAL_MS`, default `5000`
- `REMOTE_HANDS_HEARTBEAT_INTERVAL_MS`, default `15000`

Invalid URLs, missing required values, non-positive intervals, and empty
allowlist entries are rejected at startup.

### 3.2 `runtime`

Runtime metadata is intentionally small:

- `hostname` from Node's `os.hostname()`
- `daemonVersion` from `packages/daemon/package.json`
- `agyVersion`, supplied by the agent runner once a later slice probes the CLI

### 3.3 `task-store`

The daemon core consumes a `TaskStore` interface. The first implementation in
this phase is an in-memory fake for tests and local development. The interface
matches what the Supabase adapter will need later:

- `registerMachine`
- `heartbeat`
- `claimNextTask`
- `markTaskRunning`
- `appendEvent`
- `completeTask`
- `failTask`

The store, not the agent runner, owns event sequence numbers. This preserves the
append-only event ledger invariant from Phase 1.

### 3.4 `agy-runner`

The runner boundary has two layers:

- `buildAgyArgs(task, config)` returns the exact CLI arguments for a task.
- `parseAgyStreamLine(line)` converts one NDJSON line into a daemon event input
  or ignores empty/unknown records.

The process-spawning implementation is deliberately small and injectable. Tests
exercise argument construction and parsing without launching `agy`.

### 3.5 `daemon`

`runDaemonOnce` performs one unit of work:

1. Register or refresh the machine row.
2. Heartbeat the machine.
3. Claim one queued task.
4. Mark it `running`.
5. Run the agent.
6. Append ordered events as agent records arrive.
7. Mark the task `done` with a summary and conversation id, or `failed` with a
   captured error message.

This keeps the first daemon loop deterministic and easy to test. A later
long-running CLI can call this function on an interval and wire cancellation
signals around it.

## 4. Error Handling

Configuration errors fail fast before any network or process work begins.
Agent failures append an `error` event and mark the task `failed`. Unknown agent
stream records are ignored rather than written as malformed events. Empty stream
lines are ignored.

The daemon must not skip permission checks. `buildAgyArgs` never emits
`--dangerously-skip-permissions`.

## 5. Testing

Tests are package-local Vitest suites:

- Config tests prove defaults, parsing, and rejection behavior.
- Runner tests prove command args and stream parsing.
- Task-store tests prove claim ordering, heartbeat updates, and event sequence
  assignment.
- Daemon tests prove no-task behavior, successful task completion, and failure
  marking.

Root `npm run typecheck` and `npm test -- packages/daemon` must pass after this
phase. Supabase RLS tests remain unchanged because this phase does not add
database migrations.

