# Fast Browser Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fast, reliable HUD browser control on Chrome, Brave, Arc, Edge and Safari using the user's signed-in profile, with fewer model turns per task.

**Architecture:** An AppleScript JavaScript transport runs the existing page snapshot script in a specific tab; page-side action scripts target elements by stable node id with in-page stale checks; `FastBrowserEngine` renders stable-id snapshots and diffs, offers find / do (batch) / extract, and falls back to the existing `BrowserDriver`. `ComputerSession` talks to a string-returning `BrowserPort` that either the engine or a thin legacy adapter implements.

**Tech Stack:** TypeScript (ESM, strict), Node 22, vitest 5 (+ jsdom for page-script tests), zod 4, macOS `osascript`.

**Spec:** `docs/superpowers/specs/2026-10-03-fast-browser-engine-design.md`

## Global Constraints

- Node `>=22.0.0`; TypeScript strict (check `tsconfig.base.json` flags such as `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`); ESM with `.js` import suffixes.
- No external model API key. Zero screenshots. No remote-debugging port usage on the fast path.
- JavaScript and identifiers reach AppleScript only through `argv` (`on run argv`), never by string interpolation into the script text. Never launch a closed browser: always guard with `application "<name>" is running`.
- Test commands: one file at a time, `perl -e 'alarm 100; exec @ARGV' npx vitest run <path>` (macOS has no `timeout`; do not use `sed -i`; never use vitest watch mode). Never start a real `agy`.
- Never touch `~/.remote-hands` or `~/.gemini`. Live browser checks are read-only except on a throwaway tab the test itself creates (a `data:` URL tab) and closes.
- Existing tests must keep passing (the old `BrowserDriver`, `browser-snapshot` and CLI browser tests are unchanged except where a task says otherwise).
- Commit after every green step and `git push origin feat/fast-hud-computer-use`. Never push a red tree. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (use a second `-m`).

## Review Focus

- A closed browser must never be launched by any code path (a probe once launched Arc and Safari by `tell application`).
- JS must land in the intended tab, not just the front tab: element ids and actions are tab-scoped.
- Text containing quotes, backslashes, newlines, emoji, `</script>`, backticks and `${}` must reach the page unchanged (typed text, labels, URLs).
- Stale element, label changed, disabled setting, denied automation, no window, closed browser: each yields a clear actionable error; the legacy fallback still works.
- A `browser_do` batch validates every step before running any, stops at the first failure and reports which step failed.
- A navigation caused by a click must not be reported as success with the old page's state.
- Password fields: never echo their values (the snapshot script already masks them) and `browser_extract` must not include password input values.

---

### Task 1: Browser registry, AppleScript builders, error classification, transport

**Files:**
- Create: `packages/daemon/src/browser/browsers.ts`, `browsers.test.ts`
- Create: `packages/daemon/src/browser/applescript.ts`, `applescript.test.ts`
- Create: `packages/daemon/src/browser/transport.ts`, `transport.test.ts`
- Modify: `packages/daemon/src/index.ts` (exports)

**Interfaces:**
- Produces (`browsers.ts`):
  - `type BrowserFamily = 'chromium' | 'safari'`
  - `interface BrowserApp { name: string; family: BrowserFamily; aliases: readonly string[] }`
  - `const BROWSERS: readonly BrowserApp[]` in this order: `Google Chrome` (aliases chrome, google chrome), `Brave Browser` (brave, brave browser), `Arc` (arc), `Microsoft Edge` (edge, microsoft edge), `Safari` (safari) — family chromium except Safari.
  - `findBrowser(name: string): BrowserApp | undefined` (case-insensitive match on `name` or any alias, trimmed)
  - `pickTargetBrowser(opts: { frontmost?: string | null | undefined; running: readonly string[]; override?: string | undefined }): BrowserApp | undefined` — override (if it names a registry browser) wins even if not running only when it is running, else fall through; then the frontmost app if it is a registry browser; then the first registry browser whose `name` is in `running`; else undefined.
