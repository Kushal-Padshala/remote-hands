# remote-hands

> Send a task to your computer from your phone. Watch the agent do it in your real, logged-in browser. Approve anything irreversible before it happens.

[![CI](https://github.com/Kushal-Padshala/remote-hands/actions/workflows/ci.yml/badge.svg)](https://github.com/Kushal-Padshala/remote-hands/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-black.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9%20strict-blue.svg)](https://www.typescriptlang.org)

```console
$ remote-hands daemon
[10:14:02] daemon online • macbook-pro (arm64) • pairing active
[10:14:06] task from phone: "Publish privacy policy update on WordPress"
[10:14:07] chrome attached (profile: Default, debugging-port: 9222)
[10:14:10] wp-admin opened • session active (logged in as admin)
[10:14:12] drafting policy text via agy... done (840 words)
[10:14:15] ⚠️  APPROVAL REQUIRED: agent is about to click "Publish"
[10:14:15] waiting for phone authorization (deny-on-timeout: 05:00)...
[10:14:24] ✓ approved from iPhone
[10:14:25] published: https://example.com/privacy-policy (status: 200 OK)
```

---

## Why remote-hands?

Terminal-based remote agent controllers work for pure coding, but fail for browser tasks. A transcript reading `click_at_xy(412, 380)` gives zero context on whether the agent is one click away from charging a card or publishing to your live site.

`remote-hands` connects an autonomous agent (`agy`) running locally on your hardware to your phone with live visual frame streaming and an approval gate that intercepts dangerous actions before execution.

| Feature | `remote-hands` | Terminal Bridges | Cloud Browsers |
|:---|:---:|:---:|:---:|
| 📱 Mobile remote control | ✅ | ✅ | ✅ |
| 🌐 Your real signed-in Chrome profile | ✅ | ❌ | ❌ |
| 📸 Live visual frame stream | ✅ | ❌ | ✅ |
| 🛡️ Human-in-the-loop approval gate | ✅ | ⚠️ | ❌ |
| 💻 Self-hostable & open source | ✅ | ✅ | ❌ |

---

## Security Model & Invariants

Running an autonomous agent with access to your logged-in browser sessions carries real operational risk. `remote-hands` is built on a zero-trust model:

1. **Deny-on-Timeout**: If an approval request is not explicitly confirmed within the timeout window, the action is automatically denied. Silence is never treated as consent.
2. **Never Skips Permissions**: The runtime operates with strict permissions (`--dangerously-skip-permissions` is deliberately rejected).
3. **Four Database Invariants**:
   - **Append-only event log**: The `events` table has no `UPDATE` policy. Historical steps cannot be altered or rewritten.
   - **Immutable audit trail**: The `approvals` table has no `DELETE` policy.
   - **Machine isolation**: `tasks` cannot be queued onto a machine the authenticated caller does not own.
   - **Foreign key ownership guards**: Every foreign key into a user-owned row (`tasks.machine_id`, `events.task_id`, `approvals.task_id`, `tasks.parent_task_id`) is validated using `security invoker` functions to prevent cross-tenant forging.
4. **Mechanical Invariant CI Tests**: `supabase/tests/schema-invariants.test.ts` queries Postgres's `pg_constraint` catalog to ensure any future foreign key to user data has an ownership check in its `INSERT` policy.

Read [SECURITY.md](SECURITY.md) and [docs/architecture/control-plane.md](docs/architecture/control-plane.md) for threat model and schema details.

---

## Architecture

```text
┌─────────────────────────────────────────┐
│          Mobile Client (Phone)          │
│       Phone PWA (Vite / React)          │
└────────────────────┬────────────────────┘
                     │  HTTPS / WSS (/ws/tasks/:taskId)
                     ▼
┌─────────────────────────────────────────┐
│       Cloudflare Worker & DOs           │
│   Auth, D1 Database, TaskRoom DO Relay  │
└────────────────────▲────────────────────┘
                     │  Outbound WSS (/ws/machines/:machineId)
                     ▼
┌─────────────────────────────────────────┐
│          Local Machine Daemon           │
│   Task claim, frame capture & hooks     │
└────────┬───────────────────────┬────────┘
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│   Agent CLI     │     │  Local Chrome   │
│   (`agy`)       │     │  (Real profile) │
└─────────────────┘     └─────────────────┘
```

---

## Monorepo Layout

```text
remote-hands/
├── apps/
│   ├── cloudflare/           # Cloudflare Worker, D1 migrations & Durable Objects
│   └── web/                  # Phone-first PWA (Vite + React)
├── packages/
│   ├── shared/               # Shared domain contracts, Zod schemas, realtime envelope
│   ├── control-plane/        # Provider-neutral business rules & validation
│   ├── daemon/               # Local machine task supervisor & agy runner
│   └── cli/                  # One-command setup, deploy, and pairing CLI
├── supabase/                 # Optional self-hosted backend adapter
├── docs/
│   ├── architecture/         # System and control-plane architecture
│   └── development.md        # Local development setup
└── .github/
    └── workflows/ci.yml      # CI workflow
```

---

## Quickstart

### Prerequisites

- **Node.js**: `>=22.0.0`
- **Cloudflare Account**: Free plan (optional Supabase adapter available for custom deployments)

```bash
# Clone repository
git clone https://github.com/Kushal-Padshala/remote-hands.git
cd remote-hands

# Install dependencies
npm install

# Run test suite
npm test

# Typecheck workspace
npm run typecheck
```

---

## Acceptance Testing & Verification

Manual acceptance scripts and local verification playbooks:

- [WordPress Privacy Policy Acceptance Test](scripts/acceptance/wordpress-privacy-policy.md)
- [Running Local Free Stack Guide](scripts/acceptance/run-local-free-stack.md)

---

## Roadmap

- [x] **Phase 1: Foundation & Shared Contracts**
  - Monorepo workspace scaffolding with Node 22 & TypeScript strict
  - `@remote-hands/shared` contracts with Zod validation
  - Local daemon foundation, runtime metadata, task coordinator & safe `agy` runner
- [x] **Phase 2: Free Cloudflare control plane**
- [x] **Phase 3: Outbound daemon transport and live task rooms**
- [x] **Phase 4: Phone PWA and approval workflow**
- [x] **Phase 5: One-command setup CLI**
- [x] **Phase 6: End-to-end browser task acceptance test**

---

## Contributing

Review [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before opening pull requests.

## License

[MIT](LICENSE) © 2026 Kushal Padshala
