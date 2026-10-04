# Local development

This documents the setup for contributors. The default self-hosted control plane is Cloudflare (Workers, D1, Durable Objects); Supabase is retained as an optional backend adapter.

## Prerequisites

- **Node.js**: `>=22.0.0`
- **Docker** *(Optional)*: Only required if you are actively working on or testing the optional `supabase/` backend adapter.
- `gh`, the GitHub CLI, for opening pull requests.

## Install

```
npm install
```

This is an npm workspaces repo. One install at the root covers
`packages/shared` and the `supabase` test workspace.

## Start local Supabase

```
npm run db:start
```

The first run pulls several Docker images and takes a few minutes. When it
finishes it prints a table including the local API URL and two keys (an
anon key and a service role key).

Copy those into a `.env` file at the repo root — see `.env.example` for the
variable names (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`). `.env` is git-ignored; never commit it, and
never paste the printed keys into a tracked file, a commit message, or a PR
description. They are only ever valid for your local containers.

## Apply the schema

```
npm run db:reset
```

This applies every migration in `supabase/migrations` to your local
instance from scratch. Run it again whenever the schema changes or your
local database drifts from the migrations.

## Run the tests

```
npm run test
```

This runs every test project (`packages/shared` and `supabase`) through a
single root `vitest.config.mts`. The `supabase` project's tests exercise
row-level security against your local instance using the keys from `.env`,
so `db:start` and `db:reset` need to have already succeeded.

To run only the daemon foundation tests:

```
npm test -- packages/daemon
```

These tests do not launch `agy` or connect to Supabase. They exercise the
config parser, runtime metadata helper, in-memory task store, `agy` argument
builder, stream parser, and one-cycle daemon coordinator.

## Type-check

```
npm run typecheck
```

This builds every package's source with `tsc --build`, then runs each
package's `typecheck:tests` script, so both source and test files are
checked — including type-level assertions that fail if the hand-written
types in `packages/shared` drift from the SQL schema.

## Daemon development configuration

The daemon package reads its startup configuration from environment variables.
For local development, copy the daemon section from `.env.example` into your
git-ignored `.env` and adjust the machine name and workspace allowlist:

```
REMOTE_HANDS_SUPABASE_URL=http://127.0.0.1:54321
REMOTE_HANDS_SUPABASE_ANON_KEY=replace-me
REMOTE_HANDS_MACHINE_NAME=office-mac
REMOTE_HANDS_AGY_COMMAND=agy
REMOTE_HANDS_WORKSPACE_ALLOWLIST=/Users/you/projects/site:/Users/you/projects/app
REMOTE_HANDS_POLL_INTERVAL_MS=5000
REMOTE_HANDS_HEARTBEAT_INTERVAL_MS=15000
```

The current daemon foundation is intentionally injectable and test-first. It
does not yet start a long-running process, store credentials, subscribe to
Supabase Realtime, capture Chrome frames, or install a launchd agent.

## MCP computer tools, swift cache, warm agy session

### `rh mcp`

- `rh mcp serve` runs a stdio MCP server (the default subcommand) that hosts one long-lived computer session exposing the `desktop_*`, `browser_*` and `computer_batch` tools. It is meant to be launched by an MCP client, not by hand.
- `rh mcp install` registers the server with `agy` by running `agy mcp add rh-computer -- <node> <rh entry path> mcp serve`. It uses the node binary and `rh` entry file of the process that ran the command, so run it from the `rh` you want `agy` to use. It exits 1 with the `agy` error if registration fails (for example when `agy` is not on `PATH`). After registering, it adds `mcp(rh-computer/*)` to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` (created if missing) and in `~/.gemini/antigravity-ide/settings.json` when that file exists, because headless agy auto-denies MCP tool calls otherwise. The merge is additive (other keys and entries keep their order), a file that fails to parse is reported and left alone, and the first change to an existing file keeps a `settings.json.bak-rh-mcp` backup. It never adds `mcp(*)`. `rh permissions fix` includes the same rule.
- `rh mcp remove` runs `agy mcp remove rh-computer` and then removes exactly the `mcp(rh-computer/*)` rule.

Check the registration with `agy mcp list`.

### Installed `rh` runs a copied bundle

The installed `rh` binary runs the bundle copied to `~/.remote-hands/cli/index.js`, which this repo does not track. After `npm run build`, the new bundle is `packages/cli/dist/index.js`; it must be copied over `~/.remote-hands/cli/index.js` before the installed `rh` (and an `rh mcp install` run from it) picks up your changes. Keep a backup of the old bundle before overwriting it.

### Benchmark

```
node scripts/bench-actions.mjs [runs]
```

`runs` defaults to 5. It runs `rh desktop window list`, `rh desktop snapshot --no-ocr`, `rh browser tabs` and a cold `agy` turn (`gemini-3.8-flash`, low effort), and prints the median wall time in milliseconds for each. It uses the installed `rh` and `agy` from `PATH`. Run it once first so the swift cache is populated.

### Fast browser path

The `browser_*` computer tools drive the browser you already use through AppleScript: JavaScript runs in a specific tab through Apple Events, elements get stable ids, and the engine returns diffs. This avoids Chrome DevTools (which Chrome 136+ ignores for the default profile) and the slow accessibility walk.

**Which browsers.** Google Chrome, Brave Browser, Arc, Microsoft Edge and Safari are in the registry (`packages/daemon/src/browser/browsers.ts`). The target is the `RH_BROWSER` override when that browser is running, else the frontmost supported browser, else the first running one in that order. The engine never launches a closed browser.

**`RH_BROWSER`.** Set it to a browser name or alias (`chrome`, `brave`, `arc`, `edge`, `safari`, case-insensitive) to prefer that browser whenever it is running. It is read by the MCP server process (`rh mcp serve`), which agy spawns from the HUD's environment, so it must be in that environment (for example the environment the HUD service is started with). Setting it in an interactive shell does not reach the server.

**Tab pin.** `browser_focus` and `browser_open` pin the tab they show for 5 minutes (refreshed on each use), so later calls stay on it. The pin remembers which tab was in front when it was set: if you switch to another tab, the next `browser_snapshot` or `browser_find` drops the pin, follows your current tab and says `note: following your current tab`. Actions (`browser_click`, `browser_type`, `browser_do`) always act on the tab of the page last shown.

**`file:` URLs.** `browser_open` allows `http(s):`, `file:`, `data:` and `about:blank`. A malicious page could try to get the model to open and read local files through `browser_extract`. agy already has file tools, so this adds little exposure.

**Verification status (update after live run).** The AppleScript for Arc, Edge and Safari is written from the browsers' documented AppleScript dictionaries; Arc, Edge and Safari have not been run on this machine. Only browsers verified live are claimed supported. At the time of writing, tab listing was verified live on Chrome and Brave; JavaScript execution through the fast path has not been verified live yet (it needs the setting below enabled in a browser).

**One-time setup (per browser): `rh browser setup`.** JavaScript from Apple Events is off by default and macOS asks before any app may control a browser. `rh browser setup` walks you through both:

1. For every running supported browser it sends a harmless probe. macOS shows its own "wants to control <Browser>" prompt the first time: click Allow. If you had denied it, the command opens `System Settings > Privacy & Security > Automation` and re-checks after you press Enter.
2. If the setting is off it explains what it enables, asks `Enable it in <Browser> now? [Y/n]` (`--yes` skips the question) and turns it on by clicking the browser's `Allow JavaScript from Apple Events` menu item through System Events UI scripting. It reads the menu item's check mark first and clicks only when it is unchecked, then verifies with a probe. This needs the Accessibility permission Remote Hands already requests; if it is missing the command opens the Accessibility pane and says which switch to flip. Safari needs its Develop menu first (`Safari > Settings > Advanced > Show features for web developers`); if the menu item cannot be found the command prints the manual steps instead of changing anything.
3. Nothing is changed without a yes (or `--yes`), a browser that is not running is skipped (never launched), and a run without a terminal never prompts or changes anything. `rh browser setup --disable` turns the setting off again where it is on; `--browser <name>` limits the run.

`rh hud install`, `rh hud listen` and `rh setup` offer the same flow once, on a terminal, for browsers you have not decided on yet. Decisions are remembered in `~/.remote-hands/browser-setup.json` (`enabled`, `declined`, `manual`); a declined browser is not asked again automatically, only by running `rh browser setup`. The macOS Automation prompt belongs to the app that sends the Apple events (your Terminal when you run the command there); a HUD started from a LaunchAgent may show its own prompt the first time it controls a browser.

**Self-healing at task time.** Setup switches the setting on for every browser you have open and every Chrome profile in use. If you later give the HUD a task in a profile where it is still off (a profile that was not open during setup), the browser tools do not just fall back: for a browser you approved during `rh browser setup` (decision `enabled` in `~/.remote-hands/browser-setup.json`) they run the same setup for that profile automatically, once, then continue the task on the fast path and say `note: switched on fast browser control for this profile (one-time).` It never runs for a browser you declined or were never asked about, never asks questions, and never leaves you to click. If it cannot (for example the HUD process lacks the Accessibility permission) the task continues on the slower fallback with the reason in the note, and it is not tried again for 10 minutes so the screen never flashes repeatedly. Run `rh browser setup` in a terminal to fix the cause.

Manual equivalent: Chrome, Brave, Edge and Arc `<browser> menu bar > View > Developer > Allow JavaScript from Apple Events`; Safari `Develop > Allow JavaScript from Apple Events`.

**Check it.**

```
rh browser doctor [--json]
```

The installed `rh` only has `browser doctor` once the new bundle is copied to `~/.remote-hands/cli/index.js` (see "Installed `rh` runs a copied bundle" above); until then run it from the repo with `node packages/cli/dist/index.js browser doctor`.

For each registry browser it prints whether it is running and, for running browsers, whether Automation permission and the Apple Events JavaScript setting are in place (it evaluates the harmless JavaScript `1` on the front tab), plus the browser the HUD would target now and a summary line. A closed browser shows `not running` and is never probed or launched. A running browser with no open window shows that the setting is unknown. Failures print the exact remediation text. `--json` prints `{ target, browsers: [{ name, family, running, ready, code?, message? }] }`. The command only reads, always exits 0 (it is a diagnostic), and exits 1 only for a usage error.

**Fallback and its limits.** When the fast path is unavailable (setting off, permission denied, no supported browser running) the browser tools fall back to the older CDP and accessibility path. That path is slower, works for Chrome only, and supports fewer operations (`browser_do` accepts only `click`, `type` and `wait` there, and `submit` and `browser_extract` need the legacy driver's script support). The engine retries the fast path after a short back-off (about a minute), so enabling the setting takes effect without restarting anything.

**Security.** While "Allow JavaScript from Apple Events" is on, any app that has Automation permission for that browser can run JavaScript in your tabs, including logged-in sessions. Turn the setting off when you do not need it; `rh browser doctor` will then report the fast path as unavailable and the fallback applies.

**Benchmark.**

```
node scripts/bench-browser.mjs [runs]
```

`runs` defaults to 5 (anything but a positive integer is a usage error). It uses the built daemon (`npm run build` first) and times, against the target browser, `transport.evaluate(browser, null, '1')`, a full snapshot through `FastBrowserEngine`, and `engine.tabs()` (the engine is reset before every timed call, so nothing is cached), printing the median milliseconds and `ok/total` for each, and the first error for a row where every run failed. A snapshot installs small page globals (`__rhFast`, `__rhNavHooked`) in the active tab. If the fast path is unavailable it prints the remediation message instead and exits 0. It does not use the CDP fallback.

### Swift binary cache

Desktop actions that previously ran `swift -e <script>` (a compile on every call) now compile once with `swiftc -O` and run the cached binary. Per-call values are passed through environment variables; scripts whose values cannot be hoisted that way run uncached and are never written to disk.

- Location: `~/.remote-hands/swift-cache`, one directory per template hash. Override with `RH_SWIFT_CACHE_DIR`.
- Permissions: the cache and its entries are created with mode `0700`.
- A genuine `swiftc` compile error writes a `failed` marker that makes that template fall back to `swift -e` for 10 minutes; after that it is retried.
- The cache is safe to delete at any time. Binaries are rebuilt on the next call (the first call after deleting is slower).

### Warm agy session

The daemon keeps one long-lived `agy` process per HUD, using `--input-format stream-json --output-format stream-json`, instead of spawning a cold `agy -p` for every task.

- It is prewarmed when the HUD starts listening, with the HUD task mode, so the first task does not pay process start-up.
- Later tasks in the same conversation are sent to the same process.
- The process's working directory and `--add-dir` are fixed when it is spawned. A task with a workspace that the live process was not spawned in restarts the process once, in that workspace, and resumes the same conversation with `--conversation`. A task without a workspace reuses whatever process is live.
- A task's conversation id is honored. If it differs from the active conversation, or the live process is a fresh one with no history, the process is restarted with `--conversation <id>`, and the system prompt is not sent again.
- The hotkey starts a fresh conversation: the process is reset and a new one is prewarmed. An idle prewarmed process that has never served a turn is kept as is.
- Idle shutdown: the agy process is stopped after 10 minutes without a turn (`RH_HUD_AGY_IDLE_MS`, `0` keeps it forever). The countdown never runs during a turn, its timer is `unref`'d, and the next hotkey press prewarms a new process while you type. While idle the HUD is just the Node listener plus the Swift hotkey helper (about 70 MB together, 0.0% CPU measured with `ps`).
- Cancelling a HUD task kills the warm process group, drops the conversation history and prewarms a fresh process immediately.
- The warm process is spawned once, so it does not get the per-task `REMOTE_HANDS_TASK_ID` environment variable. The HUD adds a `Task id: <id>` line to every turn, and approvals must pass it as `rh approve "<action>" --task=<id> ...`.
- There is no per-turn timeout (`--print-timeout 0`); cancel is the way to stop a turn.
- The first turn of a new process is slow because `agy` loads its MCP servers (see the measurements in the fast HUD design spec).

## Regenerating types from the schema

```
npm run db:types
```

Writes `packages/shared/src/database.generated.ts` from your local
instance's current schema. Run this after adding or changing a migration,
then run `npm run typecheck` to confirm the hand-written types in
`packages/shared` still agree with it.

## Stopping

```
npm run db:stop
```

Stops the local Supabase containers. Your data persists across `db:start` /
`db:stop`; `db:reset` is what wipes it back to the migrations.

## If Docker is not running

`npm run db:start` fails outright — the Supabase CLI cannot reach the Docker
daemon. Start Docker Desktop (or your Docker daemon of choice) and run
`npm run db:start` again. Without Docker running you can still run
`npm run typecheck` and the `packages/shared` unit tests, but not the
`supabase` RLS test suite, which needs a live database.

If Docker *is* running but `db:start` fails with a container health-check
timeout (`LegacyHealthCheckTimeoutError`, `LegacyStatusDbNotReadyError`, or a
container-name conflict from a previous run), that's the CLI racing its own
~10-container stack rather than something wrong with this repo. Run
`npm run db:start` again; it is safe to retry.
