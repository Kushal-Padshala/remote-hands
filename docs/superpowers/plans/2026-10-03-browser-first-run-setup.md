# Browser First-Run Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Open-source users reach a working fast browser path with at most one macOS Allow click and one `y` per browser, via `rh browser setup` and automatic offers.

**Architecture:** A daemon-side `BrowserSetup` service inspects a browser (via the existing `AppleScriptTransport`), toggles its "Allow JavaScript from Apple Events" menu item through System Events UI scripting (check mark read first, idempotent), and verifies with a probe. A CLI flow (`rh browser setup`, plus a once-only offer from `rh hud install|listen` and `rh setup` on a TTY) drives prompts and a small state file.

**Tech Stack:** TypeScript (ESM, strict), Node 22, vitest 5, macOS `osascript`/System Events, `open x-apple.systempreferences:`.

**Spec:** `docs/superpowers/specs/2026-10-03-browser-first-run-setup-design.md`

## Global Constraints

- TS strict (check tsconfig.base.json flags), ESM `.js` suffixes; one test file at a time via `perl -e 'alarm 100; exec @ARGV' npx vitest run <path>` (macOS has no `timeout`; no `sed -i`; no watch mode).
- NEVER change a browser setting, open System Settings, or send Apple events to System Events or any browser during tests or development runs: everything goes through injected runners/fakes. The only real-machine commands allowed are read-only `rh browser doctor`-style probes already allowed earlier, and only if the task says so. Never launch Arc/Safari (`pgrep -x Arc Safari` must stay empty).
- AppleScript text built from registry constants only; no user data interpolated; argv for any variable.
- Opt-in only: nothing changes without an explicit yes or `--yes`; non-interactive contexts (no TTY) never prompt and never change settings.
- Never touch `~/.remote-hands` or `~/.gemini` in tests (inject fs).
- Commit after every green step with `git commit -m "..." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"` and `git push origin feat/fast-hud-computer-use`; never push red (tests + `npx tsc --noEmit -p packages/daemon/tsconfig.json` and `-p packages/cli/tsconfig.json`).

## Review Focus

- A closed browser must never be launched or probed.
- Never click a menu item unless the check mark was READ and shows unchecked (and the menu item title matches exactly); never toggle blindly (a second run must not turn the setting off).
- `--disable` turns it off only when currently checked.
- Declining is remembered and not re-asked automatically.
- No prompt and no setting change without a TTY (launchd HUD, CI).
- Error paths give exact next steps: Automation denied (open the Automation pane), System Events denied, Accessibility denied (open the Accessibility pane), menu item not found (Safari Develop menu missing; non-English UI), browser window missing.

---

### Task 1: `BrowserSetup` service (menu state/toggle, verification, panes, state file)

**Files:**
- Create: `packages/daemon/src/browser/setup.ts`, `setup.test.ts`
- Modify: `packages/daemon/src/index.ts` (export)

**Interfaces:**
- Consumes: `BrowserApp`, `BROWSERS`, `findBrowser` (`browsers.ts`), `AppleScriptTransport` (`evaluate`, `environment`), `BrowserAutomationError` + `classifyOsascriptError` (`applescript.ts`), the `RunOsascript` type (`transport.ts`).
- Produces:
  - `const JS_MENU_ITEM = 'Allow JavaScript from Apple Events'`
  - `type MenuState = 'checked' | 'unchecked' | 'missing'`
  - `type InspectStatus = 'ready' | 'js_disabled' | 'automation_denied' | 'no_window' | 'not_running' | 'error'`
  - `interface InspectResult { browser: string; status: InspectStatus; message: string }`
  - `type ToggleOutcome = { ok: true; changed: boolean; state: MenuState } | { ok: false; reason: 'system_events_denied' | 'accessibility_denied' | 'menu_missing' | 'not_running' | 'script_error'; message: string }`
  - `buildMenuStateScript(): string[]` and `buildMenuToggleScript(): string[]` (osascript `-e` lines; argv: browser process name; both guard on `application "<name>" is running` via argv-safe `application (item 1 of argv)`? — see note) — `buildMenuStateScript` prints one of `checked|unchecked|missing`; `buildMenuToggleScript` prints `clicked`.
  - `class BrowserSetup { constructor(deps: { transport: Pick<AppleScriptTransport,'evaluate'|'environment'>; run: RunOsascript; open?: (url: string) => Promise<void> }); inspect(b: BrowserApp): Promise<InspectResult>; menuState(b): Promise<MenuState | ToggleOutcome-failure>; enableJs(b): Promise<ToggleOutcome>; disableJs(b): Promise<ToggleOutcome>; openAutomationPane(): Promise<void>; openAccessibilityPane(): Promise<void> }`
  - State file helpers (fs injected via the `FileSystemAdapter` pattern already used in `packages/cli/src/cloudflare/project.ts`/`agy-permissions.ts`; if importing that type from the CLI package into the daemon would invert the dependency, define a minimal `{ readFile, writeFile, exists, mkdir }` interface in `setup.ts` and let the CLI pass an adapter): `interface SetupState { browsers: Record<string, { decision: 'enabled' | 'declined' | 'manual'; at: string }> }`, `readSetupState(fs, path): Promise<SetupState>` (missing/invalid file → empty state), `recordDecision(fs, path, browser, decision, now?)` (atomic write: temp file + rename; keep other entries), `shouldOffer(state, browserName): boolean` (true only when there is no entry).