- Produces (`applescript.ts`):
  - `type BrowserErrorCode = 'not_running' | 'no_window' | 'no_tab' | 'automation_denied' | 'js_disabled' | 'timeout' | 'script_error'`
  - `class BrowserAutomationError extends Error { readonly code: BrowserErrorCode; readonly browser: string }` whose `message` is the full user-facing remediation text
  - `interface TabTarget { windowId: string; tabKey: string }` (`tabKey` = chromium tab id, safari tab index as text)
  - `classifyOsascriptError(browser: BrowserApp, stderr: string, status: number | null): BrowserAutomationError`
  - `buildEvalScript(b: BrowserApp): string[]` (argv: `js`, `windowId`, `tabKey`; empty windowId means the front window's active/current tab)
  - `buildTabsScript(b)`, `buildFocusScript(b)` (argv `windowId`, `tabKey`), `buildOpenScript(b)` (argv `url`, `windowId`; empty windowId = front window), `buildCloseScript(b)` (argv `windowId`, `tabKey`), `buildRunningScript()` (lists running registry browser names + frontmost process name), each returning the `-e` line array for `osascript`.
- Produces (`transport.ts`):
  - `type RunOsascript = (lines: string[], argv: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; status: number | null }>`
  - `interface TabInfo { windowId: string; windowIndex: number; tabKey: string; tabIndex: number; title: string; url: string; active: boolean }`
  - `class AppleScriptTransport` with `constructor(opts?: { run?: RunOsascript })`, `environment(): Promise<{ frontmost: string | null; running: string[] }>`, `evaluate(b: BrowserApp, target: TabTarget | null, js: string, timeoutMs?: number): Promise<string>`, `listTabs(b): Promise<TabInfo[]>`, `focusTab(b, target: TabTarget): Promise<void>`, `openUrl(b, url: string, windowId?: string): Promise<void>`, `closeTab(b, target): Promise<void>`. All reject with `BrowserAutomationError`.

Expected AppleScript shapes (verify against the real browsers, see Step 5): chromium eval uses `repeat with w in windows` / `repeat with t in tabs of w` matching `(id of w) as text` / `(id of t) as text`, and `execute theTab javascript js` (or `tell theTab to execute javascript js`); Safari uses `do JavaScript js in tab (tabKey as integer) of window id (windowId as integer)` and `current tab of front window` for the empty target. Errors raised by the script itself use the exact strings `rh:not_running`, `rh:no_window`, `rh:no_tab`.

- [ ] **Step 1: Write failing tests for `browsers.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { BROWSERS, findBrowser, pickTargetBrowser } from './browsers.js';

describe('browser registry', () => {
  it('lists the supported browsers in preference order', () => {
    expect(BROWSERS.map((b) => b.name)).toEqual(['Google Chrome', 'Brave Browser', 'Arc', 'Microsoft Edge', 'Safari']);
    expect(findBrowser('safari')?.family).toBe('safari');
    expect(findBrowser('Brave')?.name).toBe('Brave Browser');
    expect(findBrowser('  CHROME ')?.name).toBe('Google Chrome');
    expect(findBrowser('Firefox')).toBeUndefined();
  });

  it('prefers a running override, then the frontmost browser, then the first running browser', () => {
    const running = ['Google Chrome', 'Brave Browser', 'Finder'];
    expect(pickTargetBrowser({ frontmost: 'Brave Browser', running })?.name).toBe('Brave Browser');
    expect(pickTargetBrowser({ frontmost: 'Finder', running })?.name).toBe('Google Chrome');
    expect(pickTargetBrowser({ frontmost: 'Finder', running, override: 'brave' })?.name).toBe('Brave Browser');
    expect(pickTargetBrowser({ frontmost: 'Brave Browser', running, override: 'arc' })?.name).toBe('Brave Browser');
    expect(pickTargetBrowser({ frontmost: null, running: ['Finder'] })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement `browsers.ts`** (`perl -e 'alarm 100; exec @ARGV' npx vitest run packages/daemon/src/browser/browsers.test.ts`; expected FAIL: module missing; then PASS). Implementation is a plain array plus the two functions per the Interfaces block. Commit + push.

- [ ] **Step 3: Write failing tests for `applescript.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { findBrowser } from './browsers.js';
import { classifyOsascriptError, buildEvalScript, buildTabsScript, buildOpenScript } from './applescript.js';

const brave = findBrowser('brave')!;
const safari = findBrowser('safari')!;

describe('classifyOsascriptError', () => {
  it('maps a disabled JavaScript-from-Apple-Events setting with the browser-specific menu path', () => {
    const err = classifyOsascriptError(
      brave,
      '71:93: execution error: Brave Browser got an error: Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events. (12)',
      1,
    );
    expect(err.code).toBe('js_disabled');
    expect(err.message).toContain('View > Developer > Allow JavaScript from Apple Events');
    expect(err.message).toContain('Brave Browser');
  });

  it('maps Safari wording to Safari instructions', () => {
    const err = classifyOsascriptError(safari, 'Safari got an error: You must enable the Develop menu "Allow JavaScript from Apple Events" (4)', 1);
    expect(err.code).toBe('js_disabled');
    expect(err.message).toContain('Develop');
  });

  it('maps -1743 to automation_denied with the System Settings path', () => {
    const err = classifyOsascriptError(brave, '44:60: execution error: Not authorized to send Apple events to Brave Browser. (-1743)', 1);
    expect(err.code).toBe('automation_denied');
    expect(err.message).toContain('System Settings');
    expect(err.message).toContain('Automation');
  });

  it('maps the script-raised markers and unknown errors', () => {
    expect(classifyOsascriptError(brave, 'execution error: rh:not_running (-2700)', 1).code).toBe('not_running');
    expect(classifyOsascriptError(brave, 'execution error: rh:no_window (-2700)', 1).code).toBe('no_window');
    expect(classifyOsascriptError(brave, 'execution error: rh:no_tab (-2700)', 1).code).toBe('no_tab');
    const other = classifyOsascriptError(brave, 'something odd\n'.repeat(100), 1);
    expect(other.code).toBe('script_error');
    expect(other.message.length).toBeLessThan(600);
    expect(classifyOsascriptError(brave, '', null).code).toBe('timeout');
  });
});

describe('script builders', () => {
  it('never interpolates user data and guards on the app running', () => {
    const lines = buildEvalScript(brave);
    const text = lines.join('\n');
    expect(text).toContain('on run argv');
    expect(text).toContain('item 1 of argv');
    expect(text).toContain('application "Brave Browser" is running');
    expect(text).not.toContain('${');
    expect(text).toContain('rh:not_running');
  });

  it('builds distinct chromium and safari eval scripts', () => {
    expect(buildEvalScript(safari).join('\n')).toContain('do JavaScript');
    expect(buildEvalScript(brave).join('\n')).toContain('execute');
  });

  it('tabs and open scripts guard on running and use argv for the URL', () => {
    expect(buildTabsScript(brave).join('\n')).toContain('is running');
    const open = buildOpenScript(brave).join('\n');
    expect(open).toContain('item 1 of argv');
    expect(open).toContain('is running');
  });
});
```

- [ ] **Step 4: Run to verify failure, then implement `applescript.ts`**. Classification precedence: `rh:` markers first, then `(-1743)`/`Not authorized`, then `turned off`/`Allow JavaScript from Apple Events`/`Apple Events` JS wording => `js_disabled`, then `status === null` or empty => `timeout`, else `script_error` (stderr trimmed to 300 chars, no multi-line spam). Messages: `js_disabled` chromium: `<Name> has JavaScript from Apple Events turned off. Enable it once: <Name> menu bar > View > Developer > Allow JavaScript from Apple Events.`; Safari: `Safari has JavaScript from Apple Events turned off. Enable it once: Safari > Settings > Advanced > Show features for web developers, then Develop > Allow JavaScript from Apple Events.`; `automation_denied`: `macOS blocked this app from controlling <Name>. Allow it in System Settings > Privacy & Security > Automation (enable <Name> under the app that runs Remote Hands).`; `not_running`: `<Name> is not running.`; `no_window`: `<Name> has no open window.`; `no_tab`: `The target tab is gone. Call browser_tabs and focus a tab again.`; `timeout`: `<Name> did not answer in time.`. Builders return the `-e` line arrays as specified. Commit + push.

- [ ] **Step 5: Verify the AppleScript syntax against the real browsers (read-only)**. With a throwaway script (scratchpad, not committed) run each builder through real `osascript` against Google Chrome and Brave Browser, which are running on the dev machine: `buildTabsScript` must list real tabs (tab-separated: `windowId\twindowIndex\ttabKey\ttabIndex\tactive\ttitle\turl` per line; define and document this exact format in the builder) and `buildEvalScript` with js `1` must either return `1` or fail with the browser's own 'turned off' message (which proves the command parsed and reached the browser). Never run a builder for a browser that is not running (the `is running` guard must make that return `rh:not_running`; test that for Arc and Safari only if they are closed, and confirm afterwards that they did not launch — `pgrep -x Arc Safari` must stay empty; if either launched, quit it and fix the guard). Record the outputs in the report. Fix the builders until verified, then commit + push.

- [ ] **Step 6: Write failing tests for `transport.ts` with an injected `RunOsascript` fake**, covering: `environment()` parses frontmost + running names from the `buildRunningScript` output; `evaluate` passes `[js, windowId, tabKey]` as argv (assert the argv array exactly and that the script lines passed are those from `buildEvalScript`), returns stdout trimmed of the single trailing newline only (do not trim inner whitespace), and a js string containing quotes, backslashes, newlines, emoji, backticks, `${x}`, `</script>` is passed unchanged as argv[0]; non-zero status rejects with the classified `BrowserAutomationError` (assert `code`); `listTabs` parses the tab-separated format incl. titles containing quotes and an empty title, and marks `active`; `focusTab`, `openUrl` (argv `[url, windowId ?? '']`), `closeTab` pass argv correctly; a `null` target sends two empty strings.
- [ ] **Step 7: Implement `transport.ts`** (default `RunOsascript` uses `execFile('osascript', ['-e', line1, '-e', line2, ..., '--', ...argv])` — verify the exact osascript invocation that makes `argv` work with multiple `-e` lines on this macOS (it is `osascript -e 'on run argv' -e '...' -e 'end run' arg1 arg2`; confirm whether a literal `--` is required) with a hard timeout default 8000 ms, `maxBuffer` 16 MB, no shell). Run all three test files + `npx tsc --noEmit -p packages/daemon/tsconfig.json`; export from `index.ts`; commit + push.

---

### Task 2: Page runtime scripts

**Files:**
- Modify: `packages/daemon/src/browser-snapshot.ts` (additive: expose `name`, `role`, `visible` on the cache)
- Create: `packages/daemon/src/browser/page-scripts.ts`, `page-scripts.test.ts` (jsdom)
- Modify: `packages/daemon/src/browser-snapshot.test.ts` (one new test)

**Interfaces:**
- Consumes: `DOM_SNAPSHOT_SCRIPT` (IIFE string returning `{url,title,w,h,text,scroll,actions,...}`; `actions[i]` has `id`, `node` (stable number), `role`, `label`, `kind` (`click|fill|select|scroll|wait`), `value`, `checked`, `current_value`).
- Produces (`page-scripts.ts`):
  - `type PageOp = { op: 'click'; node: number; label: string } | { op: 'type'; node: number; label: string; text: string; submit?: boolean } | { op: 'select'; node: number; label: string; value: string } | { op: 'check'; node: number; label: string; checked: boolean } | { op: 'press'; key: string } | { op: 'scroll'; delta: number }`
  - `type PageOpResult = { ok: true; label?: string; navigated?: boolean } | { ok: false; error: 'no_snapshot' | 'stale' | 'changed' | 'unsupported' | 'no_option' | 'failed'; current?: string; message?: string }`
  - `buildActionScript(op: PageOp): string` — an IIFE source that evaluates to a JSON string (`JSON.stringify(PageOpResult)`); all op fields embedded with `JSON.stringify` and additionally escaped so the result is safe inside any transport (no raw U+2028/U+2029).
  - `buildExtractScript(maxChars: number): string` — IIFE returning `JSON.stringify({ title, url, text })` where `text` is whitespace-collapsed visible text of `main`, `[role=main]`, `article` (largest) else `body`, excluding `script,style,noscript,template`, excluding input values of `type=password`, truncated to `maxChars` with a trailing `…`.
  - `buildSnapshotCall(): string` — `JSON.stringify(<DOM_SNAPSHOT_SCRIPT result>)` wrapper IIFE (so transports that return text get JSON) and `buildReadyProbe(): string` returning `JSON.stringify({ u: location.href, r: document.readyState, t: document.title })`.
- Cache additions in `DOM_SNAPSHOT_SCRIPT` (insert right after the `const role = ...` definition, before `cache.pageKey`): `cache.name = name; cache.role = role; cache.visible = visible;`.

Page-script behaviour (all inside `buildActionScript`):
- `const cache = window.__rhFast || window.__jevFast; if (!cache) return fail('no_snapshot')`. Resolve `el = cache.nodes.get(node)`; missing or `!el.isConnected` => `stale`.
- If `label` is non-empty compute `current = (cache.name ? cache.name(el) : '') || (cache.role ? cache.role(el) : '')`; mismatch => `{ok:false,error:'changed',current}`. (For select/combobox elements the snapshot label is `base.label` without the ` → option` suffix; the engine passes the base label.)
- `click`: scrollIntoView (instant, center), focus, dispatch `pointerdown, mousedown, pointerup, mouseup`, then `el.click()`; `navigated` = false (the engine detects navigation by re-probing the page).
- `type`: focus+scroll; for `input/textarea` use the native prototype value setter (`Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, text)`) then dispatch `input` and `change` (bubbles) so React/Vue controlled inputs update; for `contenteditable` select all then `document.execCommand('insertText', false, text)` with an `el.textContent = text` fallback plus `input` event; if `submit` is true dispatch Enter keydown/keypress/keyup on the element and, if not default-prevented and the element has a `form`, call `form.requestSubmit()`.
- `select`: for `SELECT` find the option whose `value` or trimmed `label`/`text` equals `value` case-insensitively (exact first, then startsWith); none => `no_option` with message listing up to 10 option labels; set `selectedIndex`, dispatch `input`,`change`. Non-SELECT roles => `unsupported`.
- `check`: if `el.checked` (or `aria-checked==='true'`) differs from `checked` click it; verify afterwards and return `ok:false,error:'failed'` if unchanged.
- `press`: dispatch keydown/keypress/keyup for `key` on `document.activeElement || document.body`; for `Enter` on an input inside a form and not default-prevented call `requestSubmit()`.
- `scroll`: `window.scrollBy({ top: delta, behavior: 'instant' })`.

- [ ] **Step 1: Failing tests (jsdom).** Build a helper that creates a `JSDOM` page (`runScripts: 'outside-only'`, `pretendToBeVisual: true`), evaluates `DOM_SNAPSHOT_SCRIPT` with `window.eval(...)`, and returns the parsed result. Tests: snapshot result lists a button, a text input, a checkbox, a select (one action per non-selected option); `window.__rhFast.name` and `.role` exist after the snapshot (new hook; also add the one-line test in `browser-snapshot.test.ts` asserting the script text contains `cache.name = name`); click on the button's `node` fires a `click` listener exactly once; click with a wrong `label` returns `changed` with `current`; click after removing the element returns `stale`; click without a prior snapshot returns `no_snapshot`; type sets the value through the native setter and fires `input` and `change` once each (use a listener that records `event.isTrusted === false` is irrelevant — assert call counts and final `value`); typing text `a"b\\c\n\u{1F600}`${x}</script>` round-trips byte-for-byte; typing into a password input works but `buildExtractScript` never includes the value; `submit:true` calls `form.requestSubmit` (stub it) once; select by option value, by label (case-insensitive) and a missing option (`no_option` with message containing available labels); check toggles and is idempotent; press Enter in a form input submits; scroll calls `scrollBy`; `buildExtractScript` prefers `main`, collapses whitespace, truncates at `maxChars` with `…`, skips `script/style`.
- [ ] **Step 2: Run to verify failure; implement the additive snapshot hook and `page-scripts.ts`; run `browser-snapshot.test.ts` and `page-scripts.test.ts` alone and the existing `browser-driver.test.ts`; typecheck; commit + push.** If jsdom lacks an API the scripts use (e.g. `requestSubmit`, `scrollBy`, `checkVisibility`), stub it in the test helper, never in the production script.
- [ ] **Step 3: Live check (read-only plus a throwaway tab) — only if the browser setting is on.** Using the transport from Task 1, open a `data:text/html,...` tab in Brave containing a small form (text input, checkbox, select, button that changes the DOM), run `buildSnapshotCall()` and each action script through `AppleScriptTransport.evaluate` with the new tab's `TabTarget`, verify the page state changed, then close the tab with `closeTab`. If `js_disabled` is returned, skip and record "live check pending the browser setting" in the report (do not enable the setting yourself).

