# D1 Heartbeat Throttling & Fast Agent Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate runaway Cloudflare D1 writes caused by unthrottled 1-second machine heartbeat updates and reduce AI agent task latency from 30-60s to 1-3s by switching reasoning effort from high to low.

**Architecture:** On the Cloudflare Worker backend, throttle `handleMachineHeartbeat` to skip the D1 `UPDATE machines` write if `last_seen_at` was updated within the last 60 seconds and the machine is already online. In the daemon CLI, throttle heartbeat dispatch to 60-second intervals while keeping task polling at 1 second, and cache machine identity across poll loops. In the agent runner and web frontend, switch default reasoning effort from `high` to `low` to eliminate 30-60 second thinking pauses on simple prompts.

**Tech Stack:** Cloudflare Workers, Cloudflare D1 (SQLite), TypeScript, Node.js, Vitest, React, Vite.

**Spec:** `docs/superpowers/specs/2026-09-16-daemon-foundation-design.md` and `docs/superpowers/plans/2026-09-16-free-cloudflare-end-to-end.md`.

## Global Constraints

- Clean code: NO code comments (no `//` and no `/* */`).
- All existing features, tests, and API contracts must continue working.
- No walkthrough artifacts.
- Target zero regression on all 298 existing workspace tests.

---

### Task 1: Backend D1 Heartbeat Write Throttling in Cloudflare Worker

**Files:**
- Modify: `apps/cloudflare/src/routes/machines.ts`
- Test: `apps/cloudflare/src/routes/machines.test.ts`

**Interfaces:**
- Consumes: `MachinesRepository.getById(id: string)`, `MachinesRepository.updateHeartbeat(id: string, lastSeenAt: string)`
- Produces: `handleMachineHeartbeat(machineId: string, request: Request, env: Env): Promise<Response>`

- [ ] **Step 1: Write the failing test for heartbeat throttling**

Create or update `apps/cloudflare/src/routes/machines.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleMachineHeartbeat } from './machines.js';
import type { Env } from '../env.js';

describe('handleMachineHeartbeat throttling', () => {
  it('skips D1 update when machine is already online and last_seen_at is less than 60s old', async () => {
    const recentIso = new Date(Date.now() - 15000).toISOString();
    const fakeMachine = {
      id: '11111111-1111-4111-8111-111111111111',
      owner_id: '22222222-2222-4222-8222-222222222222',
      name: 'MacBook',
      hostname: 'macbook.local',
      daemon_version: '0.1.0',
      agy_version: '0.2.0',
      status: 'online',
      last_seen_at: recentIso,
      created_at: recentIso,
    };

    const updateSpy = vi.fn().mockResolvedValue(undefined);
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(fakeMachine),
          run: updateSpy,
        }),
      }),
    };

    const fakeSession = {
      id: 'sess-1',
      owner_id: fakeMachine.owner_id,
      kind: 'daemon',
      machine_id: fakeMachine.id,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      created_at: recentIso,
    };

    const req = new Request('https://api/machines/11111111-1111-4111-8111-111111111111/heartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    const env: Env = {
      DB: mockDb as any,
      TASK_ROOM: {} as any,
      CONTROL_PLANE_SECRET: 'test',
    };

    vi.spyOn(await import('../auth/session.js'), 'requireSession').mockResolvedValue(fakeSession as any);

    const res = await handleMachineHeartbeat(fakeMachine.id, req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.machine.id).toBe(fakeMachine.id);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cloudflare/src/routes/machines.test.ts`
Expected: FAIL because `updateHeartbeat` is currently called unconditionally on every request.

- [ ] **Step 3: Write minimal implementation in machines.ts**

Update `apps/cloudflare/src/routes/machines.ts`:

