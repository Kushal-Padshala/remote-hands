# remote-hands — Design

**Date:** 2026-09-16
**Status:** Approved for planning
**Repository:** https://github.com/Kushal-Padshala/remote-hands

---

## 1. Summary

`remote-hands` lets you send a task to your own computer from your phone, watch
the agent carry it out on your real logged-in browser, and approve or reject
anything irreversible before it happens.

The name comes from the datacenter term: "remote hands" is the person physically
at the machine doing work on your behalf. Here your own laptop plays that role.

The agent is Antigravity's CLI (`agy`). The browser control is `browser-harness`
from the browser-use project. Neither is reimplemented. What this project builds
is the layer that connects them to a phone: a task inbox, a live visual stream of
what the browser is doing, and a gate that stops the agent before it publishes,
sends, pays, or deletes.

### The task this must complete end to end

From a phone, away from home, laptop awake under `caffeinate`:

> "Add a privacy policy page to my WordPress site."

The task reaches the laptop. `agy` drafts the policy text. `browser-harness`
opens the already-signed-in `wp-admin` in the real Chrome profile. The phone
shows each step as it happens, with a screenshot. Before the Publish click the
agent stops and the phone asks for approval. On approval the page goes live and
the phone shows the URL.

This scenario is the project's acceptance test. It is not done until this works.

---

## 2. Why this project exists

Both halves of this problem are solved products. The combination is not.

**Remote control of a coding agent from a phone** shipped everywhere during
2026: Claude Code `/remote-control`, Codex, Cursor, Warp, and Antigravity's own
`agy remote-control`. Open-source equivalents include agent-os, Pocket-Server,
Omnara and several Telegram bridges.

**Agentic control of your own signed-in browser** also shipped: Chrome added a
native remote-debugging toggle for agents in March 2026, and browser-harness,
Browser Use Terminal, agent-browser, ego lite and Hermes all build on it.

What no shipped product combines:

| | phone | your own signed-in Chrome | live visual | approval gate |
|---|---|---|---|---|
| Antigravity Remote Control | yes | no | terminal text | yes |
| Omnara / agent-os / Warp | yes | no | terminal text | yes |
| agent-browser dashboard | no | yes | yes | yes |
| Browser Use Cloud | yes | no, cloud browser | yes | yes |
| **remote-hands** | yes | yes | yes | yes |

The gap is specific: every remote-control product streams a terminal transcript.
For browser work a transcript is close to useless — `click_at_xy(412, 380)` does
not tell you the agent is one pixel from publishing to your live site. Seeing the
page, and being able to stop it, is the product.

### Honest scope

For a task that is only code, `agy remote-control` already does this well and
costs nothing. `remote-hands` earns its place on browser tasks, on mixed tasks
("fix the checkout bug, then log into staging and verify it"), and on the
approval gate. The README will say exactly this rather than claim to beat Google
at remote coding.

---

## 3. Verified assumptions

Everything below was checked against the installed tooling on 2026-09-16, not
recalled. Re-verify before implementation if `agy` has been updated.

### `agy` — Antigravity CLI, v1.2.4, at `~/.local/bin/agy`

| Capability | Mechanism |
|---|---|
| Headless single prompt | `agy -p "<prompt>"` |
| Machine-readable output | `--output-format json` or `stream-json` |
| Streaming input | `--input-format stream-json` (NDJSON on stdin, one turn per line) |
| Resume a thread | `--conversation <id>`; the id is returned in the result |
| Workspace selection | `--add-dir` (repeatable), `--project` |
| Execution mode | `--mode plan` or `--mode accept-edits` |
| Model / effort | `--model`, `--effort low|medium|high` |
| Timeout | `--print-timeout` (default 5m) |
| Permission bypass | `--dangerously-skip-permissions` — **deliberately not used** |
| Hooks | Claude-Code-compatible `hooks.json`, incl. `PreToolUse` with allow/deny decisions |
| Permission policy | `settings.json` `permissions.allow`, entries like `command(npm install)` |
| MCP | `agy mcp add/remove/list` |

