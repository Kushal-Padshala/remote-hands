# remote-hands — Plan 1: Foundation & Control Plane

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the repository, the shared event contract, and the Supabase control plane with row-level security proven by test, so every later subsystem has a typed, secure foundation to build against.

**Architecture:** An npm workspace monorepo. `packages/shared` owns the types and runtime validation that cross process boundaries between daemon, hook and phone app — it is the single source of truth for the event contract. `supabase/migrations` owns the schema; every table enables RLS and declares its policies in the same migration that creates it, so no revision of this repo ever exists with an open table. A Vitest integration suite runs two real users against a local Supabase and asserts each sees only their own rows.

**Tech Stack:** Node 22, TypeScript 5.7, npm workspaces, Vitest 3, Zod 4, `@supabase/supabase-js` v2, Supabase CLI via `npx`, Docker (for local Supabase), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-16-remote-hands-design.md`

## Global Constraints

- Node `>=22.0.0`. Declared in every `package.json` `engines` field.
- TypeScript `strict: true` everywhere. No `any` in committed code.
- Licence: MIT. Copyright holder: `Kushal Padshala`.
- Commit messages: Conventional Commits. Subject <= 72 characters.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Every table enables RLS in the same migration that creates it.** A migration that creates a table without `enable row level security` is a defect, not a follow-up.
- The `service_role` key is used only inside `supabase/tests/`. It must never appear in `packages/` or `apps/`.
- `.env` and `.env.*` are git-ignored from the first commit; `.env.example` documents every variable with a placeholder value.
- Task status values, exactly: `queued`, `claimed`, `running`, `awaiting_approval`, `done`, `failed`, `cancelled`.
- Event kind values, exactly: `agent_text`, `thinking`, `tool_call`, `tool_result`, `file_diff`, `command_output`, `browser_action`, `status`, `approval_requested`, `error`, `result`.
- Approval decision values, exactly: `pending`, `approved`, `rejected`, `expired`.
- Risk values, exactly: `low`, `medium`, `high`.
- Task kind values, exactly: `browser`, `coding`, `mixed`, `auto`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | Workspace root, shared scripts |
| `tsconfig.base.json` | Compiler options every package extends |
| `vitest.workspace.ts` | Discovers test projects |
| `.gitignore`, `.env.example` | Secret hygiene |
| `LICENSE`, `README.md` | Public face of the repo |
| `.github/workflows/ci.yml` | Typecheck, test, secret scan |
| `packages/shared/src/machine.ts` | Machine row shape and status |
| `packages/shared/src/task.ts` | Task row shape, status transition rules |
| `packages/shared/src/event.ts` | Event kinds, Zod payload schemas, parser |
| `packages/shared/src/approval.ts` | Approval shape, expiry logic |
| `packages/shared/src/index.ts` | Public surface of the package |
| `supabase/migrations/*.sql` | Schema, one table per migration, RLS included |
| `supabase/tests/rls.test.ts` | Two-user isolation proof |
| `supabase/tests/helpers.ts` | Local client and user factory |

`event.ts` is the file most likely to grow. If it passes roughly 250 lines, split the per-kind payload schemas into `event-payloads.ts` and keep the union and parser in `event.ts`.

---

### Task 1: Repository scaffolding

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `LICENSE`, `README.md`, `.github/workflows/ci.yml`, `vitest.workspace.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an npm workspace with `npm run typecheck` and `npm run test` at the root; packages are discovered from `packages/*` and `apps/*`.

- [ ] **Step 1: Create `.gitignore` before anything else**

```gitignore
node_modules/
dist/
*.tsbuildinfo
.env
.env.*
!.env.example
.DS_Store
supabase/.temp/
supabase/.branches/
coverage/
```

- [ ] **Step 2: Create `LICENSE`**

MIT text, `Copyright (c) 2026 Kushal Padshala`.

- [ ] **Step 3: Create the workspace root `package.json`**

```json
{
  "name": "remote-hands",
  "private": true,
  "version": "0.0.0",
  "license": "MIT",
  "engines": { "node": ">=22.0.0" },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "typecheck": "tsc --build --verbose",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:start": "npx --yes supabase@latest start",
    "db:stop": "npx --yes supabase@latest stop",
    "db:reset": "npx --yes supabase@latest db reset"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 5: Create `vitest.workspace.ts`**

```ts
export default ['packages/*', 'supabase'];
```

- [ ] **Step 6: Create `.env.example`**

```bash
# Local Supabase (npm run db:start prints these)
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=replace-me
# Tests only. Never used by the daemon or the web app.
SUPABASE_SERVICE_ROLE_KEY=replace-me
```

- [ ] **Step 7: Create `README.md`**

The first section after the title must be the security notice, because the repo is public and will be forked:

```markdown
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

Under construction. See `docs/superpowers/specs/` for the design and
`docs/superpowers/plans/` for the implementation plan.
```

- [ ] **Step 8: Create `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test -- packages/shared
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The `check` job runs only the `packages/shared` path because the RLS suite
needs a local Supabase; Task 8 wires that into CI as a separate job.

- [ ] **Step 9: Install and verify**

Run: `npm install && npm run typecheck`
Expected: install succeeds; `tsc --build` reports no projects to build and exits 0.

- [ ] **Step 10: Commit**

```bash
git add .gitignore LICENSE package.json package-lock.json tsconfig.base.json vitest.workspace.ts .env.example README.md .github/
git commit -m "chore: scaffold npm workspace, CI and secret hygiene

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared package with machine and task types

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/machine.ts`, `packages/shared/src/task.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/task.test.ts`

**Interfaces:**
- Consumes: the workspace and `tsconfig.base.json` from Task 1.
- Produces:
  - `type MachineStatus = 'online' | 'offline'`
  - `interface Machine`
  - `type TaskStatus`, `type TaskKind`, `type TaskMode`
  - `interface Task`
  - `function canTransition(from: TaskStatus, to: TaskStatus): boolean`
  - `function isTerminal(status: TaskStatus): boolean`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@remote-hands/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "engines": { "node": ">=22.0.0" },
  "scripts": { "build": "tsc --build" }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write the failing test**

`packages/shared/src/task.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, TASK_STATUSES } from './task.js';

describe('canTransition', () => {
  it('lets a queued task be claimed', () => {
    expect(canTransition('queued', 'claimed')).toBe(true);
  });

  it('refuses to skip claiming', () => {
    expect(canTransition('queued', 'running')).toBe(false);
  });

  it('lets a running task pause for approval and resume', () => {
    expect(canTransition('running', 'awaiting_approval')).toBe(true);
    expect(canTransition('awaiting_approval', 'running')).toBe(true);
  });

  it('allows cancellation from every non-terminal status', () => {
    for (const s of ['queued', 'claimed', 'running', 'awaiting_approval'] as const) {
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });

  it('refuses every transition out of a terminal status', () => {
    for (const from of ['done', 'failed', 'cancelled'] as const) {
      for (const to of TASK_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('refuses a transition to itself', () => {
    expect(canTransition('running', 'running')).toBe(false);
  });
});

describe('isTerminal', () => {
  it('classifies each status', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('awaiting_approval')).toBe(false);
  });
});
```

- [ ] **Step 4: Write the failing test for machine liveness**

`packages/shared/src/machine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isMachineOnline, type Machine } from './machine.js';

function machine(last_seen_at: string | null): Machine {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    user_id: '22222222-2222-4222-8222-222222222222',
    name: 'alice-air',
    hostname: 'alice-air.local',
    agy_version: '1.2.4',
    daemon_version: '0.0.0',
    status: 'offline',
    last_seen_at,
    created_at: '2026-09-16T10:00:00.000Z',
  };
}

describe('isMachineOnline', () => {
  const now = new Date('2026-09-16T10:01:00.000Z');

  it('is online one heartbeat ago', () => {
    expect(isMachineOnline(machine('2026-09-16T10:00:45.000Z'), now)).toBe(true);
  });

  it('is offline after three missed heartbeats', () => {
    expect(isMachineOnline(machine('2026-09-16T10:00:10.000Z'), now)).toBe(false);
  });

  it('is offline when it has never reported', () => {
    expect(isMachineOnline(machine(null), now)).toBe(false);
  });

  it('does not trust the stored status column', () => {
    const stale = { ...machine('2026-09-16T10:00:10.000Z'), status: 'online' as const };
    expect(isMachineOnline(stale, now)).toBe(false);
  });
});
```

The last case is the point of the function: a daemon that is killed never gets
to write `status = 'offline'`, so liveness is derived from the heartbeat
timestamp rather than read from a column the dead process was supposed to update.

- [ ] **Step 5: Run both tests and verify they fail**

Run: `npm run test -- packages/shared`
Expected: FAIL — cannot resolve `./task.js` or `./machine.js`.

- [ ] **Step 6: Write `packages/shared/src/machine.ts`**

```ts
export const MACHINE_STATUSES = ['online', 'offline'] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export interface Machine {
  id: string;
  user_id: string;
  name: string;
  hostname: string;
  agy_version: string | null;
  daemon_version: string | null;
  status: MachineStatus;
  last_seen_at: string | null;
  created_at: string;
}

/** A machine is considered offline once it misses this many milliseconds of heartbeats. */
export const MACHINE_OFFLINE_AFTER_MS = 45_000;

