# Remote Hands 📱 💻

> **Open-source autonomous AI agent control plane for mobile-to-desktop computer use.**  
> Dispatch tasks from your phone, watch the agent work in your real, signed-in Google Chrome browser and terminal via live screen streaming, and approve high-risk actions with a zero-trust human-in-the-loop gate.

[![npm version](https://img.shields.io/npm/v/remote-hands-cli.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/remote-hands-cli)
[![CI](https://github.com/Kushal-Padshala/remote-hands/actions/workflows/ci.yml/badge.svg)](https://github.com/Kushal-Padshala/remote-hands/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-black.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9%20strict-blue.svg)](https://www.typescriptlang.org)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20%7C%20D1%20%7C%20DOs-orange.svg)](https://workers.cloudflare.com)
[![Chrome CDP](https://img.shields.io/badge/Browser-Chrome%20CDP-brightgreen.svg)](https://chromedevtools.github.io/devtools-protocol/)

---

```console
$ remote-hands daemon
[10:14:02] daemon online • macbook-pro (arm64) • pairing active
[10:14:06] task from phone: "Publish privacy policy update on WordPress"
[10:14:07] chrome attached (profile: "Work", debugging-port: 9222)
[10:14:10] wp-admin opened • session active (logged in as admin)
[10:14:12] drafting policy text via agy... done (840 words)
[10:14:15] ⚠️  APPROVAL REQUIRED: agent is about to click "Publish"
[10:14:15] waiting for phone authorization (deny-on-timeout: 05:00)...
[10:14:24] ✓ approved from iPhone
[10:14:25] published: https://example.com/privacy-policy (status: 200 OK)
```

---

## Why Remote Hands?

Traditional remote terminal bridges work for text-only coding tasks, but break down entirely for web and everyday business workflows. A terminal transcript displaying `click_at_xy(412, 380)` gives you zero visibility into whether an agent is one click away from charging a credit card or accidentally deleting a production database.

**Remote Hands** solves this by uniting local autonomous agent execution (`agy`), real signed-in Chrome browser automation via Chrome DevTools Protocol (CDP), real-time visual screen streaming, and an intercepting human-in-the-loop approval gate.

### Feature Comparison

| Feature | Remote Hands | Claude Computer Use | Cloud Browsers (Browserbase/Steel) | Terminal Bridges (SSH/Ngrok) |
|:---|:---:|:---:|:---:|:---:|
| 📱 **Mobile Phone Control** | ✅ Native PWA | ❌ Desktop only | ⚠️ API only | ⚠️ Raw shell |
| 🌐 **Your Signed-in Chrome Profile** | ✅ Active cookies & 2FA | ❌ Ephemeral sandbox | ❌ Blank environment | ❌ No browser |
| 👥 **Multi-Profile Switching** | ✅ Work / Personal / FLCC | ❌ Single session | ❌ N/A | ❌ N/A |
| 📸 **Live Visual Frame Stream** | ✅ Sub-second WebSocket | ⚠️ Static screenshot cycle | ✅ High latency | ❌ Text only |
| 🛡️ **Zero-Trust Human Approval Gate** | ✅ Biometric / Mobile tap | ❌ Autopilot risk | ❌ No approval flow | ⚠️ Blind prompts |
| 💤 **Mac Clamshell Sleep Prevention** | ✅ Built-in `caffeinate` | ❌ Mac sleeps | ❌ N/A | ⚠️ Manual config |
| 💰 **100% Free Serverless Stack** | ✅ Cloudflare Free Tier | ❌ Per-token API cost | ❌ $20-$100/mo rental | ⚠️ VPS rental |
| 💻 **Self-Hostable & Open Source** | ✅ MIT Licensed | ❌ Proprietary | ❌ Proprietary | ✅ Open source |

---

## Everyday Use Cases

- **🚀 Staging & Production Deployments**: Dispatch preview builds to Vercel or AWS Console while commuting. The agent opens your signed-in dashboard, triggers deployment, and pings your phone with the live URL.
- **📋 Issue Triage & Daily Standup**: Ask the agent to summarize today's assigned Linear or Jira tickets, execute local test suites, and report blockers back to your phone.
- **📊 Admin, SaaS & Billing Operations**: Download AWS or Supabase billing invoices, inspect Stripe payout tables, or verify domain DNS settings without solving 2FA captchas every time.
- **✍️ CMS & Content Management**: Draft, edit, and schedule blog posts on WordPress, Ghost, or Substack with live visual inspection before hitting "Publish".
- **💻 Background Code Refactoring**: Queue complex code edits or test runs from your couch; your laptop completes the work with its lid closed.

---

## Core Capabilities

### 1. Real Logged-in Google Chrome Automation
Remote Hands connects directly to your desktop Chrome instance over CDP (`--remote-debugging-port=9222`). Your agent accesses active sessions on GitHub, Linear, AWS, Vercel, Supabase, Google Calendar, and Stripe without prompting you for credentials or 2FA codes.

### 2. Multi-Browser Profile Switcher
Manage multiple identities effortlessly:
```bash
# Discover all local Chrome profiles
rh profiles

# Launch daemon targeting a specific profile
rh start --browser-profile="Work"
rh start --browser-profile="Personal"
rh start --browser-profile="dedicated"
```

### 3. Sub-Second Real-Time Frame Streaming
The daemon captures browser tab frames and streams compressed visual updates through Cloudflare Durable Objects directly to your phone's browser, giving you real-time visual confirmation of agent actions.

### 4. Zero-Trust Human-in-the-Loop Interceptor
Whenever an agent prepares to execute an irreversible action (e.g. clicking "Publish", submitting financial forms, dropping tables, or pushing commits), execution pauses and sends an interactive approval request to your mobile device.

### 5. Clamshell Sleep Prevention
Running `rh start` or `remote-hands daemon` automatically invokes macOS power assertion controls (`caffeinate`), allowing your MacBook to process long-running jobs even when closed and unplugged.

---

## System Architecture

```text
┌────────────────────────────────────────────────────────┐
│               Mobile Client (Smartphone)               │
│            Phone-first PWA (React + Vite)              │
└───────────────────────────┬────────────────────────────┘
                            │  HTTPS / WSS (/ws/tasks/:taskId)
                            ▼
┌────────────────────────────────────────────────────────┐
│            Cloudflare Serverless Backend               │
│    • Workers: Session Auth, Task & Approval APIs       │
│    • D1 Database: Multi-tenant, owner-scoped SQLite    │
│    • Durable Objects: Realtime TaskRoom WebSocket hub  │
└───────────────────────────▲────────────────────────────┘
                            │  Outbound WSS (/ws/machines/:machineId)
                            ▼
┌────────────────────────────────────────────────────────┐
│                  Local Machine Daemon                  │
│       Task queue claim, screen capture, caffeinate     │
└─────────────┬────────────────────────────┬─────────────┘
              ▼                            ▼
┌───────────────────────────┐ ┌──────────────────────────┐
│   Autonomous Agent CLI    │ │   Desktop Google Chrome  │
│          (`agy`)          │ │    (Real user profile)   │
└───────────────────────────┘ └──────────────────────────┘
```

---

## Security Model & Zero-Trust Invariants

Operating an autonomous agent with access to desktop sessions requires airtight security:

1. **Deny-on-Timeout**: Unanswered approval requests automatically expire as denied. Silence is never treated as consent.
2. **Timing-Safe Cryptography**: Secrets, pairing codes, and tokens are validated with constant-time byte comparisons (`timingSafeEqualStr`).
3. **Workspace Traversal Prevention**: Strict allowlists prevent agents from being dispatched to system root (`/etc`, `/root`, `/bin`) or credential directories (`~/.ssh`, `~/.aws`).
4. **Machine Isolation & IDOR Protection**: D1 queries verify that callers own both the machine and the task before claiming or dispatching actions.
5. **Append-Only Event Ledger**: Historical agent actions cannot be overwritten or altered.
6. **Browser Flag Sanitization**: Launch arguments are sanitized to block arbitrary Chrome command-line flag injection.

---

## Monorepo Layout

```text
remote-hands/
├── apps/
│   ├── cloudflare/           # Cloudflare Worker backend, D1 SQLite migrations, Durable Objects
│   └── web/                  # Mobile-first PWA web application (React + Vite)
├── packages/
│   ├── shared/               # Shared TypeScript domain contracts, Zod schemas, security utilities
│   ├── control-plane/        # Provider-neutral business rules, state machines, and approval gates
│   ├── daemon/               # Local machine task supervisor, ChromeManager, and agy runner
│   └── cli/                  # One-command setup wizard, deployer, and pairing CLI (rh)
├── supabase/                 # Optional self-hosted PostgreSQL backend adapter
└── docs/                     # Architecture specifications, security review, and local setup
```

---

## Quickstart

### Prerequisites

- **Node.js**: `>=22.0.0`
- **Cloudflare Account**: Free plan (zero credit card required)
- **Google Chrome**: Desktop browser installed

### 1. Installation

Install globally via npm or run directly with `npx`:

```bash
# Global install (provides "rh" and "remote-hands" commands)
npm install -g remote-hands-cli

# Run the automated guided setup wizard
rh setup

# Or execute without installing
npx remote-hands-cli setup
```

### 2. Start the Daemon

```bash
# Start daemon with default profile and sleep prevention
rh start

# Or specify a custom Chrome profile
rh start --browser-profile="Work"
```

### 3. Open Mobile Interface

Scan the generated terminal QR code with your phone camera to pair your mobile browser with your computer.

---

## CLI Command Reference

| Command | Description |
|:---|:---|
| `rh setup` | Guided wizard: Cloudflare Worker deployment, D1 setup, and pairing |
| `rh start` | Launch the daemon with clamshell sleep prevention |
| `rh daemon` | Run the raw background daemon process |
| `rh profiles` | List all discovered local Google Chrome profiles |
| `rh doctor` | Diagnose system dependencies, Chrome CDP status, and network reachability |
| `rh pair` | Pair a new mobile device using a one-time code |

---

## Frequently Asked Questions (FAQ)

<details>
<summary><strong>How does Remote Hands access my signed-in accounts without storing passwords?</strong></summary>

Remote Hands attaches to your local Google Chrome user profile via Chrome DevTools Protocol (CDP) on `127.0.0.1:9222`. It runs on your computer and reuses existing browser cookies and session tokens. Passwords and session secrets are never sent to external servers.
</details>

<details>
<summary><strong>How is Remote Hands different from Claude Computer Use or Devin?</strong></summary>

Claude Computer Use and Devin run in ephemeral remote cloud virtual machines that start without your cookies, history, or credentials, requiring you to log in and solve 2FA captchas repeatedly. Remote Hands runs on your local machine where your active sessions already exist.
</details>

<details>
<summary><strong>Does Remote Hands require a paid cloud subscription?</strong></summary>

No. Remote Hands is designed to run entirely on Cloudflare's 100% Free Tier (Workers + D1 + Durable Objects) and your local computer. There are no mandatory subscription fees or hourly VM charges.
</details>

<details>
<summary><strong>Can the agent do dangerous things while I am away?</strong></summary>

No. The built-in human-in-the-loop approval gate intercepts high-risk browser clicks, file deletions, and terminal executions, prompting your phone with a screenshot and action summary before proceeding.
</details>

---

## Developer Setup & Contributing

```bash
# Clone the repository
git clone https://github.com/Kushal-Padshala/remote-hands.git
cd remote-hands

# Install workspace dependencies
npm install

# Run the full test suite
npm test

# Build all packages and applications
npm run build
```

Please review [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before submitting pull requests.

## License

[MIT](LICENSE) © 2026 Kushal Padshala
