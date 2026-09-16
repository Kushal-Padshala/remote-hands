# remote-hands

<p align="center">
  <strong>Drive your computer from your phone with real-time visual streaming and human approval before anything dangerous happens.</strong>
</p>

<p align="center">
  <a href="https://github.com/Kushal-Padshala/remote-hands/actions/workflows/ci.yml"><img src="https://github.com/Kushal-Padshala/remote-hands/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg" alt="Node Version" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.9%20Strict-blue.svg" alt="TypeScript" /></a>
  <a href="https://vitest.dev"><img src="https://img.shields.io/badge/tested%20with-vitest-yellow.svg" alt="Vitest" /></a>
</p>

---

## What is remote-hands?

`remote-hands` allows you to dispatch tasks to your personal computer directly from your phone, watch the autonomous agent execute steps inside your actual signed-in browser session, and approve or reject irreversible operations before they occur.

The name draws inspiration from data center operations: **remote hands** refers to technical staff physically on-site executing operations on your hardware. Here, your computer serves that role autonomously while keeping you in direct control.

### The Problem

Terminal-based remote agent controllers work for pure coding tasks, but fail for browser actions. A log line reading `click_at_xy(412, 380)` gives zero indication whether the agent is about to submit a form, publish a post, or charge a credit card.

| Feature | `remote-hands` | Standard Terminal Bridges | Cloud Agent Browsers |
|---|---|---|---|
| **Controlled from Mobile** | Yes | Yes | Yes |
| **Uses Your Real Signed-in Browser** | Yes (Local Chrome profile) | No | No (Ephemeral cloud browser) |
| **Live Visual Stream** | Yes (Real screenshots) | No (Text terminal only) | Yes |
| **Human-in-the-Loop Approval Gate** | Yes (Deny-on-timeout) | Partial | Rare |
| **Self-Hostable Open Source** | Yes | Yes | No |

---

## Security Architecture & Threat Model

Running an agent on your computer with access to active browser sessions (email, cloud infrastructure, banking) carries real operational risk. `remote-hands` is engineered with a strict zero-trust security model:

1. **Deny-on-Timeout**: All gated actions default to rejection if an approval request expires or connection drops.
2. **Never Skips Permissions**: The agent runtime operates without permission bypass flags.
3. **Append-Only Event Ledger**: The database rejects `UPDATE` operations on event rows, preventing an agent or compromised actor from altering historical actions.
4. **Immutable Audit Trail**: Approvals cannot be deleted from the database.
5. **Row-Level Security (RLS)**: Every table enforces RLS. Foreign keys (`tasks.machine_id`, `events.task_id`, `approvals.task_id`, `tasks.parent_task_id`) use `security invoker` functions to guarantee cross-tenant isolation.
6. **Automated Catalog Invariant Tests**: Continuous integration inspects `pg_constraint` and `pg_policies` to verify that any foreign key pointing to user-owned data has a matching ownership check.

Review [SECURITY.md](SECURITY.md) and [docs/architecture/control-plane.md](docs/architecture/control-plane.md) for full threat model details.

---

## High-Level Architecture

```text
┌────────────────────────────────┐
│      Mobile Web / Phone App     │
│   (Realtime stream, approvals) │
└───────────────┬────────────────┘
                │  HTTPS / WSS (Supabase Realtime)
                ▼
┌────────────────────────────────┐
│     Supabase Control Plane     │
│  - RLS-guarded Postgres        │
│  - Event log & approval state  │
└───────────────▲────────────────┘
                │  Authenticated polling & event emission
                ▼
┌────────────────────────────────┐
│      Local Machine Daemon      │
│  - Task claim & heartbeat      │
│  - Screenshot capture          │
└───────────────┬────────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
┌──────────────┐ ┌──────────────┐
│  Agent CLI   │ │ Local Chrome │
│  (`agy`)     │ │ (Real profile│
└──────────────┘ └──────────────┘
```

---

## Project Structure

This repository is organized as a monorepo using npm workspaces:

```text
remote-hands/
├── packages/
│   └── shared/               # Shared domain contracts, Zod schemas, state machines
│       ├── src/
│       │   ├── approval.ts   # Approval schemas & expiry boundaries
│       │   ├── event.ts      # 11 event kind schemas & safe parser
│       │   ├── machine.ts    # Machine models & liveness checks
│       │   ├── task.ts       # Task lifecycle & legal state transitions
│       │   └── database.generated.ts # Database types
├── supabase/
│   ├── migrations/           # Versioned SQL migrations with RLS policies
│   └── tests/                # Postgres integration & security tests
│       ├── rls.test.ts       # Multi-tenant isolation verification
│       └── schema-invariants.test.ts # Database catalog invariant suite
├── docs/
│   ├── architecture/         # Control plane and system documentation
│   └── development.md        # Local environment walkthrough
├── .github/
│   └── workflows/ci.yml      # CI workflow (typechecks, Supabase integration, secrets)
└── package.json              # Workspace root configuration
```

---

## Development Quickstart

### Prerequisites

- **Node.js**: `>=22.0.0`
- **Docker**: Required to run local Supabase containers

### Setup Instructions

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Kushal-Padshala/remote-hands.git
   cd remote-hands
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start local Supabase**:
   ```bash
   npm run db:start
   ```

4. **Run the test suite**:
   ```bash
   npm test
   ```

5. **Typecheck all packages**:
   ```bash
   npm run typecheck
   ```

6. **Reset the database schema**:
   ```bash
   npm run db:reset
   ```

---

## Roadmap

- [x] **Phase 1: Foundation & Control Plane**
  - Monorepo workspace scaffolding with Node 22 & TypeScript 5.9
  - `@remote-hands/shared` contracts with Zod validation
  - Supabase schema migrations (`machines`, `tasks`, `events`, `approvals`)
  - Full Row-Level Security isolation with `security invoker` functions
  - Automated catalog invariant test suite
- [ ] **Phase 2: Local Daemon & Supervisor**
  - Machine pairing and secure credential storage
  - Daemon task-claiming loop and heartbeat reporter
  - Agent process runner with streaming stdout/stderr parsing
  - Visual frame buffer capturing browser screenshots
- [ ] **Phase 3: Approval Gate Hook**
  - Hook integration intercepting critical actions
  - Risk classification and payload capture
  - Timeout enforcement and deny-on-timeout handler
- [ ] **Phase 4: Mobile Web Application**
  - Passkey-primary authentication with WebAuthn
  - Live timeline rendering with Supabase Realtime
  - Single-tap approval and rejection cards

---

## Contributing

We welcome contributions. Please review [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before opening pull requests.

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.  
Copyright (c) 2026 Kushal Padshala.
