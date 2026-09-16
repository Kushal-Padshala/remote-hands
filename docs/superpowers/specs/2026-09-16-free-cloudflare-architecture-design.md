# remote-hands — Free Cloudflare Architecture Design

**Date:** 2026-09-16
**Status:** Proposed default architecture
**Repository:** https://github.com/Kushal-Padshala/remote-hands

---

## 1. Summary

`remote-hands` should default to a completely free, low-friction deployment
model for personal and open-source users. The original Supabase-first control
plane is still technically sound, but it asks general users to create a
Supabase project, manage API keys, deploy a separate web app to Vercel, and run
Docker for local database development. That is too much setup for the audience.

The new default architecture uses Cloudflare's free developer platform:

- Cloudflare Workers for the API.
- Cloudflare D1 for relational state.
- Cloudflare Durable Objects for live task rooms and WebSocket relay.
- Cloudflare Pages, or static assets served by Workers, for the phone app.
- Cloudflare R2 only when stored screenshots/artifacts are enabled.
- A local laptop daemon that makes outbound connections only.

The laptop is never a public server. It does not need Docker. It only runs the
daemon when the user wants the machine to be available for tasks.

## 2. Product Goal

The default open-source setup should feel like:

```bash
npm install -g remote-hands
remote-hands setup
remote-hands daemon
```

The setup command should:

1. Authenticate the user with Cloudflare through Wrangler.
2. Create or reuse a Cloudflare Worker project.
3. Create D1 and Durable Object resources.
4. Optionally create an R2 bucket for stored artifacts.
5. Deploy the control plane and phone web app.
6. Generate a pairing code for the laptop daemon.
7. Print and QR-render the phone URL.

The user should not need to manually copy random dashboard values unless the
automatic setup fails.

## 3. Free-Tier Philosophy

"Completely free" means this project is designed to run inside free plan
limits for personal usage. It cannot promise infinite scale, business-grade
uptime, or permanent provider pricing. The project should be honest about that
in public docs.

The free-first architecture follows these rules:

- Store durable metadata in D1: machines, tasks, approvals, event ledger.
- Stream live frames through WebSockets and do not store them by default.
- Store screenshots in R2 only when the user explicitly enables history.
- Keep the phone app static where possible.
- Avoid a custom always-on server.
- Avoid Docker for ordinary setup and development.
- Keep Supabase as an optional adapter, not the default path.

## 4. Architecture

```text
PHONE / PWA
  - static app
  - task creation
  - live timeline
  - approval decisions
        |
        | HTTPS + WebSocket
        v
CLOUDFLARE WORKER
  - auth/session
  - pairing
  - REST API
  - Worker-to-D1 access
  - routes live task traffic to Durable Objects
        |
        +---------- D1
        |           - machines
        |           - tasks
        |           - events
        |           - approvals
        |           - pairing tokens
        |
        +---------- DURABLE OBJECT PER TASK OR MACHINE
        |           - phone WebSocket
        |           - daemon WebSocket
        |           - live event/frame relay
        |           - ephemeral presence
        |
        +---------- R2, OPTIONAL
                    - retained screenshot frames
                    - artifacts and exports

LAPTOP DAEMON
  - outbound WebSocket to Cloudflare
  - local agy process runner
  - browser harness / Chrome CDP capture
  - approval hook client
```

## 5. Main Components

### 5.1 `packages/shared`

This remains the source of truth for task, machine, approval and event
contracts. It should gain transport-level schemas that both the Worker and
daemon use:

- Pairing request/response payloads.
- WebSocket message envelopes.
- D1 row mappers.
- Public API request/response schemas.

### 5.2 `packages/control-plane`

This package contains provider-neutral control-plane domain logic. It must not
import Cloudflare runtime APIs directly. It owns:

- Input validation.
- State transition checks.
- Event sequence assignment rules.
- Pairing token rules.
- Approval decision rules.
- Authorization helpers.

Cloudflare-specific code calls this package.

### 5.3 `apps/cloudflare`

This is the default backend and deployment target. It contains:

- Worker route handlers.
- D1 migrations.
- Durable Object classes.
- Wrangler configuration template.
- Integration tests with Miniflare or Wrangler local runtime.

The Worker provides HTTP endpoints for setup, pairing, task creation, history,
approval decisions, and signed WebSocket session creation.

### 5.4 `apps/web`

This is the phone-first PWA. It should be static, mobile-first, and deployable
to Cloudflare Pages or as Worker static assets. It talks only to the user's
deployed Worker URL.

Primary screens:

- Pair / sign in.
- Machine list.
- New task.
- Live task.
- Approval sheet.
- History.
- Settings and export.

### 5.5 `packages/daemon`

The daemon continues to run locally on the user's laptop. Its current testable
foundation remains useful, but the persistence adapter should target the
Cloudflare Worker rather than Supabase by default.

The daemon:

- Opens an outbound WebSocket to the Worker/Durable Object.
- Registers machine presence.
- Claims tasks sent to that machine.
- Runs `agy` with safe arguments and no permission bypass.
- Streams agent events to the live task room.
- Streams browser frames without storing them by default.
- Blocks approval-gated actions until the phone approves, rejects, or times out.

### 5.6 `packages/cli`

This is the user-facing setup and operations tool:

- `remote-hands setup`
- `remote-hands deploy`
- `remote-hands daemon`
- `remote-hands pair`
- `remote-hands status`
- `remote-hands doctor`
- `remote-hands uninstall`

The CLI should automate Cloudflare setup through Wrangler wherever possible.
When automation fails, it should print exact recovery commands.

## 6. Data Model

D1 should mirror the existing Supabase schema conceptually, but migrations live
under the Cloudflare app.

