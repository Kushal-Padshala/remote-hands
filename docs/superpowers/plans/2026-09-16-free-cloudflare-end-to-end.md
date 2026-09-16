# Free Cloudflare End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `remote-hands` from a Supabase/Vercel-first project into a free-first self-hosted system using Cloudflare Workers, D1, Durable Objects, optional R2, a static phone PWA, and an outbound-only laptop daemon.

**Architecture:** `packages/shared` owns all cross-process schemas. `packages/control-plane` owns provider-neutral task, event, approval, pairing and authorization rules. `apps/cloudflare` is the default free backend: Worker routes, D1 migrations and Durable Objects. `apps/web` is the phone PWA. `packages/daemon` connects outbound to the Cloudflare backend. `packages/cli` automates setup, deploy, pairing, daemon startup, diagnostics and uninstall.

**Tech Stack:** Node 22, TypeScript strict mode, npm workspaces, Vitest, Zod, Cloudflare Workers, D1, Durable Objects, Wrangler, optional R2, Vite + React for the phone PWA.

**Spec:** `docs/superpowers/specs/2026-09-16-free-cloudflare-architecture-design.md`

## Global Constraints

- Node `>=22.0.0`.
- TypeScript `strict: true` everywhere.
- No `any` in committed code.
- Commit messages use Conventional Commits.
- Each meaningful phase is committed and pushed separately.
- Default setup must not require Supabase, Vercel, Docker, a public laptop IP, or a paid service.
- Supabase remains optional and must not be required by the default path.
- Live frames are ephemeral by default and are not written to storage unless artifact history is explicitly enabled.
- The daemon must never use `--dangerously-skip-permissions`.
- Pairing tokens are single-use, short-lived, and stored hashed.
- Approval requests deny on timeout.
- Worker routes and WebSocket upgrades validate session scope before touching D1 or Durable Objects.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/realtime.ts` | WebSocket message schemas and parser. |
| `packages/shared/src/api.ts` | HTTP request/response schemas for setup, pairing, tasks, approvals and history. |
| `packages/shared/src/cloudflare-schema.ts` | D1 row types and row-to-domain mappers. |
| `packages/control-plane/` | Provider-neutral business rules and authorization checks. |
| `packages/control-plane/src/task-service.ts` | Task creation, claiming and status transitions. |
| `packages/control-plane/src/event-service.ts` | Event append rules and sequence assignment. |
| `packages/control-plane/src/approval-service.ts` | Approval creation, decision and expiry rules. |
| `packages/control-plane/src/pairing-service.ts` | Pairing code hashing, expiry and single-use rules. |
| `apps/cloudflare/` | Default free backend deployment target. |
| `apps/cloudflare/src/worker.ts` | Worker fetch entrypoint and route dispatcher. |
| `apps/cloudflare/src/routes/*.ts` | HTTP route handlers. |
| `apps/cloudflare/src/durable-objects/task-room.ts` | Live task room WebSocket relay. |
| `apps/cloudflare/src/d1/*.ts` | D1 repositories and migrations adapter. |
| `apps/cloudflare/migrations/*.sql` | D1 schema migrations. |
| `apps/cloudflare/wrangler.jsonc` | Generated/default Cloudflare config template. |
| `apps/web/` | Phone-first PWA. |
| `packages/daemon/src/cloudflare-client.ts` | Cloudflare control-plane client and outbound WebSocket transport. |
| `packages/daemon/src/frame-stream.ts` | Browser frame capture and throttling boundary. |
| `packages/daemon/src/approval-gate.ts` | Hook-facing approval request client. |
| `packages/cli/` | `remote-hands` setup, deploy, daemon, doctor and pairing commands. |
| `docs/cloudflare-free-setup.md` | User setup guide for the free default path. |
| `docs/architecture/free-cloudflare-control-plane.md` | Contributor architecture reference. |

---

## Phase 0: Planning and Public Roadmap Reset

**Outcome:** The repo documents Cloudflare Free as the default direction without deleting the existing Supabase foundation.

### Task 0.1: Commit this architecture and plan

**Files:**
- Create: `docs/superpowers/specs/2026-09-16-free-cloudflare-architecture-design.md`
- Create: `docs/superpowers/plans/2026-09-16-free-cloudflare-end-to-end.md`

**Interfaces:**
- Consumes: existing README roadmap, daemon foundation, and Supabase control-plane docs.
- Produces: a reviewed, detailed end-to-end roadmap.

- [ ] **Step 1: Verify the planning docs have no placeholders**

Run:

```bash
rg -n "TBD|TODO|implement later|fill in details" docs/superpowers/specs/2026-09-16-free-cloudflare-architecture-design.md docs/superpowers/plans/2026-09-16-free-cloudflare-end-to-end.md
```

Expected: no matches.

- [ ] **Step 2: Commit and push**

```bash
git add docs/superpowers/specs/2026-09-16-free-cloudflare-architecture-design.md docs/superpowers/plans/2026-09-16-free-cloudflare-end-to-end.md
git commit -m "docs: plan free cloudflare architecture"
git push origin main
```

### Task 0.2: Update public roadmap

**Files:**
- Modify: `README.md`
- Create: `docs/architecture/free-cloudflare-control-plane.md`
- Modify: `docs/architecture/control-plane.md`
- Modify: `docs/development.md`

**Interfaces:**
- Consumes: this plan and spec.
- Produces: public docs that name Cloudflare Free as the default backend and Supabase as optional.

- [ ] **Step 1: Write README roadmap changes**

Replace the current Phase 2/3/4 roadmap with:

```markdown
- [ ] Phase 2: Free Cloudflare control plane
- [ ] Phase 3: Outbound daemon transport and live task rooms
- [ ] Phase 4: Phone PWA and approval workflow
- [ ] Phase 5: One-command setup CLI
- [ ] Phase 6: End-to-end browser task acceptance test
```

- [ ] **Step 2: Document the architecture**

Create `docs/architecture/free-cloudflare-control-plane.md` with the diagram,
data model, setup story, free-tier limits and security notes from the spec.

- [ ] **Step 3: Reframe Supabase docs**

At the top of `docs/architecture/control-plane.md`, add:

```markdown
This Supabase control plane is retained as an optional adapter and as historical
foundation work. The default free self-hosted path is the Cloudflare control
plane described in `docs/architecture/free-cloudflare-control-plane.md`.
```

- [ ] **Step 4: Verify docs**

Run:

```bash
rg -n "Supabase.*default|Vercel.*default|Docker.*required" README.md docs
```

Expected: no wording that presents Supabase, Vercel or Docker as required for
the default path.

- [ ] **Step 5: Commit and push**

```bash
git add README.md docs/architecture/free-cloudflare-control-plane.md docs/architecture/control-plane.md docs/development.md
git commit -m "docs: make cloudflare free the default roadmap"
git push origin main
```

---

## Phase 1: Shared Transport and API Contracts

**Outcome:** Every process speaks the same typed HTTP and WebSocket protocol.

### Task 1.1: Add realtime message schemas

**Files:**
- Create: `packages/shared/src/realtime.ts`
- Test: `packages/shared/src/realtime.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `EventInput` shape from daemon should move or be mirrored in `shared`.
- Produces:
  - `REALTIME_PROTOCOL_VERSION = 1`
  - `realtimeMessageSchema`
  - `type RealtimeMessage`
  - `function parseRealtimeMessage(input: unknown): RealtimeMessage`
  - `function safeParseRealtimeMessage(input: unknown): { ok: true; message: RealtimeMessage } | { ok: false; error: string }`

- [ ] **Step 1: Write failing tests**

`realtime.test.ts` should assert:

```ts
expect(parseRealtimeMessage({
  type: 'hello',
  role: 'daemon',
  protocol_version: 1,
})).toEqual({
  type: 'hello',
  role: 'daemon',
  protocol_version: 1,
});

expect(safeParseRealtimeMessage({ type: 'task.frame', task_id: 'bad' }).ok).toBe(false);
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm test -- packages/shared/src/realtime.test.ts
```

Expected: fail because `realtime.ts` does not exist.

- [ ] **Step 3: Implement schemas**

Use Zod discriminated unions for:

```ts
'hello' | 'task.event' | 'task.frame' | 'approval.requested' |
'approval.decided' | 'heartbeat' | 'error'
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- packages/shared
npm run typecheck
```

Commit:

```bash
git add packages/shared/src/realtime.ts packages/shared/src/realtime.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add realtime transport contract"
git push origin main
```

### Task 1.2: Add API request and response schemas

**Files:**
- Create: `packages/shared/src/api.ts`
- Test: `packages/shared/src/api.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces schemas for:
  - `POST /setup/owner`
  - `POST /pairing/start`
  - `POST /pairing/claim`
  - `GET /machines`
  - `POST /tasks`
  - `GET /tasks/:id`
  - `GET /tasks/:id/events`
  - `POST /approvals/:id/decision`
  - `POST /sessions/phone`
  - `POST /sessions/daemon`

- [ ] **Step 1: Write failing tests**

Assert task creation validation:

```ts
expect(createTaskRequestSchema.parse({
  machine_id: '22222222-2222-4222-8222-222222222222',
  prompt: 'Add privacy policy',
  kind: 'browser',
})).toMatchObject({ kind: 'browser' });

expect(() => createTaskRequestSchema.parse({ prompt: '' })).toThrow();
```

- [ ] **Step 2: Implement schemas**

Use the exact task kinds, task modes, approval decisions and risk levels from
the existing shared package.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm test -- packages/shared
npm run typecheck
```

Commit:

```bash
git add packages/shared/src/api.ts packages/shared/src/api.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add control plane api contract"
git push origin main
```

---

## Phase 2: Provider-Neutral Control Plane Core

**Outcome:** Business rules are testable without Cloudflare runtime APIs.

### Task 2.1: Scaffold `packages/control-plane`

**Files:**
- Create: `packages/control-plane/package.json`
- Create: `packages/control-plane/tsconfig.json`
- Create: `packages/control-plane/tsconfig.test.json`
- Create: `packages/control-plane/src/index.ts`
- Modify: `tsconfig.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces a strict TypeScript workspace package named `@remote-hands/control-plane`.

- [ ] **Step 1: Add package scaffold**

Use the same workspace structure as `packages/daemon`.

- [ ] **Step 2: Verify**

Run:

```bash
npm install
npm run typecheck
```

- [ ] **Step 3: Commit and push**

```bash
git add package-lock.json tsconfig.json packages/control-plane
git commit -m "chore(control-plane): add provider-neutral package"
git push origin main
```

### Task 2.2: Add pairing service

**Files:**
- Create: `packages/control-plane/src/pairing-service.ts`
- Test: `packages/control-plane/src/pairing-service.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces:
  - `function createPairingCode(input: { now: Date; ttlMs: number; randomBytes: () => Uint8Array }): PairingCode`
  - `function hashPairingCode(code: string, salt: string): string`
  - `function canClaimPairingToken(token: PairingToken, now: Date): boolean`
  - `function markPairingTokenClaimed(token: PairingToken, now: Date): PairingToken`

- [ ] **Step 1: Write failing tests**

Tests must prove:

```ts
expect(canClaimPairingToken(validToken, now)).toBe(true);
expect(canClaimPairingToken(expiredToken, now)).toBe(false);
expect(canClaimPairingToken(claimedToken, now)).toBe(false);
expect(hashPairingCode('123456', 'salt')).not.toBe('123456');
```

- [ ] **Step 2: Implement service**

Use Web Crypto-compatible hashing through Node's `crypto` module for tests and
Cloudflare's runtime in adapters. Keep the service pure by accepting hash
dependencies where runtime differences matter.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm test -- packages/control-plane
npm run typecheck
```

Commit:

```bash
git add packages/control-plane/src/pairing-service.ts packages/control-plane/src/pairing-service.test.ts packages/control-plane/src/index.ts
git commit -m "feat(control-plane): add pairing token rules"
git push origin main
```

### Task 2.3: Add task, event and approval services

**Files:**
- Create: `packages/control-plane/src/task-service.ts`
- Create: `packages/control-plane/src/event-service.ts`
- Create: `packages/control-plane/src/approval-service.ts`
- Test: `packages/control-plane/src/task-service.test.ts`
- Test: `packages/control-plane/src/event-service.test.ts`
- Test: `packages/control-plane/src/approval-service.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces:
  - `createTask`
  - `claimTask`
  - `appendEvent`
  - `createApproval`
  - `decideApproval`
  - `expireApproval`

- [ ] **Step 1: Write failing lifecycle tests**

Tests must prove:

```ts
expect(claimTask(queuedTask, machineId).status).toBe('claimed');
expect(() => claimTask(doneTask, machineId)).toThrow(/terminal/);
expect(appendEvent([], eventInput).seq).toBe(0);
expect(decideApproval(pendingApproval, 'approved', now).decided_at).toBe(now.toISOString());
expect(expireApproval(pendingApproval, afterDeadline).decision).toBe('expired');
```

- [ ] **Step 2: Implement pure services**

Use existing shared constants and transition helpers. Keep all database IO out
of these files.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm test -- packages/control-plane
npm run typecheck
```

Commit:

```bash
git add packages/control-plane/src
git commit -m "feat(control-plane): add task event approval rules"
git push origin main
```

---

## Phase 3: Cloudflare Backend Scaffold and D1 Schema

**Outcome:** The default backend package exists, has D1 migrations, and runs in local Cloudflare tooling without Docker.

### Task 3.1: Scaffold `apps/cloudflare`

**Files:**
- Create: `apps/cloudflare/package.json`
- Create: `apps/cloudflare/tsconfig.json`
- Create: `apps/cloudflare/tsconfig.test.json`
- Create: `apps/cloudflare/src/worker.ts`
- Create: `apps/cloudflare/src/env.ts`
- Create: `apps/cloudflare/wrangler.jsonc`
- Modify: `tsconfig.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces a Worker app with typed environment bindings:
  - `DB: D1Database`
  - `TASK_ROOM: DurableObjectNamespace`
  - `ARTIFACTS?: R2Bucket`
  - `OWNER_SECRET_HASH: string`

- [ ] **Step 1: Add smoke test**

Create `apps/cloudflare/src/worker.test.ts`:

```ts
const response = await worker.fetch(new Request('https://example.com/health'), env);
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ ok: true });
```

- [ ] **Step 2: Implement health route**

Return `{ ok: true }` from `/health`; return `404` for unknown routes.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm install
npm test -- apps/cloudflare
npm run typecheck
```

Commit:

```bash
git add package-lock.json tsconfig.json apps/cloudflare
git commit -m "feat(cloudflare): scaffold worker backend"
git push origin main
```

### Task 3.2: Add D1 migrations and repositories

**Files:**
- Create: `apps/cloudflare/migrations/0001_initial.sql`
- Create: `apps/cloudflare/src/d1/machines-repository.ts`
- Create: `apps/cloudflare/src/d1/tasks-repository.ts`
- Create: `apps/cloudflare/src/d1/events-repository.ts`
- Create: `apps/cloudflare/src/d1/approvals-repository.ts`
- Create: `apps/cloudflare/src/d1/pairing-repository.ts`
- Test: `apps/cloudflare/src/d1/*.test.ts`

**Interfaces:**
- Produces repositories that return shared domain types rather than raw SQL rows.

- [ ] **Step 1: Write repository tests**

Use Miniflare/Wrangler local D1 test harness. Tests must prove:

```ts
await machines.upsert(machine);
expect(await machines.listByOwner(ownerId)).toHaveLength(1);
await events.append(taskId, eventInput);
expect((await events.listForTask(taskId))[0]?.seq).toBe(0);
```

- [ ] **Step 2: Create migration**

Create the seven tables from the spec:

```sql
machines;
tasks;
events;
approvals;
pairing_tokens;
sessions;
schema_migrations;
```

Use indexes on `owner_id`, `machine_id`, `task_id`, `expires_at`, and unique
`(task_id, seq)`.

- [ ] **Step 3: Implement repositories**

Use prepared statements and explicit row mapping. JSON payloads are stored as
text and parsed through shared schemas before leaving the repository.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- apps/cloudflare
npm run typecheck
```

Commit:

```bash
git add apps/cloudflare/migrations apps/cloudflare/src/d1
git commit -m "feat(cloudflare): add d1 schema and repositories"
git push origin main
```

---

## Phase 4: Worker HTTP API

**Outcome:** The phone app and daemon can pair, authenticate, create tasks, list state and decide approvals over HTTP.

### Task 4.1: Add auth/session middleware

**Files:**
- Create: `apps/cloudflare/src/auth/session.ts`
- Create: `apps/cloudflare/src/http/errors.ts`
- Create: `apps/cloudflare/src/http/json.ts`
- Test: `apps/cloudflare/src/auth/session.test.ts`

**Interfaces:**
- Produces:
  - `createSessionToken`
  - `hashSessionToken`
  - `authenticateRequest`
  - `requireOwnerSession`
  - `jsonOk`
  - `jsonError`

- [ ] **Step 1: Write failing tests**

Assert missing bearer token returns unauthorized and valid hashed token returns
session metadata.

- [ ] **Step 2: Implement middleware**

Use `Authorization: Bearer <token>`. Store only token hashes in D1.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- apps/cloudflare
npm run typecheck
git add apps/cloudflare/src/auth apps/cloudflare/src/http
git commit -m "feat(cloudflare): add session authentication"
git push origin main
```

### Task 4.2: Add setup and pairing routes

**Files:**
- Create: `apps/cloudflare/src/routes/setup.ts`
- Create: `apps/cloudflare/src/routes/pairing.ts`
- Modify: `apps/cloudflare/src/worker.ts`
- Test: `apps/cloudflare/src/routes/pairing.test.ts`

**Interfaces:**
- Routes:
  - `POST /setup/owner`
  - `POST /pairing/start`
  - `POST /pairing/claim`

- [ ] **Step 1: Write failing route tests**

Tests must prove:

```ts
POST /pairing/start -> 201 with expires_at and code shown once
POST /pairing/claim with wrong code -> 401
POST /pairing/claim with valid code -> 201 with daemon session token
POST /pairing/claim with same code again -> 409
```

- [ ] **Step 2: Implement routes**

Route handlers call `packages/control-plane` pairing rules and D1 repositories.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- apps/cloudflare
npm run typecheck
git add apps/cloudflare/src/routes/setup.ts apps/cloudflare/src/routes/pairing.ts apps/cloudflare/src/worker.ts
git commit -m "feat(cloudflare): add setup and pairing routes"
git push origin main
```

### Task 4.3: Add machine, task, event and approval routes

**Files:**
- Create: `apps/cloudflare/src/routes/machines.ts`
- Create: `apps/cloudflare/src/routes/tasks.ts`
- Create: `apps/cloudflare/src/routes/events.ts`
- Create: `apps/cloudflare/src/routes/approvals.ts`
- Modify: `apps/cloudflare/src/worker.ts`
- Test: `apps/cloudflare/src/routes/*.test.ts`

**Interfaces:**
- Routes:
  - `GET /machines`
  - `POST /tasks`
  - `GET /tasks/:id`
  - `GET /tasks/:id/events`
  - `POST /tasks/:id/events`
  - `POST /tasks/:id/claim`
  - `POST /tasks/:id/complete`
  - `POST /tasks/:id/fail`
  - `POST /approvals`
  - `POST /approvals/:id/decision`

- [ ] **Step 1: Write failing route tests**

Tests must prove owner scoping:

```ts
ownerA can read ownerA task;
ownerB receives 404 for ownerA task;
daemon session for machineA can claim only machineA tasks;
phone session can approve only owner approvals;
```

- [ ] **Step 2: Implement routes**

Each route validates the request with `packages/shared/src/api.ts`, checks
session scope, then calls provider-neutral services and repositories.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- apps/cloudflare
npm run typecheck
git add apps/cloudflare/src/routes apps/cloudflare/src/worker.ts
git commit -m "feat(cloudflare): add task and approval api"
git push origin main
```

---

## Phase 5: Durable Object Live Task Rooms

**Outcome:** Phone and daemon can connect to the same live room and exchange validated realtime messages.

### Task 5.1: Add `TaskRoom` Durable Object

**Files:**
- Create: `apps/cloudflare/src/durable-objects/task-room.ts`
- Create: `apps/cloudflare/src/realtime/room-router.ts`
- Modify: `apps/cloudflare/src/worker.ts`
- Modify: `apps/cloudflare/wrangler.jsonc`
- Test: `apps/cloudflare/src/durable-objects/task-room.test.ts`

**Interfaces:**
- Produces `TaskRoom` with hibernatable WebSocket support and message validation.

- [ ] **Step 1: Write failing relay tests**

Tests must prove:

```ts
phone sends hello;
daemon sends task.event;
phone receives task.event;
unknown message is rejected with type error;
```

- [ ] **Step 2: Implement Durable Object**

Use Cloudflare's hibernation WebSocket API. Persist only connection metadata in
WebSocket attachments. Store durable events in D1 through Worker route calls or
repository access.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- apps/cloudflare
npm run typecheck
git add apps/cloudflare/src/durable-objects apps/cloudflare/src/realtime apps/cloudflare/src/worker.ts apps/cloudflare/wrangler.jsonc
git commit -m "feat(cloudflare): add live task room"
git push origin main
```

### Task 5.2: Add WebSocket upgrade routes

**Files:**
- Create: `apps/cloudflare/src/routes/websocket.ts`
- Modify: `apps/cloudflare/src/worker.ts`
- Test: `apps/cloudflare/src/routes/websocket.test.ts`

**Interfaces:**
- Routes:
  - `GET /ws/tasks/:taskId`
  - `GET /ws/machines/:machineId`

- [ ] **Step 1: Write failing upgrade tests**

Tests must prove invalid sessions cannot upgrade and valid sessions route to
the expected Durable Object id.

- [ ] **Step 2: Implement upgrade routing**

Validate bearer token before creating the Durable Object stub. Use task id for
task rooms and machine id for machine presence rooms.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- apps/cloudflare
npm run typecheck
git add apps/cloudflare/src/routes/websocket.ts apps/cloudflare/src/worker.ts
git commit -m "feat(cloudflare): add websocket upgrade routes"
git push origin main
```

---

## Phase 6: Daemon Cloudflare Transport

**Outcome:** The existing daemon foundation talks to the Cloudflare backend over HTTP and outbound WebSocket.

### Task 6.1: Add Cloudflare client

**Files:**
- Create: `packages/daemon/src/cloudflare-client.ts`
- Test: `packages/daemon/src/cloudflare-client.test.ts`
- Modify: `packages/daemon/src/config.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Produces:
  - `interface CloudflareClientConfig`
  - `class CloudflareControlPlaneClient`
  - `claimNextTask`
  - `appendEvent`
  - `completeTask`
  - `failTask`
  - `createApproval`
  - `decideApproval`

- [ ] **Step 1: Write failing fetch tests**

Use a fake `fetch` function and assert:

```ts
Authorization header is Bearer token;
POST /tasks/:id/events body matches api schema;
non-2xx response throws ControlPlaneError;
```

- [ ] **Step 2: Implement client**

Use shared API schemas for request and response validation.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- packages/daemon
npm run typecheck
git add packages/daemon/src/cloudflare-client.ts packages/daemon/src/cloudflare-client.test.ts packages/daemon/src/config.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): add cloudflare control plane client"
git push origin main
```

### Task 6.2: Add outbound realtime transport

**Files:**
- Create: `packages/daemon/src/realtime-client.ts`
- Test: `packages/daemon/src/realtime-client.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Produces:
  - `class RealtimeClient`
  - `connectMachine(machineId: string): Promise<void>`
  - `send(message: RealtimeMessage): void`
  - `onMessage(handler: (message: RealtimeMessage) => void): void`

- [ ] **Step 1: Write failing tests**

Use a fake WebSocket implementation. Assert outgoing messages are serialized
and incoming messages are parsed through `safeParseRealtimeMessage`.

- [ ] **Step 2: Implement transport**

Use the platform WebSocket API available in Node 22. Add reconnect backoff with
bounded jitter.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- packages/daemon
npm run typecheck
git add packages/daemon/src/realtime-client.ts packages/daemon/src/realtime-client.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): add outbound realtime client"
git push origin main
```

### Task 6.3: Wire daemon loop to Cloudflare client

**Files:**
- Modify: `packages/daemon/src/daemon.ts`
- Create: `packages/daemon/src/cloudflare-task-store.ts`
- Test: `packages/daemon/src/cloudflare-task-store.test.ts`

**Interfaces:**
- Produces `CloudflareTaskStore implements TaskStore`.

- [ ] **Step 1: Write failing adapter tests**

Assert every `TaskStore` method maps to the correct Cloudflare API route.

- [ ] **Step 2: Implement adapter**

Keep `runDaemonOnce` unchanged by satisfying the existing `TaskStore`
interface.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- packages/daemon
npm run typecheck
git add packages/daemon/src/daemon.ts packages/daemon/src/cloudflare-task-store.ts packages/daemon/src/cloudflare-task-store.test.ts
git commit -m "feat(daemon): wire task store to cloudflare"
git push origin main
```

---

## Phase 7: Browser Frames and Approval Gate

**Outcome:** The phone sees browser activity live and dangerous actions block for approval.

### Task 7.1: Add frame stream boundary

**Files:**
- Create: `packages/daemon/src/frame-stream.ts`
- Test: `packages/daemon/src/frame-stream.test.ts`

**Interfaces:**
- Produces:
  - `interface BrowserFrame`
  - `interface FrameSource`
  - `class ThrottledFrameStream`

- [ ] **Step 1: Write failing throttle tests**

Assert duplicate frames are dropped and frames are emitted at most once per
500ms.

- [ ] **Step 2: Implement frame stream**

Keep CDP-specific capture behind `FrameSource` so tests do not need Chrome.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- packages/daemon
npm run typecheck
git add packages/daemon/src/frame-stream.ts packages/daemon/src/frame-stream.test.ts
git commit -m "feat(daemon): add throttled frame stream"
git push origin main
```

### Task 7.2: Add approval gate client

**Files:**
- Create: `packages/daemon/src/approval-gate.ts`
- Test: `packages/daemon/src/approval-gate.test.ts`

**Interfaces:**
- Produces:
  - `requestApproval`
  - `waitForApprovalDecision`
  - `resolveApprovalOrTimeout`

- [ ] **Step 1: Write failing deny-on-timeout tests**

Assert an unanswered approval resolves as `expired`, not `approved`.

- [ ] **Step 2: Implement approval gate**

Use the Cloudflare client to create approvals and subscribe for decisions over
the realtime client.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- packages/daemon
npm run typecheck
git add packages/daemon/src/approval-gate.ts packages/daemon/src/approval-gate.test.ts
git commit -m "feat(daemon): add approval gate client"
git push origin main
```

---

## Phase 8: Phone PWA

**Outcome:** Users can operate the product from a phone browser.

### Task 8.1: Scaffold `apps/web`

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/styles.css`

**Interfaces:**
- Produces a Vite React app that reads `VITE_REMOTE_HANDS_API_URL`.

- [ ] **Step 1: Add smoke test**

Use Vitest + React Testing Library to assert the app renders a machine list
placeholder.

- [ ] **Step 2: Implement scaffold**

Create mobile-first layout with no marketing landing page as the first screen.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- apps/web
npm run typecheck
npm run build --workspace apps/web
git add package-lock.json apps/web
git commit -m "feat(web): scaffold phone pwa"
git push origin main
```

### Task 8.2: Add live task UI

**Files:**
- Create: `apps/web/src/screens/MachinesScreen.tsx`
- Create: `apps/web/src/screens/NewTaskScreen.tsx`
- Create: `apps/web/src/screens/LiveTaskScreen.tsx`
- Create: `apps/web/src/components/ApprovalSheet.tsx`
- Create: `apps/web/src/components/EventTimeline.tsx`
- Create: `apps/web/src/components/FrameViewer.tsx`
- Test: `apps/web/src/**/*.test.tsx`

**Interfaces:**
- Consumes shared API and realtime schemas.
- Produces phone workflows for selecting a machine, creating a task, watching
  live progress and deciding approvals.

- [ ] **Step 1: Write failing interaction tests**

Assert:

```ts
user can create a task from machine screen;
task.event message appears in timeline;
task.frame message updates frame viewer;
approval.requested opens approval sheet;
approve button posts approval decision;
```

- [ ] **Step 2: Implement screens**

Keep layout dense, phone-first and operational. Use cards only for individual
tasks/events/approvals.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- apps/web
npm run typecheck
npm run build --workspace apps/web
git add apps/web
git commit -m "feat(web): add live task workflow"
git push origin main
```