---

### Task 3: FastBrowserEngine and BrowserPort

**Files:**
- Create: `packages/daemon/src/browser/port.ts` (types), `render.ts`, `render.test.ts`, `engine.ts`, `engine.test.ts`, `legacy-port.ts`, `legacy-port.test.ts`
- Modify: `packages/daemon/src/index.ts` (exports)

**Interfaces:**
- Consumes: `AppleScriptTransport`, `BROWSERS`, `pickTargetBrowser`, `BrowserAutomationError`, `TabTarget`, `TabInfo` (Task 1); `buildActionScript`, `buildExtractScript`, `buildSnapshotCall`, `buildReadyProbe`, `PageOp`, `PageOpResult` (Task 2); `BrowserDriver` (existing; for the legacy adapter).
- Produces (`port.ts`):
  - `interface DoStep { op: 'click' | 'type' | 'select' | 'check' | 'press' | 'scroll' | 'wait'; index?: number; text?: string; value?: string; checked?: boolean; key?: string; delta?: number; ms?: number; submit?: boolean }`
  - `interface BrowserPort { tabs(): Promise<string>; focus(target: string | number): Promise<string>; open(url: string): Promise<string>; snapshot(opts?: { text?: boolean }): Promise<string>; click(index: number): Promise<string>; type(index: number, text: string, opts?: { submit?: boolean }): Promise<string>; find(query: string, limit?: number): Promise<string>; do(steps: DoStep[]): Promise<string>; extract(maxChars?: number): Promise<string> }`