Confirmed working:

```
$ agy -p "Reply with exactly: PONG" --model gemini-3.8-flash-low --output-format json
{"conversation_id":"fe78bbaa-...","status":"SUCCESS","response":"PONG\n",
 "duration_seconds":4.7,"num_turns":1,"usage":{...}}
```

Confirmed constraint — headless mode cannot prompt, so unallowed tools are
auto-denied:

> `no output produced — a tool required the "command" permission that headless
> mode cannot prompt for, so it was auto-denied.`

This constraint is the reason the approval gate is built on hooks rather than on
interactive prompts.

**`agy` has no browser tools in headless mode.** Asked directly, it reports only
`read_url_content` and `search_web`. The IDE has real browser control (there is a
Chromium profile at `~/.gemini/antigravity-browser-profile` with Chrome's
agentic-browsing data), but the CLI does not, and `agy remote-control` drives a
CLI session. Supplying browser capability is this project's job.

Config locations: global `~/.gemini/antigravity-cli/settings.json`, project
overrides in `~/.gemini/config/projects/`, shared hooks at
`~/.gemini/config/hooks.json`, workspace hooks at `<workspace>/.agents/hooks.json`.
Project config takes precedence over global.

### `browser-harness` — browser-use

Installed with `uv tool install --python 3.12 browser-harness`, registered as a
skill whose body is the output of `browser-harness skill`.

- Runs Python via heredoc; helpers pre-imported: `page_info()`, `new_tab(url)`,
  `goto_url(url)`, `list_tabs()`, `switch_tab()`, `current_tab()`, `click_at_xy(x, y)`,
  `js(...)`, and raw `cdp(method, **params)`.
- Attaches to the running Chrome over CDP — the real profile, the real logins.
- **Operates in the background.** Tab attachment and screenshots do not bring
  Chrome to the foreground. This is what makes unattended operation possible.
- A persistent daemon holds the connection across separate CLI invocations.
- Has its own local recording feature, off by default, saving screenshots and
  traces to disk. That is after-the-fact and local; it is not a substitute for
  streaming to a phone.

### Environment

Node 22.22, Python 3.14 plus 3.12, `uv` 0.11.6, Google Chrome, `gh` authenticated
as `Kushal-Padshala`.

---

## 4. Architecture

```
  PHONE (PWA)                SUPABASE                    MAC (daemon)
  ───────────                ────────                    ────────────
  submit task  ──────────▶  tasks          ──realtime──▶  claim task
                                                              │
  event timeline ◀──realtime── events  ◀──insert────────  agy -p --output-format
                                                          stream-json
  live frames  ◀──broadcast── (ephemeral)  ◀────────────  CDP Page.startScreencast
                                                              │
  approve/reject ─────────▶  approvals  ◀──poll/realtime─  PreToolUse hook
                                            (blocks)          │
                                                          browser-harness
                                                              │
                                                          real Chrome, your logins
```

Five units, each independently testable.

### 4.1 Control plane — Supabase

The only server-side component. Postgres for state, Realtime for both directions,
Auth for identity, Storage for the few images that must persist.

No custom backend. This keeps self-hosting to "create a Supabase project, run the
migrations."

### 4.2 Host daemon — `packages/daemon` (TypeScript, Node 22)

A long-running process on the Mac, installed as a launchd agent.

Responsibilities:

1. Authenticate as the user and register this machine.
2. Heartbeat `machines.last_seen_at` every 15s.
3. Subscribe to `tasks` for this machine; claim queued rows atomically.
4. Spawn `agy` with the right flags, workspace, hooks and permission policy.
5. Parse `stream-json` on stdout, translate each record into an `events` row.
6. Hold a second, independent CDP connection to Chrome for the screencast.
7. Relay frames to the phone over a Realtime broadcast channel.
8. Report terminal status, the `conversation_id`, and a result summary.

TypeScript rather than Python so the daemon, the web app and the shared event
types are one language and one test runner. `browser-harness` remains a Python
tool invoked as a subprocess by the agent — the daemon never calls it directly.

