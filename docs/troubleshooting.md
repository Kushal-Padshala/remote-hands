# Troubleshooting Guide

Common issues, diagnostic steps, and resolutions for `remote-hands`.

---

## 1. Wrangler Login Failure

### Symptoms
- `remote-hands setup` halts at Wrangler login.
- Error message: `Authentication failed` or browser window fails to open.

### Resolution
1. Verify browser access and run Wrangler login manually:
```bash
npx wrangler login
```
2. If working on a headless machine or SSH session, generate an API token in Cloudflare Dashboard (Workers & D1 template) and set:
```bash
export CLOUDFLARE_API_TOKEN="your-token"
```

---

## 2. D1 Database Creation Failure

### Symptoms
- `wrangler d1 create` fails with permission errors or naming conflicts.

### Resolution
1. Verify existing D1 databases in your account:
```bash
npx wrangler d1 list
```
2. If `remote-hands-db` already exists, bind the existing database ID in `apps/cloudflare/wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "remote-hands-db"
database_id = "<existing-database-id>"
```
3. Run migrations against the database:
```bash
npx wrangler d1 migrations apply remote-hands-db --remote
```

---

## 3. Worker Deployment Failure

### Symptoms
- `wrangler deploy` fails with syntax or compatibility errors.

### Resolution
1. Ensure Node.js version is `>= 22.0.0`:
```bash
node --version
```
2. Ensure TypeScript build succeeds locally:
```bash
npm run typecheck
```
3. Check Wrangler output for specific configuration issues:
```bash
cd apps/cloudflare && npx wrangler deploy --dry-run
```

---

## 4. Pairing Code Expiration

### Symptoms
- `remote-hands pair <code>` returns `404 Not Found` or `Invalid or expired pairing code`.

### Resolution
- Pairing codes are time-limited (10-minute validity window) and single-use for security.
- Return to your phone PWA and tap **Generate New Code**.
- Run `remote-hands pair <new-code>` promptly within the 10-minute window.

---

## 5. Machine Shows Offline on Phone

### Symptoms
- The phone PWA dashboard shows the paired machine as `offline`.

### Resolution
1. Check whether the local machine daemon is running:
```bash
ps aux | grep "remote-hands daemon"
```
2. Start the daemon in verbose mode to view connection logs:
```bash
remote-hands daemon --verbose
```
3. Verify your laptop has an active internet connection. The daemon maintains an outbound heartbeat over WebSocket; if your laptop enters sleep mode, the daemon reconnects automatically upon wake.

---

## 6. Phone Cannot Connect to Control Plane

### Symptoms
- Phone PWA shows network error or loading spinner indefinitely.

### Resolution
1. Open the Worker `/health` endpoint in your phone browser:
   `https://<your-worker>.<subdomain>.workers.dev/health`
2. Expected response is `{"status":"ok"}`.
3. Check whether your phone has an active data connection or VPN that blocks WebSocket connections (`wss://`).

---

## 7. Approval Request Timed Out (Deny-on-Timeout)

### Symptoms
- Task status changes to `failed` with message `Approval request timed out`.

### Resolution
- In accordance with the security model, sensitive actions (e.g. publishing, purchasing, sending emails) require explicit human confirmation.
- The approval gate applies a strict 5-minute timeout window. If no approval is received within 5 minutes, the action is automatically denied to prevent unauthorized or unintended operations.
- To re-run the task, submit it again from the phone PWA and confirm the action when prompted.

---

## 8. Cloudflare Free Tier Limits

### Symptoms
- Error `10048: Worker exceeded daily request limit`.

### Free Plan Limits
- **Workers Requests**: 100,000 requests per day (resets daily at 00:00 UTC).
- **D1 Database Reads**: 5,000,000 rows read per day.
- **D1 Database Writes**: 100,000 rows written per day.

### Optimization
- A typical task uses under 50 requests and approximately 100 database rows.
- The free plan easily supports 1,000+ tasks per day for a personal setup.
- If you exceed these limits, consider batching tasks or upgrading to Cloudflare Workers Paid ($5/month).

---

## 9. Alternative Backends

Neither a Supabase project, a Vercel deploy, nor local Docker containers are required for the standard free architecture. However, if you self-host via Docker or utilize the optional Supabase adapter located in `supabase/`, refer to [docs/architecture/control-plane.md](architecture/control-plane.md).