---

## Phase 9: One-Command Setup CLI

**Outcome:** General users do not need to manually provision Cloudflare resources.

### Task 9.1: Scaffold `packages/cli`

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/commands/setup.ts`
- Create: `packages/cli/src/commands/deploy.ts`
- Create: `packages/cli/src/commands/daemon.ts`
- Create: `packages/cli/src/commands/doctor.ts`
- Test: `packages/cli/src/**/*.test.ts`

**Interfaces:**
- Produces executable `remote-hands`.

- [ ] **Step 1: Write failing command parser tests**

Assert `remote-hands setup`, `remote-hands deploy`, `remote-hands daemon` and
`remote-hands doctor` dispatch to the right command functions.

- [ ] **Step 2: Implement CLI scaffold**

Use Node's standard library for argument parsing first. Add a dependency only
if command complexity requires it.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- packages/cli
npm run typecheck
git add package-lock.json packages/cli
git commit -m "feat(cli): scaffold remote-hands command"
git push origin main
```

### Task 9.2: Automate Cloudflare deploy

**Files:**
- Create: `packages/cli/src/cloudflare/wrangler.ts`
- Create: `packages/cli/src/cloudflare/project.ts`
- Create: `packages/cli/src/config/local-config.ts`
- Test: `packages/cli/src/cloudflare/*.test.ts`