### 4.3 Agent runner

Builds the `agy` invocation per task:

```
agy -p "<prompt>"
    --output-format stream-json
    --add-dir <workspace>        # coding tasks
    --conversation <id>          # follow-ups in the same thread
    --mode accept-edits|plan
    --model <model> --effort <effort>
    --print-timeout <n>
```

Never `--dangerously-skip-permissions`. Instead the daemon writes a per-task
settings and hooks pair so that ordinary, reversible tool calls are pre-allowed
and risky ones route to the phone. Auto-denial of anything unclassified is the
safe failure mode, and it is the behavior `agy` already has.

### 4.4 Browser layer

The agent drives the browser itself, through the `browser-harness` skill. The
daemon only watches.

Watching is done with CDP `Page.startScreencast`, not a screenshot timer:

- Chrome pushes a `Page.screencastFrame` event whenever the page actually
  changes, so frames arrive on action rather than on a clock.
- Parameters: `format: "jpeg"`, `quality: 50`, `maxWidth: 720`, `maxHeight: 1280`.
  Each frame lands around 40–80 KB.
- Every frame is acknowledged with `Page.screencastFrameAck`; unacknowledged
  frames stop the stream.
- The daemon throttles to at most one frame per 500 ms and drops duplicates.

A typical 40-step task produces tens of frames, not the 1,200 a 2-second timer
would produce over the same period.

**Why not capture the macOS screen.** A full-screen capture needs Screen
Recording permission, and it returns black when the display sleeps — which is
exactly the situation this product is for. CDP frames keep working with the lid
closed. They are also smaller, and each one can be labeled with the action that
produced it.

### 4.5 Phone app — `apps/web` (Vite + React + TypeScript, PWA)

A static single-page app talking directly to Supabase. Hosted anywhere; Vercel
static by default. No server of its own.

Screens: machine list, new task, live task view, history.

The live task view switches renderer by task type:

| Task type | What it renders |
|---|---|
| Browser | latest frame, action label, step list, approval sheet |
| Coding | files touched, per-file diff, command output, test results |
| Mixed | one interleaved timeline of both |

One event pipeline, three renderers. Diffs are text and cost almost nothing.

---

## 5. Data model

All tables carry `user_id uuid not null references auth.users`, and every RLS
policy is `user_id = auth.uid()` for select, insert, update and delete. There is
no service-role access from any client or from the daemon.

```sql
machines (
  id uuid pk, user_id uuid, name text, hostname text,
  agy_version text, daemon_version text,
  status text,            -- online | offline
  last_seen_at timestamptz, created_at timestamptz
)

tasks (
  id uuid pk, user_id uuid, machine_id uuid,
  prompt text, kind text,             -- browser | coding | mixed | auto
  workspace_path text, model text, effort text, mode text,
  status text,   -- queued | claimed | running | awaiting_approval
                 -- | done | failed | cancelled
  conversation_id text,               -- agy thread, enables follow-ups
  parent_task_id uuid,
  result_summary text, error text,
  created_at, started_at, finished_at timestamptz
)

events (
  id bigint pk, task_id uuid, user_id uuid, seq int,
  kind text,     -- agent_text | thinking | tool_call | tool_result
                 -- | file_diff | command_output | browser_action
                 -- | status | approval_requested | error | result
  payload jsonb, created_at timestamptz
)

approvals (
  id uuid pk, task_id uuid, user_id uuid,
  action_kind text,      -- publish | send | pay | delete | push | shell | other
  summary text,          -- human sentence: "Click Publish on wp-admin post 412"
  risk text,             -- low | medium | high
  tool_payload jsonb,    -- the exact call being gated
  frame_path text,       -- Storage path to the screenshot at decision time
  decision text,         -- pending | approved | rejected | expired
  decided_at timestamptz, expires_at timestamptz, created_at timestamptz
)
```

`(task_id, seq)` is unique on `events`, so the phone can order and de-duplicate
without trusting arrival order.

### What is deliberately not stored