### `machines`

- `id text primary key`
- `owner_id text not null`
- `name text not null`
- `hostname text not null`
- `daemon_version text`
- `agy_version text`
- `status text not null check status in ('online', 'offline')`
- `last_seen_at text`
- `created_at text not null`
- unique `(owner_id, name)`

### `tasks`

- `id text primary key`
- `owner_id text not null`
- `machine_id text not null references machines(id)`
- `prompt text not null`
- `kind text not null`
- `workspace_path text`
- `model text`
- `effort text`
- `mode text not null`
- `status text not null`
- `conversation_id text`
- `parent_task_id text references tasks(id)`
- `result_summary text`
- `error text`
- `created_at text not null`
- `started_at text`
- `finished_at text`

### `events`

- `id integer primary key autoincrement`
- `task_id text not null references tasks(id)`
- `owner_id text not null`
- `seq integer not null`
- `kind text not null`
- `payload text not null`
- `created_at text not null`
- unique `(task_id, seq)`

Events remain append-only at the application layer. D1 does not provide
Postgres RLS, so the Worker becomes the trusted authorization boundary.

### `approvals`

- `id text primary key`
- `task_id text not null references tasks(id)`
- `owner_id text not null`
- `action_kind text not null`
- `summary text not null`
- `risk text not null`
- `tool_payload text not null`
- `frame_path text`
- `decision text not null`
- `decided_at text`
- `expires_at text not null`
- `created_at text not null`

### `pairing_tokens`

- `id text primary key`
- `owner_id text not null`
- `machine_name text not null`
- `code_hash text not null`
- `expires_at text not null`
- `claimed_at text`
- `created_at text not null`

Pairing tokens should be short lived, single use, and stored hashed.

### `sessions`

- `id text primary key`
- `owner_id text not null`
- `machine_id text`
- `kind text not null check kind in ('phone', 'daemon')`
- `token_hash text not null`
- `expires_at text not null`
- `created_at text not null`

Session tokens should be opaque bearer tokens generated by the Worker and stored
hashed in D1.

## 7. Live Transport

Durable Objects coordinate live task sessions:

- One object per active task is easiest to reason about.
- The phone connects to `/ws/tasks/:taskId`.
- The daemon connects to `/ws/machines/:machineId`.
- The Worker validates the token before routing to the object.
- The object relays agent events, status updates, approval requests and frame
  previews.
- Durable events that must survive reconnect are written to D1.
- Frame previews are ephemeral unless artifact storage is enabled.

Messages use an envelope:

```ts
type RealtimeMessage =
  | { type: 'hello'; role: 'phone' | 'daemon'; protocol_version: 1 }
  | { type: 'task.event'; task_id: string; event: EventInput }
  | { type: 'task.frame'; task_id: string; jpeg_base64: string; captured_at: string }
  | { type: 'approval.requested'; task_id: string; approval_id: string }
  | { type: 'approval.decided'; approval_id: string; decision: ApprovalDecision }
  | { type: 'heartbeat'; machine_id: string; sent_at: string }
  | { type: 'error'; message: string };
```

The schema belongs in `packages/shared` and must be runtime-validated at every
process boundary.

## 8. Authentication and Pairing

The fully free default should avoid paid auth providers. The simplest path is
single-owner self-hosted auth:

1. During `remote-hands setup`, the CLI generates an owner secret locally.
2. The Worker stores only a hash of that owner secret.
3. The phone signs in using a setup link or QR code containing a one-time token.
4. The daemon pairs using a short numeric code or QR flow.
5. The Worker exchanges one-time pairing tokens for scoped session tokens.

This is not a multi-tenant SaaS model. It is a personal self-hosted control
plane. Multi-user/team auth can be added as an optional paid-provider adapter
after the personal flow is solid.

## 9. Security Requirements

- No `--dangerously-skip-permissions`.
- Laptop daemon uses outbound connections only.
- Pairing codes are single-use and expire quickly.
- Session tokens are stored hashed in D1.
- Approval decisions deny on timeout.
- Durable Object messages are validated with shared schemas.
- The Worker checks owner/session scope on every HTTP route and WebSocket
  upgrade.
- Events are append-only through public APIs.
- Stored frames are off by default.
- Stored artifacts have retention controls.
- The CLI never prints long-lived secrets unless the user passes a recovery
  flag.

## 10. Local Development

Local development should not require Docker:

- Use Vitest for package tests.
- Use Wrangler local development for Worker/D1/Durable Object tests.
- Use D1 local databases through Wrangler.
- Use fake daemon runners for integration tests.
- Keep Supabase tests only for the optional Supabase adapter while it exists.

## 11. Migration From Current Repo

The current code should not be thrown away.

Keep:

- `packages/shared` contracts.
- `packages/daemon` config/runtime/runner/store boundary.
- Existing Supabase migrations and tests as a reference and optional adapter.

Change:

- README roadmap should present Cloudflare Free as the default.
- Supabase docs should move under an optional backend section.
- New backend work should target `apps/cloudflare`.
- The daemon should depend on a control-plane client interface rather than a
  Supabase-specific store.

## 12. End-to-End Acceptance Test

The new acceptance test stays product-focused:

1. User runs `remote-hands setup`.
2. CLI deploys Cloudflare resources and prints a phone URL.
3. User starts `remote-hands daemon`.
4. User opens the phone URL and creates a browser task.
5. Laptop daemon receives the task over an outbound WebSocket.
6. Daemon runs `agy` and streams events/frames to the phone.
7. A publish action triggers an approval request.
8. Phone approves.
9. Daemon continues, completes the task, and sends a result URL.
10. Phone history shows the event ledger.