export function isMachineOnline(machine: Machine, now: Date = new Date()): boolean {
  if (machine.last_seen_at === null) return false;
  return now.getTime() - Date.parse(machine.last_seen_at) < MACHINE_OFFLINE_AFTER_MS;
}
```

- [ ] **Step 7: Write `packages/shared/src/task.ts`**

```ts
export const TASK_STATUSES = [
  'queued', 'claimed', 'running', 'awaiting_approval',
  'done', 'failed', 'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_KINDS = ['browser', 'coding', 'mixed', 'auto'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_MODES = ['default', 'accept-edits', 'plan'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export interface Task {
  id: string;
  user_id: string;
  machine_id: string;
  prompt: string;
  kind: TaskKind;
  workspace_path: string | null;
  model: string | null;
  effort: string | null;
  mode: TaskMode;
  status: TaskStatus;
  conversation_id: string | null;
  parent_task_id: string | null;
  result_summary: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'failed', 'cancelled']);

const ALLOWED: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['running', 'failed', 'cancelled'],
  running: ['awaiting_approval', 'done', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}
```

- [ ] **Step 8: Write `packages/shared/src/index.ts`**

```ts
export * from './machine.js';
export * from './task.js';
```

- [ ] **Step 9: Run the tests and verify they pass**

Run: `npm run test -- packages/shared`
Expected: PASS, 6 tests in `task.test.ts` and 4 in `machine.test.ts`.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add machine and task types with transition rules

The status machine is enforced in one place so the daemon, the hook and
the phone app cannot disagree about what a task is allowed to do next.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Event contract with runtime validation

**Files:**
- Create: `packages/shared/src/event.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/package.json` (add `zod`)
- Test: `packages/shared/src/event.test.ts`

**Interfaces:**
- Consumes: `TaskStatus` from Task 2.
- Produces:
  - `type EventKind`
  - `const eventPayloadSchemas: Record<EventKind, ZodType>`
  - `interface TaskEvent<K extends EventKind>`
  - `function parseEvent(row: unknown): TaskEvent<EventKind>` — throws on invalid input
  - `function safeParseEvent(row: unknown): { ok: true; event } | { ok: false; error: string }`

Events cross three process boundaries — daemon to Postgres, Postgres to phone,
hook to Postgres — so they are validated at runtime, not merely typed.

- [ ] **Step 1: Add the dependency**

Run: `npm install zod@^4.0.0 --workspace @remote-hands/shared`

- [ ] **Step 2: Write the failing test**

`packages/shared/src/event.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, parseEvent, safeParseEvent } from './event.js';