**Interfaces:**
- Produces:
  - `ensureWranglerLogin`
  - `createD1Database`
  - `createR2Bucket`
  - `writeWranglerConfig`
  - `deployWorker`
  - `deployWebApp`

- [ ] **Step 1: Write failing command-building tests**

Use a fake command runner. Assert exact Wrangler commands are generated for
login, D1 creation, migration apply and deployment.

- [ ] **Step 2: Implement automation**

Do not shell out in tests. Inject a command runner and filesystem adapter.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- packages/cli
npm run typecheck
git add packages/cli/src/cloudflare packages/cli/src/config
git commit -m "feat(cli): automate cloudflare deployment"
git push origin main
```

### Task 9.3: Add guided setup and pairing output

**Files:**
- Modify: `packages/cli/src/commands/setup.ts`
- Create: `packages/cli/src/pairing/qr.ts`
- Create: `packages/cli/src/output/messages.ts`
- Test: `packages/cli/src/commands/setup.test.ts`

**Interfaces:**
- Produces a setup flow that prints:
  - deployed phone URL
  - daemon start command
  - QR-compatible pairing URL
  - recovery instructions

- [ ] **Step 1: Write failing setup flow tests**

Assert setup calls deploy steps in order and does not print raw long-lived
secrets.

- [ ] **Step 2: Implement setup flow**

Store local daemon config in an OS-appropriate config directory. Write a
git-ignored project config only for development checkouts.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- packages/cli
npm run typecheck
git add packages/cli/src/commands/setup.ts packages/cli/src/pairing packages/cli/src/output
git commit -m "feat(cli): add guided free setup"
git push origin main
```

