# Running the Complete Free Stack Locally

This guide describes how to run the full Cloudflare-compatible stack locally for testing and verification without deploying to production Cloudflare accounts.

## Architecture Components

- **Control Plane**: Cloudflare Worker running locally via Wrangler with local D1 database.
- **Web App**: Vite React PWA running locally.
- **Machine Daemon**: Local daemon process executing tasks and streaming browser frames.

## Step 1: Start Local Cloudflare Worker

In terminal 1, run the local Cloudflare Worker with local D1 migrations applied:

```bash
cd apps/cloudflare
npx wrangler dev --port 8787 --local
```

Verify the health check responds:
```bash
curl http://localhost:8787/health
```

## Step 2: Start Phone PWA

In terminal 2, start the Vite development server:

```bash
cd apps/web
npm run dev -- --host 0.0.0.0 --port 5173
```

Open `http://localhost:5173` on your browser or phone on the same local network.

## Step 3: Run One-Command Setup

In terminal 3, run the setup wizard or configure the daemon directly:

```bash
rh setup
```

Provide `http://localhost:8787` when prompted for the control plane URL.

Alternatively, create `~/.remote-hands/daemon.json` manually:

```json
{
  "control_plane_url": "http://localhost:8787",
  "machine_id": "local-machine-01",
  "session_token": "<token-from-pairing>"
}
```

## Step 4: Start Machine Daemon

In terminal 3, start the daemon:

```bash
npx remote-hands daemon
```

The daemon connects outbound to `http://localhost:8787`, registers as online, and begins polling/listening for tasks.

## Step 5: Execute Test Task

1. Open `http://localhost:5173` in your browser.
2. Verify the machine indicator displays **online**.
3. Type a task prompt (e.g. `Navigate to https://example.com`) and click **Send Task**.
4. Confirm live updates appear in real time over the WebSocket connection.