- Produces (`render.ts`): `interface PageElement { id: number | string; node?: number; role: string; label: string; kind: string; value?: string; checked?: boolean; options?: string[]; }`, `interface PageState { url: string; title: string; text: string; elements: PageElement[] }`, `normalizeSnapshot(raw: unknown): PageState` (stable id = `node` number; group the per-option `select` actions of one node into one element with `options` (labels) and `value` = `current_value`; drop `Open <label>` duplicate click actions that share a node with a `fill` action; keep `scroll_down`, `scroll_up`, `wait` pseudo elements with their string ids; mask nothing extra), `renderFull(state, opts: { text: boolean; maxLines?: number; textChars?: number }): string`, `renderDelta(prev: PageState | null, next: PageState, opts?): string`, `findElements(state, query, limit): PageElement[]`.
  Format: header `page: <title> — <url>`; optional `text: <first 1200 chars, newlines as ' ⏎ '>`; element lines `[12] button "Next"`, `[7] textbox "Email" = "a@b.c"`, `[9] checkbox "I agree" [checked]`, `[3] select "Country" = "US" options: US | Canada | …(+3)`; pseudo elements `[scroll_down] scroll "Scroll down"`. Cap at `maxLines` (default 120) with `… N more elements hidden; use browser_find`.
  `renderDelta`: if `prev` is null, or url or title changed, or more than half of the union of node ids changed, return `renderFull(next)` prefixed with `changed: page navigated or re-rendered`. Otherwise `page: <title> — <url> (same page)` followed by `+ [id] ...` for new elements, `- [id] "<label>"` for removed ones, `~ [id] ...` for elements whose value/checked/label changed, and `(N unchanged)`; if nothing changed: `no visible change`.