---

## Phase 10: End-to-End Acceptance Harness

**Outcome:** The project proves the full free path works without Supabase, Vercel or Docker.

### Task 10.1: Add local Cloudflare integration harness

**Files:**
- Create: `tests/e2e/cloudflare-free-flow.test.ts`
- Create: `tests/e2e/helpers/cloudflare-harness.ts`
- Create: `tests/e2e/helpers/fake-daemon.ts`
- Modify: `vitest.config.mts`

**Interfaces:**
- Produces an automated flow that starts local Worker runtime, creates a task,
  connects a fake daemon, streams events and handles approval.

- [ ] **Step 1: Write failing e2e test**

The test should assert:

```ts
phone creates task;
daemon receives task;
daemon emits browser_action;
daemon requests approval;
phone approves;
daemon completes task;
phone reads result event;
```

- [ ] **Step 2: Implement harness**

Use fake daemon and fake frame source first. Real Chrome/browser-harness is a
manual acceptance layer.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- tests/e2e/cloudflare-free-flow.test.ts
npm run typecheck
git add tests/e2e vitest.config.mts
git commit -m "test(e2e): cover free cloudflare task flow"
git push origin main
```

### Task 10.2: Add manual browser acceptance script

**Files:**
- Create: `scripts/acceptance/wordpress-privacy-policy.md`
- Create: `scripts/acceptance/run-local-free-stack.md`
- Modify: `README.md`

**Interfaces:**
- Produces a documented manual test for the original product scenario.

- [ ] **Step 1: Document prerequisites**

List:

```text
Cloudflare account on free plan
Wrangler authenticated
agy installed
Chrome available
browser-harness available
test WordPress site
```

- [ ] **Step 2: Document exact test**

Write the start commands, phone actions, expected approval prompt and expected
result URL.

- [ ] **Step 3: Commit and push**

```bash
git add scripts/acceptance README.md
git commit -m "docs: add free stack acceptance script"
git push origin main
```

---

## Phase 11: Release and Contributor Polish

**Outcome:** The open-source project is usable, understandable and hard to misuse.

### Task 11.1: Add free setup docs

**Files:**
- Create: `docs/cloudflare-free-setup.md`
- Create: `docs/troubleshooting.md`
- Modify: `README.md`

**Interfaces:**
- Produces public docs for users who do not want to understand the internals.

- [ ] **Step 1: Write happy-path guide**

Guide should be under 10 minutes:

```bash
npm install -g remote-hands
remote-hands setup
remote-hands daemon
```

- [ ] **Step 2: Write troubleshooting guide**

Cover Wrangler login failure, D1 creation failure, deployment failure, pairing
expiry, daemon offline, phone cannot connect, approval timeout and free-tier
limit errors.

- [ ] **Step 3: Verify docs and commit**

```bash
rg -n "Supabase project|Vercel deploy|Docker" README.md docs/cloudflare-free-setup.md docs/troubleshooting.md
git add README.md docs/cloudflare-free-setup.md docs/troubleshooting.md
git commit -m "docs: add free cloudflare setup guide"
git push origin main
```

Expected: matches only appear in wording that says those services are not
required by the default path.

### Task 11.2: Add CI coverage for new workspaces

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces CI jobs for shared, control-plane, daemon, CLI, web build and
  Cloudflare backend unit tests.

- [ ] **Step 1: Add CI matrix**

Run:

```yaml
npm ci
npm run typecheck
npm test -- packages/shared
npm test -- packages/control-plane
npm test -- packages/daemon
npm test -- packages/cli
npm test -- apps/cloudflare
npm test -- apps/web
npm run build --workspace apps/web
```

- [ ] **Step 2: Keep integration tests separate**

Cloudflare local integration tests should be a separate job so ordinary package
test failures remain easy to read.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: cover free cloudflare workspaces"
git push origin main
```

---

## Completion Checklist

The project reaches the end-to-end definition when all of these are true:

- `remote-hands setup` can deploy a fresh free Cloudflare stack.
- `remote-hands daemon` can pair and connect outbound without exposing a local port.
- The phone PWA can create a task and watch its live timeline.
- Browser frames stream live without being stored by default.
- Approval requests block dangerous actions and deny on timeout.
- The original "Add a privacy policy page to my WordPress site" scenario works.
- The default docs do not require Supabase, Vercel or Docker.
- The old Supabase control plane is clearly marked optional.
- CI typechecks and tests all packages.
- The README tells users what free-tier limits mean without overpromising.