const base = {
  id: 1,
  task_id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  seq: 0,
  created_at: '2026-09-16T10:00:00.000Z',
};

describe('parseEvent', () => {
  it('accepts an agent_text event', () => {
    const event = parseEvent({ ...base, kind: 'agent_text', payload: { text: 'hello' } });
    expect(event.kind).toBe('agent_text');
    if (event.kind === 'agent_text') expect(event.payload.text).toBe('hello');
  });

  it('accepts a browser_action event with an action label', () => {
    const event = parseEvent({
      ...base,
      kind: 'browser_action',
      payload: { action: 'click', label: 'Publish', url: 'https://example.com/wp-admin' },
    });
    if (event.kind === 'browser_action') expect(event.payload.label).toBe('Publish');
  });

  it('accepts a file_diff event', () => {
    const event = parseEvent({
      ...base,
      kind: 'file_diff',
      payload: { path: 'src/a.ts', additions: 3, deletions: 1, patch: '@@ -1 +1 @@' },
    });
    if (event.kind === 'file_diff') expect(event.payload.additions).toBe(3);
  });

  it('rejects an unknown kind', () => {
    expect(() => parseEvent({ ...base, kind: 'nonsense', payload: {} })).toThrow();
  });

  it('rejects a payload that does not match its kind', () => {
    expect(() => parseEvent({ ...base, kind: 'agent_text', payload: { text: 42 } })).toThrow();
  });

  it('rejects a negative sequence number', () => {
    expect(() => parseEvent({ ...base, seq: -1, kind: 'agent_text', payload: { text: 'x' } })).toThrow();
  });

  it('defines a payload schema for every declared kind', () => {
    for (const kind of EVENT_KINDS) {
      expect(() => safeParseEvent({ ...base, kind, payload: {} })).not.toThrow();
    }
  });
});

