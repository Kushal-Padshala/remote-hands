# Fast Browser Engine Design

Date: 2026-10-03
Status: draft for implementation (user approved the direction in chat: "do it, whichever is best")

## Goal

Make HUD browser tasks fast and reliable on the browsers the user actually runs (Chrome, Brave, Arc, Safari, Edge), using the user's own signed-in profile, with no remote-debugging port and no Allow dialog.

## Why

- Today's fast path is Chrome DevTools on port 9222 or the browser-harness socket. Since Chrome 136 the debug flag is ignored for the default profile, so neither exists for the user's real profile. The fallback is hard-coded to `Google Chrome` (AppleScript tab list plus a slow Accessibility walk). Brave, Arc and Safari have no fast path at all.
- `BrowserDriver.clickIndex/typeIndex` re-snapshot the page before every action.
- Each model turn costs about 3-7 s; transport costs 0.1-1.5 s. A 10-step form is about 10 turns. Fewer turns is the biggest lever.

## Design

New module `packages/daemon/src/browser/`:

1. **Browser registry** (`browsers.ts`): Chrome, Brave, Arc, Edge (family `chromium`), Safari (family `safari`). Target browser = frontmost browser app, else the first running browser in registry order; `RH_BROWSER` overrides.
2. **AppleScript transport** (`applescript.ts`, `transport.ts`): runs JavaScript in a specific tab through `execute javascript` (chromium family) or `do JavaScript` (Safari). JS and identifiers are passed through `argv`, never interpolated into the script text. Never launches a closed browser (`application "X" is running` check). Errors are classified (`not_running`, `no_window`, `automation_denied` -1743, `js_disabled`, `script_error`) with exact remediation text. Tab/window list, focus and open-URL operations are included. Tabs are addressed by window id and tab id (chromium) or window id and tab index (Safari), so JavaScript always lands in the intended tab, not just the front one.
3. **Page runtime** (`page-scripts.ts`): reuses the existing `DOM_SNAPSHOT_SCRIPT` (jev-ultrafast cache `window.__rhFast`, stable per-element `node` ids). Additive hooks expose the script's `name`/`role`/`visible` helpers on the cache. New page-side scripts: click, type, select, check, press key, scroll, find, extract. Every action targets a node by its stable id and verifies in-page that the node is still connected and still has the label the model saw; otherwise it returns a stale error. No re-snapshot before acting.
4. **Engine** (`engine.ts`): `FastBrowserEngine` presents snapshots with stable ids (`[12] button "Next"`, the node number, which survives re-renders), returns only a diff after actions when the page is unchanged in the large (full compact state on navigation or big changes), and provides `find`, `do` (a browser-specific batch executed against the ids the model last saw, stop on first failure, one resulting state), `extract`, tabs/focus/open. If the fast path is unavailable it falls back to the existing `BrowserDriver` (CDP / harness / AX) and says how to enable the fast path once per session.
5. **Tools and prompt**: `browser_find`, `browser_do`, `browser_extract` added to the MCP tools; `browser_click/type/snapshot/tabs/focus/open` route through the engine. The slim prompt and operator skill get "fast browser" rules.
6. **Diagnostics**: `rh browser doctor` reports, per installed/running browser, automation permission and the JavaScript-from-Apple-Events setting with the exact menu path. `scripts/bench-browser.mjs` times the AppleScript round trip and snapshot.

## Non-goals

- Enabling the browser setting automatically (it is a user security decision).
- Playwright/extension based engines, iframes and shadow DOM (the existing snapshot script does not cover them either), CDP changes.
- A persistent in-process Apple Events helper (add only if osascript spawn latency proves too high in the benchmark).

## Success criteria

- A snapshot or click on Brave/Chrome/Arc/Safari with the setting on completes in well under 400 ms on this machine (measured with `scripts/bench-browser.mjs`).
- Actions never trigger a re-snapshot before acting; a batch of N actions costs one model turn.
- Stale element, disabled setting, denied automation and closed browser each give a clear, actionable error; the legacy path still works when the fast path is unavailable.
- All new code unit-tested (fake transport, jsdom page scripts); existing tests unchanged.

## Risks

- JavaScript-from-Apple-Events is off by default in every browser (user toggles View > Developer, or Safari's Develop menu); the doctor command and error text must make that obvious.
- Any process with Automation permission can run JavaScript in the user's tabs while the setting is on (same power as CDP).
- AppleScript dictionaries differ slightly by browser (Arc, Safari); live verification is required per browser and only the browsers verified live may be advertised as supported.