Live frames are never written to Postgres or Storage. They go out over a Realtime
broadcast channel `task:<id>:frames` and are gone. If the phone is not watching,
they are lost, which is correct — they are a live view, not a recording.

Two exceptions persist to Storage:

1. **Approval frames.** You must be able to see what you are approving even if
   you open the app a minute later. A handful of images per task.
2. **An opt-in recording**, off by default, for tasks where you want the replay.

A `pg_cron` job deletes approval frames after 24 hours and recordings after 7
days, and a per-user cap rejects new frames past a configured budget. This keeps
the whole system inside Supabase's free tier — 1 GB storage, 5 GB egress — which
a 2-second full-screen timer would have exhausted in under a day at roughly
2.6 GB.

---

## 6. The approval gate

The default policy is **pause on writes**: anything that publishes, sends, pays,
deletes, pushes or is otherwise hard to undo stops and asks. Everything
reversible — reading, navigating, searching, editing files in a git working tree
— runs without interruption.

The two alternatives were considered and rejected for the default. Pausing on
every step makes a forty-step task unusable. Never pausing means one bad click is
live on your site with no recourse, which removes the product's reason to exist.
Both remain available as per-task settings.

### Mechanism

A `PreToolUse` hook, registered in the per-task `hooks.json`. `agy` supports the
Claude-Code-compatible hook schema, and pre-tool hooks return an allow/deny
decision.

The hook binary:

1. Reads the pending tool call from stdin.
2. Classifies it against the risk rules.
3. Low risk, returns allow immediately — no round trip, no latency.
4. Otherwise: captures the current browser frame over its own CDP connection
   (not through `browser-harness`, which is mid-call), writes it to Storage, inserts
   an `approvals` row, sets the task to `awaiting_approval`, and blocks.
5. Waits for a decision, then returns allow or deny to `agy`.
6. On timeout (default 10 minutes) marks the approval `expired` and **denies**.

Denying on timeout rather than allowing is the only defensible default: the whole
point is that you are not there.

### Risk rules

Shipped as a versioned, user-editable file rather than compiled in.

- **Shell commands** — deny-list by pattern: `git push`, `rm -rf`, `npm publish`,
  `gh release`, `curl -X POST|PUT|DELETE`, anything touching `~/.ssh`, `sudo`.
- **Browser actions** — the agent reaches the browser through a bash call to
  `browser-harness`, so v1 classifies the script text: a click whose target
  accessibility name matches `publish|submit|send|delete|pay|order|buy|confirm|
  transfer|deactivate`, any `js(...)` that submits a form, any navigation to a
  known-destructive admin path.
- **Per-domain policy** — e.g. always ask on `*.wordpress.com`, never ask on
  `localhost`.

**Known limitation, v1.** Pattern-matching a Python script inside a bash command
is coarse. It can miss a destructive click phrased unusually, and it can stop a
harmless one. Milestone 7 replaces it with a thin wrapper around
`browser-harness` that classifies at the helper-call level and emits structured
`browser_action` events at the same time. The wrapper is the right answer; the
pattern matcher is what makes v1 shippable, and it fails toward asking rather
than toward acting.

---

## 7. Security model

This project runs an autonomous agent on a personal machine with access to the
filesystem and to logged-in browser sessions. The blast radius of a mistake or a
compromised credential is the user's email, source control, hosting and banking
sessions. The README will state this in the first paragraph.

Design consequences, all non-negotiable:

1. **No service-role key ever leaves Supabase.** The daemon authenticates as the
   user through a device-pairing flow and holds a refresh token in the macOS
   Keychain. A leaked daemon token grants exactly what one user can do, and can
   be revoked from the dashboard.
2. **RLS on every table from the first migration**, never added later. The repo
   is public; a default-open schema would be copied by everyone who forks it.
3. **`--dangerously-skip-permissions` is never used by the daemon.** The
   allowlist plus the hook is the mechanism. Auto-deny is the failure mode.
4. **Approval is required by default, not opt-in.**
5. **No secrets in the repo.** `.gitignore` covers `.env*` from the first commit;
   CI runs a secret scan; `.env.example` documents every variable.
