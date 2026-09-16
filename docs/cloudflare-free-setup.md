# Free Cloudflare Setup Guide

Set up `remote-hands` with a 100% free Cloudflare backend in under 10 minutes.

No Supabase project, Vercel deploy, or Docker containers are required. Everything runs on Cloudflare's free tier and your local laptop.

---

## Prerequisites

- **Node.js**: `>= 22.0.0`
- **Cloudflare Account**: Free plan (no credit card required)
- **Anthropic / AI Agent**: `agy` CLI installed locally

---

## Quick Setup (10 Minutes)

### Step 1: Install remote-hands CLI

Install globally via npm or run directly with npx:

```bash
npm install -g remote-hands
```

### Step 2: Run Guided Setup

Run the interactive setup wizard:

```bash
remote-hands setup --free
```

The wizard guides you through:
1. **Wrangler Login**: Authenticates with your Cloudflare account via browser.
2. **D1 Database Creation**: Creates a free SQLite database named `remote-hands-db` and runs migrations automatically.
3. **Owner Secret Generation**: Generates a secure owner secret for your phone PWA.
4. **Worker Deployment**: Deploys the control plane worker and Durable Object task room to Cloudflare.
5. **Daemon Configuration**: Writes the configuration to `~/.remote-hands/daemon.json`.

### Step 3: Pair Your Phone

1. Open the deployed Worker URL printed by the setup wizard on your phone's browser (or add to home screen as PWA).
2. Enter the Owner Secret generated in Step 2.
3. Tap **Pair Machine** to generate a 6-digit pairing code.
4. In your laptop terminal, run:
```bash
remote-hands pair <code>
```
5. Your laptop and phone are now securely paired via encrypted session tokens.

### Step 4: Start the Daemon

Start the background daemon on your computer:

```bash
remote-hands daemon
```

The daemon connects outbound over WebSocket to your Cloudflare Worker. It does not open any incoming ports on your laptop.

---

## What is Running on the Free Tier?

- **Cloudflare Workers**: Handles REST API requests and WebSocket relays. Free plan includes 100,000 requests per day.
- **Cloudflare D1**: Serverless SQLite database storing tasks, events, and approvals. Free plan includes 5,000,000 read rows and 100,000 write rows per day.
- **Durable Objects**: Manages real-time WebSocket state and fanout for active tasks.
- **Static Phone PWA**: Built with Vite and React, served directly from the Worker or static host.
- **Local Machine Daemon**: Outbound-only Node 22 process driving Chrome and `agy`.

No paid subscriptions or cloud credit limits required.