describe('safeParseEvent', () => {
  it('reports failure without throwing', () => {
    const result = safeParseEvent({ ...base, kind: 'agent_text', payload: { text: 42 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/text/);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npm run test -- packages/shared/src/event.test.ts`
Expected: FAIL — cannot resolve `./event.js`.

- [ ] **Step 4: Write `packages/shared/src/event.ts`**

```ts
import { z } from 'zod';
import { TASK_STATUSES } from './task.js';

export const EVENT_KINDS = [
  'agent_text', 'thinking', 'tool_call', 'tool_result',
  'file_diff', 'command_output', 'browser_action',
  'status', 'approval_requested', 'error', 'result',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const agentText = z.object({ text: z.string() });
const thinking = z.object({ text: z.string() });
const toolCall = z.object({
  tool: z.string(),
  input: z.unknown().optional(),
  call_id: z.string().optional(),
});
const toolResult = z.object({
  call_id: z.string().optional(),
  ok: z.boolean().default(true),
  output: z.string().optional(),
});
const fileDiff = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
});
const commandOutput = z.object({
  command: z.string(),
  exit_code: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
const browserAction = z.object({
  action: z.enum(['navigate', 'click', 'type', 'scroll', 'screenshot', 'other']),
  label: z.string().optional(),
  url: z.string().optional(),
});
const status = z.object({ status: z.enum(TASK_STATUSES) });
const approvalRequested = z.object({ approval_id: z.string().uuid() });
const errorPayload = z.object({ message: z.string(), fatal: z.boolean().default(false) });
const result = z.object({
  summary: z.string(),
  conversation_id: z.string().optional(),
  duration_seconds: z.number().optional(),
});

/**
 * Every schema is `.partial()`-tolerant only where a field is genuinely
 * optional. Defaults are applied here so consumers never branch on undefined.
 */
export const eventPayloadSchemas = {
  agent_text: agentText,
  thinking,
  tool_call: toolCall,
  tool_result: toolResult,
  file_diff: fileDiff,
  command_output: commandOutput,
  browser_action: browserAction,
  status,
  approval_requested: approvalRequested,
  error: errorPayload,
  result,
} as const satisfies Record<EventKind, z.ZodTypeAny>;

export type EventPayload<K extends EventKind> = z.infer<(typeof eventPayloadSchemas)[K]>;

export type TaskEvent<K extends EventKind = EventKind> = {
  [Kind in K]: {
    id: number;
    task_id: string;
    user_id: string;
    seq: number;
    created_at: string;
    kind: Kind;
    payload: EventPayload<Kind>;
  };
}[K];

const envelope = z.object({
  id: z.number().int(),
  task_id: z.string().uuid(),
  user_id: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  created_at: z.string(),
  kind: z.enum(EVENT_KINDS),
  payload: z.unknown(),
});

export function parseEvent(row: unknown): TaskEvent {
  const shell = envelope.parse(row);
  const payload = eventPayloadSchemas[shell.kind].parse(shell.payload);
  return { ...shell, payload } as TaskEvent;
}

export function safeParseEvent(
  row: unknown,
): { ok: true; event: TaskEvent } | { ok: false; error: string } {
  try {
    return { ok: true, event: parseEvent(row) };
  } catch (cause) {
    const message =
      cause instanceof z.ZodError
        ? cause.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : String(cause);
    return { ok: false, error: message };
  }
}
```

Note on the last test case: kinds whose schema has required fields will fail
validation against `payload: {}`, but `safeParseEvent` returns rather than
throws, which is what that case asserts. Do not weaken the schemas to satisfy it.

- [ ] **Step 5: Export it**

Add to `packages/shared/src/index.ts`:

```ts
export * from './event.js';
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npm run test -- packages/shared`
Expected: PASS, 8 tests in `event.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared package-lock.json
git commit -m "feat(shared): add validated event contract

Events cross three process boundaries, so each kind carries a Zod schema
and is validated at runtime rather than trusted because it typechecked
somewhere else.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Approval types and expiry

**Files:**
- Create: `packages/shared/src/approval.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/approval.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type ApprovalDecision`, `type RiskLevel`, `type ActionKind`
  - `interface Approval`
  - `const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000`
  - `function isPending(a: Approval, now?: Date): boolean`
  - `function hasExpired(a: Approval, now?: Date): boolean`
  - `function resolveDecision(a: Approval, now?: Date): ApprovalDecision`

`resolveDecision` is where the spec's "deny on timeout" rule lives. It is
written once here so the hook, the daemon and the phone cannot disagree.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/approval.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { type Approval, hasExpired, isPending, resolveDecision } from './approval.js';

const at = (iso: string) => new Date(iso);

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    task_id: '11111111-1111-4111-8111-111111111111',
    user_id: '22222222-2222-4222-8222-222222222222',
    action_kind: 'publish',
    summary: 'Click Publish on wp-admin post 412',
    risk: 'high',
    tool_payload: {},
    frame_path: null,
    decision: 'pending',
    decided_at: null,
    expires_at: '2026-09-16T10:10:00.000Z',
    created_at: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('isPending', () => {
  it('is true before the deadline', () => {
    expect(isPending(approval(), at('2026-09-16T10:05:00.000Z'))).toBe(true);
  });

  it('is false once the deadline passes', () => {
    expect(isPending(approval(), at('2026-09-16T10:11:00.000Z'))).toBe(false);
  });

  it('is false once a decision was recorded', () => {
    const decided = approval({ decision: 'approved', decided_at: '2026-09-16T10:02:00.000Z' });
    expect(isPending(decided, at('2026-09-16T10:03:00.000Z'))).toBe(false);
  });
});

describe('hasExpired', () => {
  it('does not expire an already-decided approval', () => {
    const decided = approval({ decision: 'approved', decided_at: '2026-09-16T10:02:00.000Z' });
    expect(hasExpired(decided, at('2026-09-16T11:00:00.000Z'))).toBe(false);
  });

  it('expires a pending approval past its deadline', () => {
    expect(hasExpired(approval(), at('2026-09-16T10:10:01.000Z'))).toBe(true);
  });
});

describe('resolveDecision', () => {
  it('returns the recorded decision when one exists', () => {
    const a = approval({ decision: 'approved', decided_at: '2026-09-16T10:02:00.000Z' });
    expect(resolveDecision(a, at('2026-09-16T11:00:00.000Z'))).toBe('approved');
  });

  it('denies by expiring when nobody answered in time', () => {
    expect(resolveDecision(approval(), at('2026-09-16T10:30:00.000Z'))).toBe('expired');
  });

  it('stays pending inside the window', () => {
    expect(resolveDecision(approval(), at('2026-09-16T10:01:00.000Z'))).toBe('pending');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test -- packages/shared/src/approval.test.ts`
Expected: FAIL — cannot resolve `./approval.js`.

- [ ] **Step 3: Write `packages/shared/src/approval.ts`**

```ts
export const APPROVAL_DECISIONS = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const ACTION_KINDS = [
  'publish', 'send', 'pay', 'delete', 'push', 'shell', 'other',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** How long the hook waits for a human before denying. Ten minutes. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

export interface Approval {
  id: string;
  task_id: string;
  user_id: string;
  action_kind: ActionKind;
  summary: string;
  risk: RiskLevel;
  tool_payload: unknown;
  frame_path: string | null;
  decision: ApprovalDecision;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
}

function past(deadline: string, now: Date): boolean {
  return now.getTime() > Date.parse(deadline);
}

export function isPending(approval: Approval, now: Date = new Date()): boolean {
  return approval.decision === 'pending' && !past(approval.expires_at, now);
}

export function hasExpired(approval: Approval, now: Date = new Date()): boolean {
  return approval.decision === 'pending' && past(approval.expires_at, now);
}

/**
 * The single place the "deny on timeout" rule is expressed. Silence is not
 * consent: the user is deliberately away, so an unanswered request expires
 * rather than proceeding.
 */
export function resolveDecision(approval: Approval, now: Date = new Date()): ApprovalDecision {
  if (approval.decision !== 'pending') return approval.decision;
  return past(approval.expires_at, now) ? 'expired' : 'pending';
}
```

- [ ] **Step 4: Export it**

Add to `packages/shared/src/index.ts`:

```ts
export * from './approval.js';
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm run test -- packages/shared`
Expected: PASS, 8 tests in `approval.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add approval types and deny-on-timeout rule

resolveDecision is the one place silence is interpreted. An unanswered
request expires rather than proceeding, because being away is the whole
premise of the product.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Supabase project and the machines table

**Files:**
- Create: `supabase/config.toml` (generated), `supabase/migrations/<ts>_create_machines.sql`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a local Supabase stack and a `public.machines` table with RLS enabled and four owner-scoped policies.

- [ ] **Step 1: Start Docker Desktop**

Docker is installed but the daemon is not running. Start it and wait for
`docker info` to exit 0 before continuing.

- [ ] **Step 2: Initialise Supabase**

Run: `npx --yes supabase@latest init`
Expected: creates `supabase/config.toml`.

- [ ] **Step 3: Start the local stack**

Run: `npm run db:start`
Expected: prints `API URL`, `anon key` and `service_role key`. Copy them into a
local `.env` — which is git-ignored — not into `.env.example`.

- [ ] **Step 4: Create the migration**

Run: `npx --yes supabase@latest migration new create_machines`

Then write into the generated file:

```sql
create table public.machines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  hostname text not null,
  agy_version text,
  daemon_version text,
  status text not null default 'offline' check (status in ('online', 'offline')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create index machines_user_id_idx on public.machines (user_id);

alter table public.machines enable row level security;

create policy "machines are visible to their owner"
  on public.machines for select using (auth.uid() = user_id);

create policy "machines are created by their owner"
  on public.machines for insert with check (auth.uid() = user_id);

create policy "machines are updated by their owner"
  on public.machines for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "machines are deleted by their owner"
  on public.machines for delete using (auth.uid() = user_id);
```

- [ ] **Step 5: Apply and verify**

Run: `npm run db:reset`
Expected: migration applies without error.

Verify RLS is actually on:

```bash
npx --yes supabase@latest db reset && \
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select relname, relrowsecurity from pg_class where relname = 'machines';"
```
Expected: `machines | t`.

- [ ] **Step 6: Commit**

```bash
git add supabase/
git commit -m "feat(db): add machines table with owner-scoped RLS

RLS is enabled in the same migration that creates the table so no
revision of this repo ever contains an open table for someone to fork.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Tasks and events tables

**Files:**
- Create: `supabase/migrations/<ts>_create_tasks.sql`, `supabase/migrations/<ts>_create_events.sql`

**Interfaces:**
- Consumes: `public.machines` from Task 5.
- Produces: `public.tasks` and `public.events`, both RLS-enabled, with `events` unique on `(task_id, seq)`.

- [ ] **Step 1: Create the tasks migration**

Run: `npx --yes supabase@latest migration new create_tasks`

```sql
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  machine_id uuid not null references public.machines (id) on delete cascade,
  prompt text not null check (length(prompt) between 1 and 20000),
  kind text not null default 'auto'
    check (kind in ('browser', 'coding', 'mixed', 'auto')),
  workspace_path text,
  model text,
  effort text check (effort is null or effort in ('low', 'medium', 'high')),
  mode text not null default 'default'
    check (mode in ('default', 'accept-edits', 'plan')),
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'running', 'awaiting_approval',
                      'done', 'failed', 'cancelled')),
  conversation_id text,
  parent_task_id uuid references public.tasks (id) on delete set null,
  result_summary text,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index tasks_machine_queued_idx
  on public.tasks (machine_id, created_at)
  where status = 'queued';

create index tasks_user_created_idx on public.tasks (user_id, created_at desc);

alter table public.tasks enable row level security;

create policy "tasks are visible to their owner"
  on public.tasks for select using (auth.uid() = user_id);

create policy "tasks are created by their owner"
  on public.tasks for insert with check (auth.uid() = user_id);

create policy "tasks are updated by their owner"
  on public.tasks for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "tasks are deleted by their owner"
  on public.tasks for delete using (auth.uid() = user_id);
```

The partial index on queued rows is what makes the daemon's claim query cheap
as history grows.

- [ ] **Step 2: Create the events migration**

Run: `npx --yes supabase@latest migration new create_events`

```sql
create table public.events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seq integer not null check (seq >= 0),
  kind text not null check (kind in (
    'agent_text', 'thinking', 'tool_call', 'tool_result', 'file_diff',
    'command_output', 'browser_action', 'status', 'approval_requested',
    'error', 'result')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (task_id, seq)
);

create index events_task_seq_idx on public.events (task_id, seq);

alter table public.events enable row level security;

create policy "events are visible to their owner"
  on public.events for select using (auth.uid() = user_id);

create policy "events are created by their owner"
  on public.events for insert with check (auth.uid() = user_id);

create policy "events are deleted by their owner"
  on public.events for delete using (auth.uid() = user_id);
```

There is deliberately no update policy. Events are an append-only log; a row
that can be rewritten is not evidence of what happened.

- [ ] **Step 3: Apply and verify**

Run: `npm run db:reset`
Expected: both migrations apply cleanly.

- [ ] **Step 4: Verify the uniqueness constraint holds**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select conname from pg_constraint where conrelid = 'public.events'::regclass and contype = 'u';"
```
Expected: one row naming a unique constraint on `events`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations
git commit -m "feat(db): add tasks and events tables

Events are append-only by policy: there is no update policy, because a
log a client can rewrite is not evidence of what the agent did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Approvals table and realtime publication

**Files:**
- Create: `supabase/migrations/<ts>_create_approvals.sql`, `supabase/migrations/<ts>_enable_realtime.sql`

**Interfaces:**
- Consumes: `public.tasks` from Task 6.
- Produces: `public.approvals` with RLS, and `tasks`, `events`, `approvals` added to the `supabase_realtime` publication so the daemon and phone can subscribe.

- [ ] **Step 1: Create the approvals migration**

Run: `npx --yes supabase@latest migration new create_approvals`

```sql
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action_kind text not null check (action_kind in (
    'publish', 'send', 'pay', 'delete', 'push', 'shell', 'other')),
  summary text not null,
  risk text not null check (risk in ('low', 'medium', 'high')),
  tool_payload jsonb not null default '{}'::jsonb,
  frame_path text,
  decision text not null default 'pending'
    check (decision in ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint decided_rows_have_a_timestamp
    check ((decision = 'pending') = (decided_at is null))
);

create index approvals_task_idx on public.approvals (task_id, created_at desc);
create index approvals_pending_idx on public.approvals (user_id)
  where decision = 'pending';

alter table public.approvals enable row level security;

create policy "approvals are visible to their owner"
  on public.approvals for select using (auth.uid() = user_id);

create policy "approvals are created by their owner"
  on public.approvals for insert with check (auth.uid() = user_id);

create policy "approvals are decided by their owner"
  on public.approvals for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

The `decided_rows_have_a_timestamp` constraint makes the "deny on timeout" rule
impossible to violate by accident: no row can claim a decision without recording
when it was made.

- [ ] **Step 2: Create the realtime migration**

Run: `npx --yes supabase@latest migration new enable_realtime`

```sql
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.approvals;
```

- [ ] **Step 3: Apply and verify**

Run: `npm run db:reset`

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;"
```
Expected: `approvals`, `events`, `tasks`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations
git commit -m "feat(db): add approvals table and enable realtime

A check constraint ties decision to decided_at, so no row can record a
decision without recording when it was taken.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Prove row-level security with two users

**Files:**
- Create: `supabase/package.json`, `supabase/tsconfig.json`, `supabase/tests/helpers.ts`, `supabase/tests/rls.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every table from Tasks 5–7.
- Produces:
  - `createServiceClient(): SupabaseClient`
  - `createUser(email: string): Promise<{ id: string; client: SupabaseClient }>`

This is the task that turns "we wrote RLS policies" into "a second user
provably sees nothing." Without it, every policy above is an assertion.

- [ ] **Step 1: Create the test workspace package**

`supabase/package.json`:

```json
{
  "name": "@remote-hands/db-tests",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "dependencies": { "@supabase/supabase-js": "^2.45.0" }
}
```

`supabase/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "composite": false },
  "include": ["tests/**/*"]
}
```

Run: `npm install`

- [ ] **Step 2: Write the helpers**

`supabase/tests/helpers.ts`:

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!anonKey || !serviceKey) {
  throw new Error(
    'Set SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. Run `npm run db:start` and copy them into .env.',
  );
}

/** Service role is permitted here and nowhere else in the repository. */
export function createServiceClient(): SupabaseClient {
  return createClient(url, serviceKey!, { auth: { persistSession: false } });
}

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
}

export async function createUser(): Promise<TestUser> {
  const admin = createServiceClient();
  const email = `rls-${randomUUID()}@example.test`;
  const password = randomUUID();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user was not created');

  const client = createClient(url, anonKey!, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  return { id: data.user.id, email, client };
}
```

- [ ] **Step 3: Write the failing test**

`supabase/tests/rls.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, type TestUser } from './helpers.js';

let alice: TestUser;
let mallory: TestUser;
let aliceMachineId: string;
let aliceTaskId: string;

beforeAll(async () => {
  alice = await createUser();
  mallory = await createUser();

  const { data: machine, error: mErr } = await alice.client
    .from('machines')
    .insert({ user_id: alice.id, name: 'alice-air', hostname: 'alice-air.local' })
    .select()
    .single();
  if (mErr) throw mErr;
  aliceMachineId = machine.id;

  const { data: task, error: tErr } = await alice.client
    .from('tasks')
    .insert({ user_id: alice.id, machine_id: aliceMachineId, prompt: 'add a privacy policy page' })
    .select()
    .single();
  if (tErr) throw tErr;
  aliceTaskId = task.id;

  const { error: eErr } = await alice.client.from('events').insert({
    task_id: aliceTaskId,
    user_id: alice.id,
    seq: 0,
    kind: 'agent_text',
    payload: { text: 'starting' },
  });
  if (eErr) throw eErr;
}, 60_000);

describe('the owner', () => {
  it('sees their own machine, task and event', async () => {
    const machines = await alice.client.from('machines').select();
    const tasks = await alice.client.from('tasks').select();
    const events = await alice.client.from('events').select();
    expect(machines.data).toHaveLength(1);
    expect(tasks.data).toHaveLength(1);
    expect(events.data).toHaveLength(1);
  });
});

describe('a second user', () => {
  it('sees no machines', async () => {
    const { data } = await mallory.client.from('machines').select();
    expect(data).toEqual([]);
  });

  it('sees no tasks', async () => {
    const { data } = await mallory.client.from('tasks').select();
    expect(data).toEqual([]);
  });

  it('sees no events', async () => {
    const { data } = await mallory.client.from('events').select();
    expect(data).toEqual([]);
  });

  it('cannot read a task by its id', async () => {
    const { data } = await mallory.client.from('tasks').select().eq('id', aliceTaskId);
    expect(data).toEqual([]);
  });

  it('cannot queue a task onto someone else machine', async () => {
    const { error } = await mallory.client
      .from('tasks')
      .insert({ user_id: alice.id, machine_id: aliceMachineId, prompt: 'exfiltrate' });
    expect(error).not.toBeNull();
  });

  it('cannot forge a task owned by themselves on another machine', async () => {
    const { error } = await mallory.client
      .from('tasks')
      .insert({ user_id: mallory.id, machine_id: aliceMachineId, prompt: 'exfiltrate' });
    expect(error).not.toBeNull();
  });

  it('cannot cancel someone else task', async () => {
    const { data } = await mallory.client
      .from('tasks')
      .update({ status: 'cancelled' })
      .eq('id', aliceTaskId)
      .select();
    expect(data).toEqual([]);

    const { data: still } = await alice.client.from('tasks').select().eq('id', aliceTaskId).single();
    expect(still.status).toBe('queued');
  });
});

describe('the append-only event log', () => {
  it('refuses an update even from the owner', async () => {
    const { data } = await alice.client
      .from('events')
      .update({ payload: { text: 'rewritten' } })
      .eq('task_id', aliceTaskId)
      .select();
    expect(data).toEqual([]);
  });
});
```

The sixth case is the one worth understanding: `mallory` inserting a row with her
own `user_id` passes the `tasks` insert policy, so the protection has to come
from the `machines` foreign key being unreadable to her. If that case fails,
Task 9 adds the missing constraint rather than weakening the test.

- [ ] **Step 4: Run the test and verify it fails**

Run: `npm run db:start` then `npm run test -- supabase`
Expected: FAIL. Some cases pass; at least the cross-machine insert case is
expected to fail at this point, which is the point of writing it now.

- [ ] **Step 5: Add the missing protection**

Run: `npx --yes supabase@latest migration new restrict_task_machine_ownership`

```sql
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
```

`security invoker` matters: the function must run with the caller's rights so
that RLS on `machines` still applies inside it. A `security definer` function
here would quietly reopen the hole this task exists to close.

- [ ] **Step 6: Re-run and verify all cases pass**

Run: `npm run db:reset && npm run test -- supabase`
Expected: PASS, 9 tests.

- [ ] **Step 7: Wire it into CI**

Add to `.github/workflows/ci.yml` as a third job:

```yaml
  db:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - run: supabase start
      - name: Export local keys
        run: |
          echo "SUPABASE_URL=$(supabase status -o json | jq -r .API_URL)" >> $GITHUB_ENV
          echo "SUPABASE_ANON_KEY=$(supabase status -o json | jq -r .ANON_KEY)" >> $GITHUB_ENV
          echo "SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
      - run: npm ci
      - run: npm run test -- supabase
```

- [ ] **Step 8: Commit**

```bash
git add supabase .github/workflows/ci.yml package-lock.json
git commit -m "test(db): prove row-level security with two real users

Adds a security-invoker check so a task cannot be queued onto a machine
the caller cannot see, which the cross-machine insert case caught.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Generated database types, checked against the hand-written ones

**Files:**
- Create: `packages/shared/src/database.generated.ts`, `packages/shared/src/schema-parity.test.ts`
- Modify: `package.json` (add `db:types` script), `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: the schema from Tasks 5–7 and the interfaces from Tasks 2–4.
- Produces: `type Database` and a test that fails when the SQL schema and the
  hand-written interfaces drift apart.

Two sources of truth for the same shape is a bug waiting to happen. Rather than
delete one, this task makes drift a test failure.

- [ ] **Step 1: Add the generation script**

In the root `package.json` scripts:

```json
"db:types": "npx --yes supabase@latest gen types typescript --local > packages/shared/src/database.generated.ts"
```

- [ ] **Step 2: Generate**

Run: `npm run db:types`
Expected: a file exporting `Database` with `public.Tables.machines`, `tasks`, `events`, `approvals`.

- [ ] **Step 3: Write the parity test**

`packages/shared/src/schema-parity.test.ts`:

```ts
import { describe, expectTypeOf, it } from 'vitest';
import type { Database } from './database.generated.js';
import type { Machine } from './machine.js';
import type { Task } from './task.js';
import type { Approval } from './approval.js';

type Row<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

describe('hand-written types match the generated schema', () => {
  it('machines', () => {
    expectTypeOf<Row<'machines'>>().toMatchTypeOf<Omit<Machine, 'status'>>();
  });

  it('tasks', () => {
    expectTypeOf<Row<'tasks'>>().toMatchTypeOf<Omit<Task, 'kind' | 'mode' | 'status'>>();
  });

  it('approvals', () => {
    expectTypeOf<Row<'approvals'>>().toMatchTypeOf<
      Omit<Approval, 'action_kind' | 'risk' | 'decision' | 'tool_payload'>
    >();
  });
});
```

Columns constrained by a SQL `check` come back as plain `string` from the
generator, so they are excluded here and remain narrowed by the hand-written
unions — which is the stricter of the two. Every other column must match
exactly, and adding a column to SQL without adding it here fails this test.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run test -- packages/shared`
Expected: PASS. If it fails, the mismatch it reports is real — fix the
hand-written interface, do not widen the assertion.

- [ ] **Step 5: Export the generated types**

Add to `packages/shared/src/index.ts`:

```ts
export type { Database } from './database.generated.js';
```

- [ ] **Step 6: Typecheck and run everything**

Run: `npm run typecheck && npm run test`
Expected: exit 0, all suites green.

- [ ] **Step 7: Commit**

```bash
git add packages/shared package.json
git commit -m "feat(shared): generate database types and test schema parity

Two sources of truth for one shape is a bug waiting to happen, so drift
between the SQL schema and the hand-written interfaces now fails a test
rather than surfacing at runtime.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Document the control plane

**Files:**
- Create: `docs/architecture/control-plane.md`, `docs/development.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the documents a contributor needs before Plan 2.

- [ ] **Step 1: Write `docs/development.md`**

Cover exactly: prerequisites (Node 22, Docker, `gh`), `npm install`,
`npm run db:start`, copying the printed keys into `.env`, `npm run db:reset`,
`npm run test`, `npm run typecheck`, and what to do when Docker is not running.

- [ ] **Step 2: Write `docs/architecture/control-plane.md`**

One table per table: columns, why each exists, which process writes it, which
reads it. State the two invariants explicitly — events are append-only, and a
task cannot be queued onto a machine the caller cannot see — and name the test
that proves each.

- [ ] **Step 3: Update `README.md`**

Replace the Status section with a short "what works today" list and a link to
`docs/development.md`. Keep the security notice first.

- [ ] **Step 4: Verify the instructions from scratch**

Run, in order, exactly what `docs/development.md` says, starting from
`npm run db:stop` and a deleted `node_modules`. Any step that does not work as
written is a documentation bug — fix the document, not your shell history.

- [ ] **Step 5: Commit and push**

```bash
git add docs README.md
git commit -m "docs: describe the control plane and local development

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

## What this plan deliberately does not build

Kept out so each plan produces something that works on its own:

| Subsystem | Plan |
|---|---|
| Daemon, pairing, keychain, `agy` runner | Plan 2 |
| Phone PWA, auth, timeline, diff renderer | Plan 3 |
| browser-harness integration, CDP screencast, frame relay | Plan 4 |
| PreToolUse hook, risk rules, approval UI | Plan 5 |
| Retention jobs, storage caps, WordPress acceptance test | Plan 6 |

At the end of this plan there is no running agent. There is a schema that
provably isolates users, a validated event contract, and a repository a
contributor can clone and test in three commands.