- Produces (`engine.ts`): `class FastBrowserEngine implements BrowserPort` with `constructor(deps: { transport: AppleScriptTransport-like; legacy: BrowserPort; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; now?: () => number })` and `reset(): void` (clears pin, shown snapshot, fast-path cache).
- Produces (`legacy-port.ts`): `class LegacyBrowserPort implements BrowserPort` wrapping the existing `BrowserDriver` with exactly the behavior `ComputerSession` had before (tabs listing format `[wN-tM] (active) title - url`, snapshot capped at 120 lines, click/type returning `clicked [i] label\n<state>`, `find`/`extract`/`do` implemented on top of snapshot text / `executeScript` where available, else throwing a clear `not supported on the legacy path` error; `do` runs the steps sequentially using click/type and stops at the first failure).

Engine behaviour:
1. **Target resolution.** `environment()` once per call chain (cache 1 s). Browser = `pickTargetBrowser({ frontmost, running, override: env.RH_BROWSER })`; none => delegate to `legacy`. Tab target: the pinned tab (set by `focus`/`open`, expires after 5 minutes of inactivity or `reset()`), else `null` (front window's active tab).
2. **Fast-path availability cache.** A `BrowserAutomationError` with code `js_disabled` or `automation_denied` disables the fast path for that browser for 60 s and the call is served by `legacy`; the first fallback result per engine instance is prefixed with `note: fast browser path unavailable (<message>); using the slower fallback.`. `not_running`/`no_window` are not cached and use `legacy`. `no_tab` clears the pin and throws the actionable message.
3. **Snapshot.** `evaluate(buildSnapshotCall())` => `normalizeSnapshot`. The engine stores `shown` (the last state rendered to the model together with the tab target and browser) — actions resolve `index` against `shown`.
4. **Actions** (click/type/do): look up `index` in `shown` (missing => throw `Index N is not on the page I last showed. Call browser_snapshot.`; legacy-mode `shown` => delegate to `legacy`). Run `buildActionScript` through `evaluate` with the pinned target; parse the JSON result; map `stale` => `Element [N] no longer on the page. Call browser_snapshot.`, `changed` => `Element [N] changed (now "<current>"). Call browser_snapshot.`, `no_option` => its message, other failures => their message. After the action: `waitStable()` then take a snapshot and render `renderDelta(shown, next)`, then set `shown = next`.
5. **waitStable.** After an action poll `buildReadyProbe()` every 120 ms: stop when `readyState === 'complete'` and the previous two probes agree on url/title, or after 3 s (then continue with whatever the page shows and append `note: page still loading`). A first probe taken 80 ms after the action that is already `complete` with an unchanged url ends the wait after one more matching probe (so a no-navigation action costs about two osascript calls).
6. **`do(steps)`.** Validate every step up front (op known; index present in `shown` for index ops; `type` needs text, `select` needs value, `check` needs checked, `press` needs key, `scroll` needs delta, `wait` ms 0-5000; max 15 steps) before running anything; on a validation problem throw `step N <op> invalid: <reason>. No steps were run.` Run steps in order against the SAME `shown` ids (node ids are stable across re-renders; do not re-snapshot between steps; `wait` just sleeps; `scroll` uses the scroll script). Between steps do not take snapshots, but after a `click` or `press Enter`/`submit` step run the cheap ready probe and if the url changed stop the batch with `step N <op> ok but the page navigated; remaining steps not run` (return the new page state). On a failing step throw `step N <op> failed: <reason> (steps 1-N-1 ok)` (use the same wording rules as `computer_batch`: `no steps ok`, `step 1 ok`, `steps 1-K ok`). Finish with one `waitStable()` + snapshot + `renderDelta(shownBeforeBatch, next)`, prefixed by `did: <op list>`.
7. **`find(query, limit=8)`**: fresh snapshot (updates `shown`), score elements by case-insensitive token overlap in `label`+`value`+`role` (all tokens present scores highest; exact label match first), return `found N of M elements for "<query>":` plus the rendered lines (full compact line format), or the 8 first elements with `no match` when none.
8. **`extract(maxChars=4000)`**: `buildExtractScript` => `title\nurl\n\ntext` (never password values).
9. **`tabs()`**: header `browser: <name>` then `[w<windowIndex>-t<tabIndex>] (active) <title> - <url>` for every tab of the target browser; legacy fallback when no fast target.
10. **`focus(target)`**: number or `w2-t8` or title/url substring (same matching rules as `BrowserDriver.findTab`: exact id, exact url, host+path equality, url contains, title contains, case-insensitive); `transport.focusTab`; pin the tab; return `focused <title> - <url>` plus the snapshot.
11. **`open(url)`**: if a tab with equal host+path exists, focus it (no duplicate); else `transport.openUrl`, find the new active tab (re-list; the active tab of the window that was front), pin it, wait for ready, snapshot. Only `http`, `https` and `file` and `about:blank` and `data:` URLs are accepted (reject other schemes with a clear error — never `javascript:`).

- [ ] **Step 1: Failing tests for `render.ts`** with hand-built raw snapshot objects (shape of the real script output, including select option actions, `Open <label>` duplicates, a masked password value `••••••••`, scroll/wait pseudo actions): stable ids = node numbers; selects grouped with options and current value; duplicates dropped; full render format incl. `maxLines` truncation message; text excerpt newline handling; `renderDelta` for: identical pages (`no visible change`), one element added/removed/changed (`+`,`-`,`~`), navigation (url change => full with the `changed:` prefix), and large churn (>50 % => full); `findElements` ranking.
- [ ] **Step 2: Implement `render.ts`; run; commit + push.**
- [ ] **Step 3: Failing tests for `engine.ts`** using a scripted fake transport (records `evaluate` calls: tab target and js text; returns queued JSON strings) and a fake legacy port. Cover: browser selection via frontmost/override; a closed browser => legacy used and nothing launched (fake `environment()` reports running list; assert `evaluate` never called); fast path happy path (snapshot, click => action script contains the node id and label, post-action delta); `js_disabled` => fallback with the one-time note and 60 s cache (second call does not call `evaluate`, advance `now`), `automation_denied` same; stale/changed/no_option error mapping with the exact messages above; `do` validation-before-run (assert zero evaluate calls on a bad step), failure message format, navigation stop, single final snapshot, ids resolved against the pre-batch `shown`; `find` ranking and `shown` update; `extract`; `tabs` format; `focus` pin then subsequent evaluate calls carry that tab target, pin expiry after 5 min and `reset()`; `open` reuse-vs-new and the scheme allow-list (`javascript:` rejected, nothing evaluated); text with hostile characters passed as argv-safe JSON through `buildActionScript`.
- [ ] **Step 4: Implement `engine.ts` and `legacy-port.ts` (+ `legacy-port.test.ts` asserting the previous `ComputerSession` browser behaviors: tabs line format, 120-line cap, click/type result strings).** Run all new test files alone + typecheck; export from `index.ts`; commit + push.

---

### Task 4: Wire into `ComputerSession`, tools, prompt and skill

**Files:**
- Modify: `packages/daemon/src/computer/session.ts`, `session.test.ts`, `tools.ts`, `tools.test.ts`, `prompt.ts`, `prompt.test.ts`, `mcp-server.test.ts` (only if tool-count assertions exist)
- Modify: `.agents/skills/remote-hands-operator/SKILL.md`, `packages/cli/src/system/operator-skill.ts` (installed skill text; keep its tests passing)
- Modify: `packages/daemon/src/guidance/hud-coordinator.ts` and `packages/daemon/src/hermes-brain.ts` only if their browser wording names old behavior (keep existing assertions)

**Interfaces:**
- Consumes: `BrowserPort`, `DoStep` (Task 3).
- Produces: `ComputerSessionDeps.browser: BrowserPort` (replaces the `Pick<BrowserDriver, ...>` shape); `ComputerSession` browser methods now delegate to the port and return its strings: `browserTabs()`, `browserFocus(target)`, `browserOpen(url)`, `browserSnapshot()`, `browserClick(index)`, `browserType(index, text, submit?)`, new `browserFind(query, limit?)`, `browserDo(steps)`, `browserExtract(maxChars?)`. `createDefaultComputerSession()` builds `FastBrowserEngine({ transport: new AppleScriptTransport(), legacy: new LegacyBrowserPort(new BrowserDriver({ cdpUrl })) })`. HUD `newConversation()`/cancel must call `engine.reset()` via a `ComputerSession.reset()` only if the session instance is reachable there; the MCP server is a separate process so expose `reset` through a `browser_reset`-free approach: the engine's own 5-minute pin expiry is the contract, no new tool.
- Tools: `browser_find { query: string, limit?: number(1-20) }`, `browser_do { steps: DoStep[] (1-15) }` (zod discriminated by `op`; same up-front validation as the engine, plus the engine validates again), `browser_extract { max_chars?: number(200-20000) }`; `browser_type` gains optional `submit: boolean`; descriptions rewritten for the stable-id model: ids are stable numbers; after any action the result already contains the changed state so do not call `browser_snapshot` again; prefer `browser_do` for forms and multi-step sequences (one call, ids from the last state you saw); use `browser_find` on large pages; `browser_extract` to read long text.

- [ ] **Step 1: Update `session.test.ts` browser tests to the port-based deps** (fake `BrowserPort` with `vi.fn()`s) and add tests for the three new methods delegating with exact args; update `tools.test.ts`: tool names list gains `browser_find`, `browser_do`, `browser_extract`; handlers route args (`browser_do` steps pass through unchanged, `browser_type` with `submit`); `computer_batch` still rejects nested/unknown tools and its description mentions that `browser_do` is preferred for browser sequences.
- [ ] **Step 2: Run to verify the failures, implement, run all `packages/daemon/src/computer/*.test.ts` files alone, typecheck, commit + push.**
- [ ] **Step 3: Prompt and skill.** `SLIM_COMPUTER_PROMPT`: add a "Browser" rule block (concise): ids in brackets are stable numbers; action results already contain the updated state (never re-snapshot after an action); use `browser_do` to fill and submit a whole form in one call; use `browser_find` before dumping a big page; use `browser_extract` to read long text; if a result begins with `note: fast browser path unavailable`, tell the user once to run `rh browser doctor` and continue with the fallback. Keep the tool-name drift test passing (it compares tool names mentioned in the prompt with `buildComputerTools`): update the test's expected set to include the three new tools. Update the operator skill sections the same way (both the repo skill and `operator-skill.ts`), preserving the zero-discovery and zero-screenshot mandates.
- [ ] **Step 4: Run the touched test files alone (computer dir, prompt test, operator-skill tests under packages/cli, hud-coordinator and hermes-brain tests if edited), `npm run build`, then the MCP stdio check: build, then pipe an `initialize` + `tools/list` request to `node packages/cli/dist/index.js mcp serve` and confirm 17 tools. Commit + push.**

---

### Task 5: Doctor command, benchmark, docs, live verification

**Files:**
- Modify: `packages/cli/src/commands/browser.ts` (new `doctor` subcommand), `packages/cli/src/commands/browser.test.ts`
- Create: `scripts/bench-browser.mjs`
- Modify: `docs/development.md`

**Interfaces:**
- Consumes: `AppleScriptTransport`, `BROWSERS` (Task 1), `FastBrowserEngine` (for the bench script via `packages/daemon/dist`).
- Produces: `rh browser doctor [--json]` printing, per registry browser: running?, automation permission, JavaScript-from-Apple-Events setting, with the exact remediation line from `classifyOsascriptError`, and the browser the HUD would target now. It never launches a closed browser and never changes any setting. `browserCommand` handles `doctor` before any Chrome-CDP readiness check (the doctor must not spawn Chrome or print the CDP warning).

- [ ] **Step 1: Failing tests** for `browserCommand(['doctor'])` with an injected transport fake: all-ok browser prints ✔ lines; a browser with `js_disabled` prints ✖ and the menu path; not running prints `not running` and no probe; `--json` prints a parseable object; the command returns 0 even when something is disabled (it is diagnostic) and never calls `ensureChromeAutomationReady`.
- [ ] **Step 2: Implement, run `browser.test.ts` alone, commit + push.**
- [ ] **Step 3: `scripts/bench-browser.mjs [runs]`**: for the target browser (frontmost/override), times `transport.evaluate(browser, null, '1')`, a full snapshot through `FastBrowserEngine` (use `packages/daemon/dist`), and `engine.tabs()`, printing median ms per case, or the classified remediation message when the fast path is unavailable (exit 0). Syntax check with `node --check`.
- [ ] **Step 4: Docs** (`docs/development.md`): the fast browser path, which browsers, the one-time setting per browser, `rh browser doctor`, the fallback behavior and its limits, the security note (while the setting is on, any app with Automation permission can run JavaScript in your tabs), the benchmark command.
- [ ] **Step 5: Live verification (needs the browser setting ON; if `rh browser doctor` reports `js_disabled`, stop here and report that live verification is pending — do not enable the setting).** With Brave (or whichever browser is verified ON): run `scripts/bench-browser.mjs 7` and record the medians; then on a throwaway `data:` URL tab the test opens and closes itself, exercise through `createDefaultComputerSession()` (built dist): `browserOpen`, `browserSnapshot`, `browserDo` (type into a field, check a checkbox, select an option, click a button that changes the DOM), `browserFind`, `browserExtract`, a stale-id error after removing an element, and a hostile-text type (quotes, newline, emoji). Record outputs verbatim in the report. Close the tab at the end and confirm no other tab was changed.
- [ ] **Step 6: Final checks**: `npm run build`, each touched test file alone, `git diff --check`; commit + push.

---

## Self-Review

- **Spec coverage:** registry + transport + classification (T1); page runtime with stale guards (T2); engine with stable ids, diffs, batch, find, extract, tabs/focus/open, fallback (T3); tools, prompt, skill (T4); doctor, benchmark, docs, live verification (T5).
- **Placeholders:** none; the only conditional steps (Task 2 Step 3, Task 5 Step 5) name the exact skip condition and what to report.
- **Type consistency:** `TabTarget`, `TabInfo`, `BrowserApp`, `PageOp`, `PageOpResult`, `DoStep`, `BrowserPort`, `PageState`, `PageElement` are defined once (Interfaces blocks) and used by name later.
- **Known risks for implementers:** exact AppleScript syntax per browser (Task 1 Step 5 verifies on real Chrome/Brave; Arc and Safari syntax is unverified until those apps are open and the setting is on — the engine must not claim support for a browser that was not verified live); jsdom gaps (stub in test helper, not in production script); osascript argv invocation details (verify, do not assume).