UI-scripting rules: the menu item is located generically by searching `menu bar 1` of the browser's System Events process: for each menu bar item's `menu 1`, check its menu items for one named exactly `Allow JavaScript from Apple Events`, and one level deeper (submenu `menu 1` of a menu item, e.g. View > Developer, Safari's Develop). State = `value of attribute "AXMenuItemMarkChar"` of that item (a check mark character means checked; `missing value` means unchecked). The process name and application name are the registry `name`, passed through argv (`item 1 of argv`), never interpolated. The scripts must not launch a closed browser (`application (item 1 of argv) is running` guard first; raise `rh:not_running`). Classify osascript failures: `-1743` mentioning `System Events` → `system_events_denied`; messages containing `not allowed assistive access`, `-25211`, `-1719` or `assistive` → `accessibility_denied`; `rh:not_running` → `not_running`; `rh:menu_missing` → `menu_missing`; else `script_error` (condensed 200 chars).

- [ ] **Step 1: Failing tests** with an injected fake `run` (records lines/argv and returns scripted `{stdout,stderr,status}`) and a fake transport: `inspect` returns `not_running` without evaluating when the browser is not in `environment().running`; `ready` when `evaluate` resolves; maps `BrowserAutomationError` codes (`js_disabled`, `automation_denied`, `no_window`) to statuses with the error's message; `menuState` parses `checked|unchecked|missing`; `enableJs` reads state first and: unchecked → runs the toggle script then re-reads and returns `{ok:true,changed:true,state:'checked'}`; already checked → returns `{ok:true,changed:false}` WITHOUT running the toggle script (assert the toggle script was never run); `missing` → `{ok:false,reason:'menu_missing'}` with the Safari-specific message when the browser family is `safari` (mention Settings > Advanced > Show features for web developers) and a generic message otherwise (mention the browser may use a non-English UI); `disableJs` toggles only when checked; failure classification table (-1743 System Events, assistive access, rh:not_running, rh:menu_missing, unknown); argv is `[browserName]` exactly; the scripts text guards on `is running` and contains the exact menu title and `AXMenuItemMarkChar`, and contains no browser name literal; `openAutomationPane`/`openAccessibilityPane` call `open` with `x-apple.systempreferences:com.apple.preference.security?Privacy_Automation` / `...?Privacy_Accessibility`; state helpers: missing file → empty, invalid JSON → empty (never throws), `recordDecision` merges and writes atomically (temp + rename; assert both calls), `shouldOffer` truth table.
- [ ] **Step 2: Run each to see failure; implement `setup.ts`; run alone; `npx tsc --noEmit -p packages/daemon/tsconfig.json`; export from `index.ts`; commit + push.**
- [ ] **Step 3: Real-machine read-only sanity (optional, only if both of these succeed without prompting the user for anything):** run `buildMenuStateScript` via real osascript against a RUNNING Brave Browser or Google Chrome ONLY to read the check mark (never run the toggle script). If System Events is not authorised in this shell (`-1743`), record that and skip. Record the output in the report.

---

### Task 2: `rh browser setup` flow, automatic offers, messaging, docs

**Files:**
- Create: `packages/cli/src/commands/browser-setup.ts`, `browser-setup.test.ts`
- Modify: `packages/cli/src/commands/browser.ts` (dispatch `setup` before the Chrome readiness check, like `doctor`), `packages/cli/src/commands/hud.ts` (`install` and `listen` offer), `packages/cli/src/commands/setup.ts` (offer at the end), `packages/cli/src/commands/browser-doctor.ts` (hint text), `packages/daemon/src/browser/engine.ts` (fallback note text), `packages/cli/src/index.ts` (help text), their tests, `README.md`, `docs/development.md`

**Interfaces:**
- Consumes: `BrowserSetup`, state helpers, `AppleScriptTransport`, `BROWSERS`, `pickTargetBrowser` (Task 1 and earlier).
- Produces:
  - `browserSetupCommand(args: string[], context: BrowserSetupContext): Promise<number>` where `BrowserSetupContext extends CommandContext` adds optional injectables: `setup?: BrowserSetup`, `transport?`, `ask?: (question: string) => Promise<string>`, `isTTY?: boolean`, `fs?`, `statePath?`, `now?`.
  - `offerBrowserSetupOnce(context): Promise<void>`: no-op unless `isTTY`; for each running browser that `shouldOffer`, run the per-browser flow with prompts; records decisions.
  - Flags: `--yes` (answer yes to enabling), `--disable` (turn the setting off where currently on), `--browser <name>` (only that browser), `--json` is NOT needed. Exit code 0 unless usage error; 1 if the user asked for a specific browser and it could not be made ready.

Per-browser flow (`ensureBrowserReady(b)`): (1) `inspect(b)`; `not_running` → note `<Name> is not running (open it and run again)`, nothing else; `ready` → `✔ <Name> ready`, record `enabled` if not recorded; `automation_denied` → print the message, `openAutomationPane()`, ask `Press Enter after allowing it` and re-inspect once; `no_window` → note `open a normal window in <Name>` and stop; `js_disabled` → explain (what it enables, and the security note: while it is on any app with Automation permission can run JavaScript in your tabs), ask `Enable it in <Name> now? [Y/n]` (empty = yes; `--yes` skips the question); on yes call `enableJs(b)`: on `ok` re-`inspect` and print ✔ or the new status; on `{ok:false}` print the reason message plus the manual menu path, and for `accessibility_denied` / `system_events_denied` open the corresponding pane and print the one toggle to flip; on no record `declined` and print `You can run rh browser setup any time.`; always print how to undo (`View > Developer > Allow JavaScript from Apple Events`, or `rh browser setup --disable`).

- [ ] **Step 1: Failing tests** for `browserSetupCommand`/`offerBrowserSetupOnce` with fake `BrowserSetup` and `ask`: not running browsers are skipped and never inspected further; ready browsers print ✔ and record; js_disabled + yes → `enableJs` called once, success path prints ✔; js_disabled + `--yes` never calls `ask`; js_disabled + no → `enableJs` NOT called, decision `declined` recorded; automation_denied → pane opened, asked to press Enter, re-inspected once; accessibility/system-events denial prints the matching pane open + instructions; `--disable` calls `disableJs` only for browsers whose state is checked; `--browser brave` filters; unknown browser → usage error exit 1; `offerBrowserSetupOnce` does nothing when `isTTY` is false (no ask, no inspect, no state write); skips browsers already in state (declined stays declined); dispatch order in `browser.ts` (`setup` handled before any CDP readiness/warning and `ensureChromeAutomationReady` not called).
- [ ] **Step 2: Implement; run alone; typecheck both packages; commit + push.**
- [ ] **Step 3: Wire the automatic offers**: `hud install` and `hud listen` call `offerBrowserSetupOnce` before starting when stdin is a TTY (use `process.stdin.isTTY` for the real context); `rh setup` calls it at the end. The HUD LaunchAgent process itself must never prompt. Tests in `hud.test.ts`/`setup.test.ts` with an injected offer function asserting: called on a TTY, not called without a TTY, failures in the offer never fail the command (wrapped in try/catch with a one-line warning).
- [ ] **Step 4: Messaging**: the engine's fast-path-unavailable note, `rh browser doctor` remediation summary and the prompt rule/skill text that tell the user to run `rh browser doctor` now say `run rh browser setup` (doctor still exists for diagnosis; the prompt rule must mention `rh browser setup`; keep the prompt drift/rule tests passing and update assertions that name the old command without weakening). Add `setup` to the `rh` help text.
- [ ] **Step 5: Docs**: README (a short "First run" section: run `rh browser setup` once; what it does and why macOS requires it; undo; the slower fallback without it) and `docs/development.md` (flow, state file location `~/.remote-hands/browser-setup.json`, flags, non-interactive behaviour, Safari manual steps, the Automation-prompt attribution caveat: run it from the same Terminal you use, a launchd HUD may show its own prompt).
- [ ] **Step 6: Final checks**: `npm run build` (hard timeout 280), each touched test file alone, `git diff --check`, `node packages/cli/dist/index.js browser setup --help` style smoke that prints usage WITHOUT touching any browser (add a `--help` that returns 0 before any probe); commit + push.
