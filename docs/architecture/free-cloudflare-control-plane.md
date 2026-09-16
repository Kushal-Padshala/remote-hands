# Free Cloudflare Control Plane Architecture

**Status:** Default Architecture  
**Reference Spec:** `docs/superpowers/specs/2026-09-16-free-cloudflare-architecture-design.md`

## 1. Summary

The default architecture of `remote-hands` runs entirely on Cloudflare's free developer tier:
- **Cloudflare Workers**: API routes, session authentication, and WebSocket routing.
- **Cloudflare D1**: SQLite relational database for machines, tasks, events, approvals, and sessions.
- **Cloudflare Durable Objects**: Stateful live task rooms (`TaskRoom`) relaying real-time WebSockets between phone and laptop daemon.
- **Cloudflare Pages / Static Worker Assets**: Phone-first PWA (`apps/web`).
- **Cloudflare R2** *(Optional)*: Persisted screenshot frames and task artifacts when retention history is enabled.
- **Laptop Daemon**: Local Node 22 process connecting outbound-only to Cloudflare.

The user's laptop is never exposed to the public internet, does not require a static or public IP, does not run Docker, and only runs when the user wants their computer available for remote tasks.

---

## 2. Architecture Diagram

```text
PHONE / PWA (apps/web)
  - Static Vite + React app
  - Task creation & machine selection
  - Live event timeline & visual frame viewer
  - Approval sheet (one-tap approve/reject)
        |
        | HTTPS + WebSocket (/ws/tasks/:taskId)
        v
CLOUDFLARE WORKER (apps/cloudflare)
  - Bearer session authentication
  - Single-owner pairing flow
  - REST endpoints for tasks, machines, approvals, events
  - Routes live task traffic to Durable Objects
        |
        +---> D1 (SQLite relational storage)
        |     - machines
        |     - tasks
        |     - events (append-only ledger)
        |     - approvals
        |     - pairing_tokens
        |     - sessions
        |
        +---> DURABLE OBJECT (TaskRoom)
        |     - Relays messages between phone & daemon WebSockets
        |     - Streams ephemeral preview frames
        |     - Relays live agent events and approval requests
        |
        +---> R2 (Optional artifact bucket)
              - Retained screenshot frames when history enabled
        ^
        | Outbound WebSocket (/ws/machines/:machineId) + REST
LAPTOP DAEMON (packages/daemon)
  - Outbound-only connection (no listening ports)
  - Manages local `agy` runner with strict security
  - Throttled browser preview frame stream
  - Approval gate intercepting irreversible actions
```

---

## 3. Core Components

### `packages/shared`
Single source of truth for cross-process types and runtime validation:
- API request/response Zod schemas (`packages/shared/src/api.ts`).
- Realtime WebSocket message contracts (`packages/shared/src/realtime.ts`).
- D1 row types and domain mappers (`packages/shared/src/cloudflare-schema.ts`).
- Shared constants, task transitions, and risk levels.

### `packages/control-plane`
Provider-neutral domain logic and security checks (pure TypeScript, no Cloudflare runtime bindings):
- Pairing code hashing, expiration, and single-use claiming (`pairing-service.ts`).
- Task state machine and claim rules (`task-service.ts`).
- Event append ordering and monotonic sequence assignment (`event-service.ts`).
- Approval lifecycle and deny-on-timeout evaluation (`approval-service.ts`).

### `apps/cloudflare`
Cloudflare deployment target:
- Worker fetch handler and API routes (`/setup`, `/pairing`, `/machines`, `/tasks`, `/approvals`).
- `TaskRoom` Durable Object using Cloudflare hibernation WebSocket API.
- D1 SQL schema migrations and repository adapters.
- WebSocket upgrade route handlers.

### `apps/web`
Mobile-first phone PWA:
- Pair and sign in using one-time token / QR code.
- Machine list and status.
- New task submission.
- Real-time task timeline with streaming agent text, tool calls, and browser frames.
- Interactive approval sheet.

### `packages/daemon`
Local laptop supervisor:
- Connects outbound to Cloudflare Worker via WebSocket and REST.
- Claims queued tasks for its machine ID.
- Executes `agy` with safe permissions (never `--dangerously-skip-permissions`).
- Captures and throttles browser preview frames (ephemeral relay, max 2 fps).
- Intercepts dangerous actions and blocks for approval with timeout auto-denial.

### `packages/cli`
User-facing CLI tool (`remote-hands`):
- `remote-hands setup`: Automates Wrangler authentication, D1 provisioning, migration deployment, and phone URL generation.
- `remote-hands deploy`: Redeploys Worker and PWA.
- `remote-hands daemon`: Runs the local laptop daemon.
- `remote-hands doctor`: Verifies dependencies (Node, `agy`, Chrome, Cloudflare connectivity).

---

## 4. Data Model (D1 SQLite)

1. **`machines`**: Registered laptops/computers.
2. **`tasks`**: Discrete tasks queued and executed on machines.
3. **`events`**: Append-only execution event ledger with unique `(task_id, seq)`.
4. **`approvals`**: Human-in-the-loop authorization gates.
5. **`pairing_tokens`**: Short-lived, single-use pairing codes stored hashed.
6. **`sessions`**: Scoped bearer session tokens stored hashed.
7. **`schema_migrations`**: Migration tracker.

---

## 5. Free-Tier Boundaries

The system is designed to operate comfortably within Cloudflare's free limits for personal usage:
- **Workers**: 100,000 requests/day.
- **D1**: 5,000,000 rows read/day, 100,000 rows written/day, 5 GB storage.
- **Durable Objects**: Included allowances for lightweight WebSocket relay.
- **Browser Frames**: Streamed as ephemeral WebSocket payloads; never written to D1 or R2 unless artifact history is explicitly configured.

---

## 6. Security Model

- Outbound-only laptop daemon (zero incoming ports).
- Strict permissions runtime (no `--dangerously-skip-permissions`).
- Deny-on-timeout for all approvals.
- Hashed pairing tokens and hashed session tokens.
- Worker-level session authentication and owner verification on every HTTP endpoint and WebSocket upgrade.
