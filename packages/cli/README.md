# remote-hands (`rh`)

> **Send tasks to your computer from your phone. Watch your local agent execute them in your real, logged-in browser. Approve critical actions before they happen.**

[![npm version](https://img.shields.io/npm/v/remote-hands-cli.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/remote-hands-cli)
[![npm downloads](https://img.shields.io/npm/dm/remote-hands-cli.svg?style=flat-square&color=emerald)](https://www.npmjs.com/package/remote-hands-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-black.svg?style=flat-square&logo=node.js)](https://nodejs.org)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-100%25%20Free%20Tier-orange.svg?style=flat-square&logo=cloudflare)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9%20Strict-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org)

---

## What is remote-hands?

**`remote-hands`** (CLI command: `rh`) is an open-source, phone-operated control plane for autonomous coding and browser agents. It bridges your local machine (Mac, Linux, or Windows) with a responsive mobile web interface on your phone.

Unlike headless scrapers or blind cloud browser containers, `remote-hands` runs directly on your computer. Your agent automates your **real Chrome browser** with your active logins, cookies, and sessions intact—while streaming live visual frames to your phone. Whenever the agent attempts an irreversible action (such as executing payments, publishing live code, or modifying production databases), it pauses execution and asks for your explicit authorization on your phone.

---

## Key Features

- **📱 Mobile-First Remote Control**: Issue tasks to your computer from any iOS Safari or Android Chrome browser via a lightweight, installable PWA.
- **🌐 Real Logged-in Chrome Automation**: Uses your actual browser profile. No need to pass credentials, bypass CAPTCHAs, or manage headless session tokens.
- **🛡️ Human-in-the-Loop Approvals**: Zero-trust approval gate intercepts dangerous tool calls. Review live viewport frames and click "Approve" or "Deny" from your phone.
- **⏱️ Deny-on-Timeout Protection**: Unanswered authorization requests automatically abort after a configurable timeout window. Silence is never consent.
- **☁️ 100% Free Serverless Relay**: Backed entirely by Cloudflare's generous free tier (Cloudflare Workers, D1 SQL Database, and Durable Objects). Zero monthly hosting fees.
- **🔒 Zero-Trust End-to-End Security**: Devices pair using cryptographic Crockford Base32 tokens (`RH-XXXX-YYYY-ZZZZ`). Outbound-only WebSocket connections mean no router port forwarding or public firewall openings.
- **💻 macOS Clamshell Sleep Prevention**: Run `rh start` to automatically prevent system sleep and clamshell lid-close sleep so background agent tasks finish without disruption.

---

## Quickstart

### 1. Global Installation

Install globally using npm:

```bash
npm install -g remote-hands-cli
```

*Or use the zero-install runner:*

```bash
npx remote-hands-cli setup
```

### 2. Guided Setup (Automated Cloudflare Deployment)

Run the interactive setup wizard. It authenticates with Cloudflare, creates your free D1 database, deploys the backend relay Worker and phone PWA, and links your local computer:

```bash
rh setup
```

### 3. Start the Daemon

Start the background daemon with automated sleep prevention:

```bash
rh start
```

Scan the displayed QR code with your phone camera or visit the pairing URL to connect your mobile device.

---

## CLI Command Reference

| Command | Description |
|:---|:---|
| `rh start` | Starts the daemon with automated clamshell sleep prevention. Auto-runs setup if unconfigured. |
| `rh setup` | Guided wizard to deploy the free Cloudflare backend and provision the database. |
| `rh pair` | Generates a secure Crockford Base32 pairing code and terminal QR code. |
| `rh daemon` | Starts the local worker daemon directly without altering system sleep settings. |
| `rh doctor` | Diagnoses local prerequisites, Node.js version, Chrome profile path, and Cloudflare credentials. |

---

## Comparison: remote-hands vs Alternatives

| Feature | `remote-hands` (`rh`) | SSH / Mosh | ngrok / Tunnels | Tailscale / VPN | TeamViewer / VNC |
|:---|:---:|:---:|:---:|:---:|:---:|
| **Phone Interface** | Mobile PWA | Raw terminal text | Public URL | Private IP | Desktop screen |
| **Real Browser Profile** | ✅ Yes | ❌ No | ❌ No | ❌ No | ✅ Yes |
| **Human-in-the-Loop Gate** | ✅ Native | ❌ No | ❌ No | ❌ No | ❌ Manual |
| **Visual Frame Stream** | ✅ Low-bandwidth | ❌ No | ❌ No | ❌ No | ⚠️ Heavy video |
| **Zero Open Ports** | ✅ Outbound WSS | ❌ Port 22 | ✅ Outbound | ⚠️ WireGuard | ⚠️ Proprietary |
| **Hosting Cost** | $0 (Free Tier) | Requires VPS | $8 - $20/mo | Free / Paid | Expensive |

---

## How It Works: System Architecture

```text
┌─────────────────────────────────────────┐
│          Mobile Phone (PWA)             │
│   Task input, live frames & approvals   │
└────────────────────┬────────────────────┘
                     │ HTTPS / WSS
                     ▼
┌─────────────────────────────────────────┐
│     Cloudflare Worker & Durable Object  │
│   Auth, D1 Database, Task Room Relay    │
└────────────────────▲────────────────────┘
                     │ Outbound WSS
                     ▼
┌─────────────────────────────────────────┐
│          Local Computer Daemon          │
│   Task coordinator & frame capture      │
└────────┬───────────────────────┬────────┘
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│   Agent CLI     │     │  Local Chrome   │
│   (`agy`)       │     │  (Real Profile) │
└─────────────────┘     └─────────────────┘
```

1. **Phone PWA**: Sends instructions to your personal Cloudflare Worker.
2. **Cloudflare Worker & Durable Objects**: Securely queues tasks and relays live frames over WebSockets without retaining sensitive credentials.
3. **Local Daemon**: Maintains an outbound-only WebSocket connection to your Worker, claims queued tasks, and coordinates local tools.
4. **Local Chrome**: Operates with your existing user data directory so logged-in web applications work out-of-the-box.

---

## Security Model

- **Deny-on-Timeout**: All authorization gates fail closed. If your phone loses signal or the timer expires, the action is denied.
- **Machine Isolation**: Tasks are cryptographically locked to the pairing token of the authorized machine.
- **Append-Only Event Logs**: Execution histories and audit trails cannot be altered or rewritten.
- **No Inbound Open Ports**: The daemon connects outward to Cloudflare over secure WebSockets (`wss://`). Your router requires no port forwarding.

---

## Frequently Asked Questions (FAQ)

### Does remote-hands work when my laptop lid is closed?
Yes. When running `rh start` on macOS, sleep prevention is automatically enabled to prevent clamshell sleep, allowing long-running tasks to continue while your laptop is closed.

### Do I need a paid Cloudflare account?
No. `remote-hands` runs comfortably within Cloudflare's free limits (100,000 Worker requests/day and 5,000,000 D1 reads/month).

### Does remote-hands upload my passwords or cookies to the cloud?
No. Your browser profile, cookies, and local credentials stay on your physical computer. Only live task status, action descriptions, and screenshot frames are streamed to your phone.

---

## Contributing & Development

Contributions and bug reports are welcome!

```bash
git clone https://github.com/Kushal-Padshala/remote-hands.git
cd remote-hands
npm install
npm test
npm run typecheck
```

## License

[MIT License](LICENSE) © 2026 Kushal Padshala
