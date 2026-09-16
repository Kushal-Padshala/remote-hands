# Daemon Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first testable `packages/daemon` foundation for local task claiming, heartbeats, event sequencing, and `agy` runner boundaries.

**Architecture:** The daemon package is split into small TypeScript units: `config` parses startup inputs, `runtime` describes the host, `task-store` defines the persistence boundary, `memory-task-store` provides test/local behavior, `agy-runner` translates tasks to CLI args and parses stream records, and `daemon` coordinates one unit of work. Supabase, Chrome streaming, approval hooks, and launchd are intentionally left to later plans.

**Tech Stack:** Node 22, TypeScript strict mode, npm workspaces, Vitest, Zod, `@remote-hands/shared`.

**Spec:** `docs/superpowers/specs/2026-09-16-daemon-foundation-design.md`

## Global Constraints

- Node `>=22.0.0`.
- TypeScript `strict: true` everywhere.
- No `any` in committed code.
- Commit messages use Conventional Commits.
- Never emit or use `--dangerously-skip-permissions`.
- The service-role key remains test-only and must not appear in `packages/daemon`.
- This phase does not add database migrations.
- This phase does not implement Chrome CDP screencast or approval hooks.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/daemon/package.json` | Workspace metadata, package scripts, dependencies. |
| `packages/daemon/tsconfig.json` | Source compiler configuration. |
| `packages/daemon/tsconfig.test.json` | Test compiler configuration. |
| `packages/daemon/src/config.ts` | Environment parsing and daemon configuration. |
| `packages/daemon/src/runtime.ts` | Host runtime metadata helpers. |
| `packages/daemon/src/task-store.ts` | Store interface and event input types. |
| `packages/daemon/src/memory-task-store.ts` | Deterministic in-memory store for tests and local development. |
| `packages/daemon/src/agy-runner.ts` | `agy` argument builder, stream parser, and runner interface. |
| `packages/daemon/src/daemon.ts` | One-cycle daemon coordinator. |
| `packages/daemon/src/index.ts` | Public package exports. |
| `packages/daemon/src/*.test.ts` | Focused Vitest suites for each behavior. |
| `.env.example` | Document daemon development variables. |
| `docs/development.md` | Document daemon package checks and local config. |
| `README.md` | Update roadmap to show Phase 2 foundation progress. |

### Task 1: Document Phase 2 foundation

**Files:**
- Create: `docs/superpowers/specs/2026-09-16-daemon-foundation-design.md`
- Create: `docs/superpowers/plans/2026-09-16-daemon-foundation.md`

**Interfaces:**
- Consumes: Phase 1 design and README roadmap.
- Produces: A written implementation scope for this phase.

- [ ] **Step 1: Write the daemon foundation design**

Create `docs/superpowers/specs/2026-09-16-daemon-foundation-design.md` with the approved scope: config, runtime metadata, task store boundary, `agy` runner boundary, one-cycle daemon coordinator, error handling, and tests.

- [ ] **Step 2: Write the implementation plan**

Create `docs/superpowers/plans/2026-09-16-daemon-foundation.md` with task boundaries that can be committed independently.

- [ ] **Step 3: Self-review**

Run:

```bash
rg -n "TBD|TODO|implement later|fill in details|dangerously-skip-permissions" docs/superpowers/specs/2026-09-16-daemon-foundation-design.md docs/superpowers/plans/2026-09-16-daemon-foundation.md
```

Expected: only the deliberate `--dangerously-skip-permissions` safety references appear.

- [ ] **Step 4: Commit and push**

```bash
git add docs/superpowers/specs/2026-09-16-daemon-foundation-design.md docs/superpowers/plans/2026-09-16-daemon-foundation.md
git commit -m "docs: define daemon foundation phase"
git push origin main
```

### Task 2: Add daemon package config and runtime metadata

**Files:**
- Create: `packages/daemon/package.json`
- Create: `packages/daemon/tsconfig.json`
- Create: `packages/daemon/tsconfig.test.json`
- Create: `packages/daemon/src/config.ts`
- Create: `packages/daemon/src/runtime.ts`
- Create: `packages/daemon/src/index.ts`
- Test: `packages/daemon/src/config.test.ts`
- Test: `packages/daemon/src/runtime.test.ts`

**Interfaces:**
- Consumes: root npm workspace and `tsconfig.base.json`.
- Produces:
  - `interface DaemonConfig`
  - `function parseDaemonConfig(env: Record<string, string | undefined>): DaemonConfig`
  - `interface RuntimeMetadata`
  - `function getRuntimeMetadata(input?: RuntimeMetadataInput): RuntimeMetadata`

- [ ] **Step 1: Write failing config tests**

`packages/daemon/src/config.test.ts` should assert:

```ts
expect(parseDaemonConfig(validEnv).agyCommand).toBe('agy');
expect(parseDaemonConfig(validEnv).pollIntervalMs).toBe(5000);
expect(() => parseDaemonConfig({})).toThrow(/REMOTE_HANDS_SUPABASE_URL/);
expect(() => parseDaemonConfig({ ...validEnv, REMOTE_HANDS_POLL_INTERVAL_MS: '0' })).toThrow(/positive/);
```

- [ ] **Step 2: Verify config tests fail**

Run:

```bash
npm test -- packages/daemon/src/config.test.ts
```

Expected: fail because the package/files do not exist yet.

- [ ] **Step 3: Implement config and package scaffolding**

Create the package files and `parseDaemonConfig` using Zod.

- [ ] **Step 4: Write failing runtime tests**

`packages/daemon/src/runtime.test.ts` should assert injected hostname/version values are returned without reading global state.

- [ ] **Step 5: Verify runtime tests fail, then implement runtime**

Run the runtime test, then add `getRuntimeMetadata`.

- [ ] **Step 6: Verify package**

Run:

```bash
npm test -- packages/daemon
npm run typecheck
```

- [ ] **Step 7: Commit and push**

```bash
git add package.json package-lock.json packages/daemon
git commit -m "feat(daemon): add config and runtime foundation"
git push origin main
```

### Task 3: Add task store boundary and memory implementation

**Files:**
- Create: `packages/daemon/src/task-store.ts`
- Create: `packages/daemon/src/memory-task-store.ts`
- Test: `packages/daemon/src/memory-task-store.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Consumes: `Task`, `TaskEvent`, `EventKind`, `EventPayload` from `@remote-hands/shared`.
- Produces:
  - `interface EventInput<K extends EventKind = EventKind>`
  - `interface TaskStore`
  - `class MemoryTaskStore implements TaskStore`

- [ ] **Step 1: Write failing store tests**

Tests should prove:

```ts
const task = await store.claimNextTask(machine.id);
expect(task?.status).toBe('claimed');
await store.appendEvent(task.id, { kind: 'status', payload: { status: 'running' } });
expect(store.eventsForTask(task.id)[0]?.seq).toBe(0);
```

Also assert heartbeat sets `status: 'online'` and `last_seen_at`.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- packages/daemon/src/memory-task-store.test.ts
```

Expected: fail because the store does not exist yet.

- [ ] **Step 3: Implement store interface and memory store**

Implement deterministic task claiming, status updates, event sequencing, completion, and failure helpers.

- [ ] **Step 4: Verify package**

Run:

```bash
npm test -- packages/daemon
npm run typecheck
```

- [ ] **Step 5: Commit and push**

```bash
git add packages/daemon/src/task-store.ts packages/daemon/src/memory-task-store.ts packages/daemon/src/memory-task-store.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): add task store lifecycle boundary"
git push origin main
```

### Task 4: Add `agy` runner boundary

**Files:**
- Create: `packages/daemon/src/agy-runner.ts`
- Test: `packages/daemon/src/agy-runner.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Consumes: `Task` from `@remote-hands/shared` and `DaemonConfig`.
- Produces:
  - `interface AgentRunResult`
  - `interface AgentRunner`
  - `function buildAgyArgs(task: Task, config: Pick<DaemonConfig, 'agyCommand'>): readonly string[]`
  - `function parseAgyStreamLine(line: string): AgentStreamRecord | null`
  - `class StaticAgentRunner implements AgentRunner`

- [ ] **Step 1: Write failing runner tests**

Tests should assert:

```ts
expect(buildAgyArgs(task, config)).toContain('--output-format');
expect(buildAgyArgs(task, config)).not.toContain('--dangerously-skip-permissions');
expect(parseAgyStreamLine('')).toBeNull();
expect(parseAgyStreamLine('{"type":"text","text":"hi"}')).toEqual({
  kind: 'agent_text',
  payload: { text: 'hi' },
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- packages/daemon/src/agy-runner.test.ts
```

Expected: fail because the runner does not exist yet.

- [ ] **Step 3: Implement runner boundary**

Support known record shapes for text, thinking, tool call, tool result, status,
error, and result records. Unknown records return `null`.

- [ ] **Step 4: Verify package**

Run:

```bash
npm test -- packages/daemon
npm run typecheck
```

- [ ] **Step 5: Commit and push**

```bash
git add packages/daemon/src/agy-runner.ts packages/daemon/src/agy-runner.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): add agy runner boundary"
git push origin main
```

### Task 5: Add one-cycle daemon coordinator and docs

**Files:**
- Create: `packages/daemon/src/daemon.ts`
- Test: `packages/daemon/src/daemon.test.ts`
- Modify: `packages/daemon/src/index.ts`
- Modify: `.env.example`
- Modify: `docs/development.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `TaskStore`, `AgentRunner`, `DaemonConfig`, and `RuntimeMetadata`.
- Produces:
  - `interface RunDaemonOnceResult`
  - `async function runDaemonOnce(input: RunDaemonOnceInput): Promise<RunDaemonOnceResult>`

- [ ] **Step 1: Write failing daemon tests**

Tests should prove no-task, success, and failure behavior:

```ts
expect(await runDaemonOnce(inputWithoutTasks)).toEqual({ claimed: false });
expect(doneTask.status).toBe('done');
expect(failedTask.status).toBe('failed');
expect(store.eventsForTask(task.id).map((event) => event.kind)).toContain('error');
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- packages/daemon/src/daemon.test.ts
```

Expected: fail because the coordinator does not exist yet.

- [ ] **Step 3: Implement coordinator**

Register machine, heartbeat, claim one task, mark it running, append runner
events, complete or fail the task.

- [ ] **Step 4: Update docs**

Document daemon env vars in `.env.example`, daemon package verification in
`docs/development.md`, and Phase 2 foundation progress in `README.md`.

- [ ] **Step 5: Final verification**

Run:

```bash
npm run typecheck
npm test -- packages/daemon
npm test -- packages/shared
```

- [ ] **Step 6: Commit and push**

```bash
git add packages/daemon .env.example docs/development.md README.md
git commit -m "feat(daemon): coordinate one task lifecycle"
git push origin main
```