```ts
import { requireOwnerSession, requireSession } from '../auth/session.js';
import { MachinesRepository } from '../d1/machines-repository.js';
import { ForbiddenError, NotFoundError } from '../http/errors.js';
import { jsonOk } from '../http/json.js';
import type { Env } from '../env.js';

export async function handleListMachines(request: Request, env: Env): Promise<Response> {
  const session = await requireOwnerSession(request, env.DB);
  const repo = new MachinesRepository(env.DB);
  const machines = await repo.listByOwner(session.owner_id);
  return jsonOk({ machines });
}

export async function handleGetMachine(machineId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const repo = new MachinesRepository(env.DB);
  const machine = await repo.getById(machineId);
  if (!machine || machine.owner_id !== session.owner_id) {
    throw new NotFoundError('Machine not found');
  }
  return jsonOk({ machine });
}

export async function handleMachineHeartbeat(machineId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  if (session.kind === 'daemon' && session.machine_id !== machineId) {
    throw new ForbiddenError('Machine session mismatch');
  }

  const repo = new MachinesRepository(env.DB);
  const machine = await repo.getById(machineId);
  if (!machine || machine.owner_id !== session.owner_id) {
    throw new NotFoundError('Machine not found');
  }

  const lastSeenMs = machine.last_seen_at ? Date.parse(machine.last_seen_at) : 0;
  const now = Date.now();
  if (machine.status === 'online' && now - lastSeenMs < 60_000) {
    return jsonOk({ machine });
  }

  await repo.updateHeartbeat(machineId, new Date(now).toISOString());
  const updated = await repo.getById(machineId);
  return jsonOk({ machine: updated });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/cloudflare/src/routes/machines.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cloudflare/src/routes/machines.ts apps/cloudflare/src/routes/machines.test.ts
git commit -m "fix(cloudflare): throttle d1 heartbeat updates to 60s intervals"
```

---

### Task 2: Daemon Heartbeat Interval Throttling & Machine Caching