6. **Frames may contain anything on screen** — inbox, banking, private repos.
   They are ephemeral by default for this reason, and the opt-in recording says
   so at the toggle.

**Immediate action, outside the repo.** The Supabase personal access token
`sbp_a5e2…` is stored in plaintext at `~/.gemini/config/mcp_config.json`. It is
account-scoped, not project-scoped — it can create and delete projects. It should
be rotated at supabase.com/dashboard/account/tokens and referenced from an
environment variable before this project is wired to that account.

---

## 8. Repository layout

```
remote-hands/
├─ apps/web/                 Vite + React PWA
├─ packages/daemon/          Node daemon, launchd integration
├─ packages/hook/            PreToolUse approval hook binary
├─ packages/shared/          event/task types, risk rules schema
├─ supabase/migrations/      SQL, RLS, pg_cron jobs
├─ docs/                     setup, self-hosting, security, architecture
└─ .github/workflows/        typecheck, test, secret scan
```

pnpm workspaces. Vitest throughout.

---

## 9. Testing

| Layer | Approach |
|---|---|
| `stream-json` parsing | Recorded fixtures from real `agy` runs, replayed |
| Daemon lifecycle | A fake `agy` binary emitting scripted NDJSON |
| Risk classification | Table-driven cases, both directions, including near-misses |
| Approval flow | Integration test against a local Supabase, hook blocks and resolves |
| RLS | A second user must see zero rows — asserted, not assumed |
| Frame pipeline | Synthetic screencast frames, assert throttle and de-duplication |
| Acceptance | The WordPress scenario against a local WordPress in Docker |

The WordPress acceptance test runs against a throwaway local install, so it can
live in CI without touching a real site.

---

## 10. Milestones

Sequenced so each one ends with something demonstrable. Every milestone is many
small commits, not one.

| # | Milestone | Ends when |
|---|---|---|
| 0 | Scaffolding — workspace, licence, README, CI, `.gitignore` | CI green on an empty tree |
| 1 | Supabase schema, RLS, migrations, seed | A second user provably sees nothing |
| 2 | Shared types and event contract | Types compile against real fixtures |
| 3 | Daemon: pairing, keychain, registration, heartbeat | Machine shows online in SQL |
| 4 | Task claim and `agy` runner, `stream-json` to events | Coding task runs from a SQL insert |
| 5 | Phone PWA: auth, machines, submit, timeline | Coding task driven from a phone |
| 6 | Browser: harness check, CDP screencast, frame relay, viewer | Browser task watched live on a phone |
| 7 | Approval gate: hook, rules, UI, wrapper for precise classification | Publish click gated and approved from a phone |
| 8 | Coding renderer: diffs, command output, tests | Diff readable on a phone |
| 9 | Retention: `pg_cron`, caps, cleanup | Storage flat across a week of use |
| 10 | Docs, self-host guide, demo GIF, acceptance test in CI | WordPress scenario passes end to end |

---

## 11. Open questions

1. **Chrome throttles background tabs.** Screencast frames may slow or stall when
   the display sleeps. Mitigations to test in milestone 6: launching Chrome with
   `--disable-background-timer-throttling --disable-backgrounding-occluded-windows
   --disable-renderer-backgrounding`, `caffeinate -dimsu`, and
   `Emulation.setFocusEmulationEnabled` around focus-gated pages. If frames still
   stall, fall back to explicit `Page.captureScreenshot` after each action.
2. **Realtime broadcast payload ceiling.** 40–80 KB JPEGs should fit, but the
   limit must be measured rather than assumed, with automatic quality reduction
   if it is approached.
3. **Multiple concurrent tasks share one Chrome.** browser-harness warns that two
   agents switching tabs at once will race. v1 serializes browser tasks per
   machine; parallel browser work is out of scope.
4. **Follow-up prompts mid-task.** `--input-format stream-json` accepts one turn
   per line on stdin, which would allow steering a running task from the phone
   rather than only aborting it. Deferred past milestone 10, but the daemon's
   process handling should not make it impossible.