**Files:**
- Modify: `packages/daemon/src/config.ts`
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/daemon/src/cloudflare-task-store.ts`
- Modify: `packages/cli/src/commands/daemon.ts`
- Test: `packages/daemon/src/daemon.test.ts`
- Test: `packages/daemon/src/cloudflare-task-store.test.ts`

**Interfaces:**
- Consumes: `RunDaemonOnceInput.lastHeartbeatAtRef?: { current: number }`
- Produces: `runDaemonOnce` only calls `store.heartbeat` if `now - lastHeartbeatAt >= config.heartbeatIntervalMs`

- [ ] **Step 1: Write the failing test in daemon.test.ts**

Add test to `packages/daemon/src/daemon.test.ts`:

```ts
  it('skips heartbeat when heartbeatIntervalMs has not elapsed', async () => {
    const lastHeartbeatAtRef = { current: Date.now() - 5000 };
    const heartbeatSpy = vi.fn().mockResolvedValue(fakeMachine);
    const mockStore = {
      ...store,
      getMachine: vi.fn().mockResolvedValue(fakeMachine),
      heartbeat: heartbeatSpy,
      claimNextTask: vi.fn().mockResolvedValue(null),
    };

    await runDaemonOnce({
      userId,
      config: { ...config, heartbeatIntervalMs: 60000 },
      runtime,
      store: mockStore,
      runner,
      lastHeartbeatAtRef,
    });

    expect(heartbeatSpy).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/daemon.test.ts -t "skips heartbeat when heartbeatIntervalMs has not elapsed"`
Expected: FAIL because `runDaemonOnce` currently heartbeats unconditionally.

- [ ] **Step 3: Implement heartbeat throttling in daemon.ts, config.ts, and cloudflare-task-store.ts**

In `packages/daemon/src/daemon.ts`:
Add `lastHeartbeatAtRef?: { current: number } | undefined;` to `RunDaemonOnceInput`.
Update `runDaemonOnce`:

```ts
export async function runDaemonOnce(input: RunDaemonOnceInput): Promise<RunDaemonOnceResult> {
  const machine = input.store.getMachine
    ? await input.store.getMachine()
    : await input.store.registerMachine({
        userId: input.userId,
        name: input.config.machineName,
        hostname: input.runtime.hostname,
        agyVersion: input.runtime.agyVersion,
        daemonVersion: input.runtime.daemonVersion,
      });

  const now = Date.now();
  const interval = input.config.heartbeatIntervalMs || 60000;
  if (!input.lastHeartbeatAtRef || now - input.lastHeartbeatAtRef.current >= interval) {
    await input.store.heartbeat(machine.id);
    if (input.lastHeartbeatAtRef) {
      input.lastHeartbeatAtRef.current = now;
    }
  }

  const claimed = await input.store.claimNextTask(machine.id);
  if (claimed === null) return { claimed: false };
```

In `packages/daemon/src/config.ts`:
Set default `heartbeatIntervalMs` to `60_000`.

In `packages/daemon/src/cloudflare-task-store.ts`:
Cache `cachedMachine` in `CloudflareTaskStore` so `registerMachine` and `getMachine` do not make redundant network calls when machine is already resolved.

In `packages/cli/src/commands/daemon.ts`:
Pass `lastHeartbeatAtRef = { current: 0 }` to `runDaemonOnce` inside the poll loop so the timestamp persists across iterations.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/src/daemon.test.ts`
Run: `npx vitest run packages/daemon/src/cloudflare-task-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/daemon.ts packages/daemon/src/config.ts packages/daemon/src/cloudflare-task-store.ts packages/cli/src/commands/daemon.ts packages/daemon/src/daemon.test.ts
git commit -m "perf(daemon): throttle heartbeat loop to 60s and cache machine identity"
```

---

### Task 3: Fast Agent Execution (`--effort low`)

**Files:**
- Modify: `packages/daemon/src/agy-runner.ts`
- Modify: `apps/web/src/screens/LiveTaskScreen.tsx`
- Test: `packages/daemon/src/agy-runner.test.ts`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `Task.effort?: string | null`
- Produces: `buildAgyArgs` uses `effort: 'low'` by default instead of `high`

- [ ] **Step 1: Write the failing test for default effort in agy-runner.test.ts**

In `packages/daemon/src/agy-runner.test.ts`:

```ts
  it('defaults effort to low instead of high to minimize startup latency', () => {
    const task: Task = {
      id: 'task-1',
      userId: 'u1',
      machineId: 'm1',
      prompt: 'Check git status',
      kind: 'coding',
      workspacePath: null,
      model: null,
      effort: null,
      mode: 'default',
      status: 'queued',
      conversationId: null,
      parentTaskId: null,
      resultSummary: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };

    const args = buildAgyArgs(task, { agyCommand: 'agy' });
    expect(args).toContain('--effort');
    const effortIndex = args.indexOf('--effort');
    expect(args[effortIndex + 1]).toBe('low');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts -t "defaults effort to low"`
Expected: FAIL because `buildAgyArgs` currently defaults effort to `'high'`.

- [ ] **Step 3: Implement effort low in agy-runner.ts and LiveTaskScreen.tsx**

In `packages/daemon/src/agy-runner.ts` lines 185-190:
Change:
```ts
  const model = task.model === null ? null : (task.model || 'gemini-3.8-flash-high');
  const effort = task.effort === null ? null : (task.effort || 'low');
```

In `apps/web/src/screens/LiveTaskScreen.tsx` line 780:
Change:
```ts
      const nextTask = await apiClient.createTask({
        machine_id: targetMachineId,
        prompt: text,
        kind: targetKind,
        mode: task?.mode ?? 'default',
        conversation_id: resolvedConversationId,
        workspace_path: task?.workspace_path ?? undefined,
        model: 'gemini-3.8-flash-high',
        effort: 'low',
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Run: `npx vitest run apps/web/src/App.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/agy-runner.ts apps/web/src/screens/LiveTaskScreen.tsx packages/daemon/src/agy-runner.test.ts
git commit -m "perf(agent): switch default reasoning effort to low for instant execution"
```

---

### Task 4: Full Workspace Verification & Deployment

**Files:**
- None (verification and deployment only)

- [ ] **Step 1: Run full test suite across workspace**

Run: `pnpm test`
Expected: 298+ passed tests, 0 failed.

- [ ] **Step 2: Build web frontend and cloudflare worker**

Run: `npx vite build` in `apps/web`
Run: `npm run build` in `apps/cloudflare` (if applicable)
Expected: Build succeeds with 0 errors.

- [ ] **Step 3: Deploy Cloudflare Worker and Web App**

Run: `npx wrangler deploy` in `apps/cloudflare`
Run: `npx wrangler deploy` in `apps/web`
Expected: Successful deployment of both workers.

- [ ] **Step 4: Commit and finalize**

```bash
git status
```
Verify clean git working directory.
