# Native App Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the HUD fast, accurate and capable on native macOS apps: a snapshot that takes well under a second on big windows, stable element ids, a richer but smaller view, and the actions people actually need (scroll, double-click, right-click, drag, focus a field, set or read a value).

**Architecture:** A small persistent Swift helper (`rh-ax`) holds accessibility element handles and talks JSON lines over stdin/stdout. A Node client (`AxHelperClient`) owns its lifecycle. Pure TypeScript turns the helper's raw nodes into a compact view (`ax-model.ts`: merge, prune, render, diff), and `DesktopEngine` combines them into the operations the `desktop_*` tools need. `ComputerSession` uses the engine when the helper is ready and otherwise runs exactly the code it runs today, so nothing regresses where the helper cannot run.

**Tech Stack:** Swift (AppKit/ApplicationServices, compiled with `swiftc -O`, embedded in the CLI bundle like the HUD helper), TypeScript, vitest.

**Measured baseline (this Mac, read-only):** snapshot of WhatsApp 0.2 s / 48 elements, Messages 0.4 s / 53, Finder 5.2 s / 499 (hit the 500 cap), Music 6.0 s / 493 (cap). Re-finding an element before a click took 2.7 s in Finder. Every desktop action ends with another full snapshot.

## Global Constraints

- The existing walker, `performAxActionDetailed`, `setAxElementValue`, `MacOsDriver` and the CLI `rh desktop …` commands stay unchanged and keep working. The new path is additive and is used only when the helper reports ready.
- `RH_AX_HELPER=0` turns the helper off (falls back to today's behaviour); the helper is never started off macOS.
- Every action that clicks, performs a named action, drags or sets a value asks the approval gate with the element's label first, exactly like `desktop_click` does today; scrolling and reading do not. Typing keeps its current gating (`desktop_key` risky combos).
- Password fields (`AXSecureTextField`) are never read back: values are shown as `••••`.
- No physical mouse movement unless the tool result says so (as today's physical-click fallback does): events are posted at the element's position without warping the cursor.
- `SLIM_COMPUTER_PROMPT` may only name tools that `buildComputerTools` produces (test), and the operator skill file must stay identical to `REMOTE_HANDS_OPERATOR_SKILL_MD` (test).
- The helper's Swift source is embedded in `ax-helper-source.generated.ts` by `scripts/embed-swift.mjs` (a test checks it matches the `.swift` file); it compiles with `swiftc -typecheck` and `-O`.
- Tests never need Accessibility permission or a real app: Node tests use a fake helper process and synthetic nodes. Live checks on real apps are done by hand and reported, with throwaway data only.
- Commit style `feat(desktop): …`, with the attribution line; never `git add -A` (the tree has unrelated untracked files).

## Review Focus

- A stale or unknown element id must fail with a clear "call desktop_snapshot again", never act on a different element.
- A click point covered by another window must refuse, not click the window on top.
- Helper crash, hang, missing Swift toolchain, missing Accessibility permission: the tool call still returns a useful result (fallback or a plain explanation), never hangs the MCP server.
- Huge windows (thousands of rows), apps with no accessibility tree (games, canvas apps), apps that are not running, secure text fields, and non-ASCII / emoji / newline text must behave sensibly.
- Approval gating must not be bypassable through the new tools (double-click, drag, named action, set value on a labelled "Delete"/"Send" control).

---

## Stage 1: Fast read-only snapshot

### Task 1: The Swift helper (`rh-ax`) with `ping` and `snapshot`

**Files:** Create `packages/daemon/src/desktop/ax-helper.swift`; modify `packages/daemon/scripts/embed-swift.mjs` (also embed this file); create `ax-helper-source.generated.ts` (generated).

**Protocol (one JSON object per line, request has `id`, reply echoes it):**
- `{"id":1,"op":"ping"}` → `{"id":1,"ok":true,"version":1,"trusted":true}`
- `{"id":2,"op":"snapshot","app":"Finder","window":"optional title","maxNodes":600,"budgetMs":3000}` → `{"id":2,"ok":true,"app":{"name","pid","bundle"},"window":{"title","x","y","w","h"},"nodes":[…],"truncated":false,"timedOut":false,"elapsedMs":123}`; each node `{h,p,role,sub?,label?,value?,help?,ph?,en?,foc?,sel?,exp?,x,y,w,h2?…}` (see the Swift file for the exact keys), `h` is a stable handle, `p` the parent's handle (0 for a root), `off` counts children left out because they are scrolled out of view.
- Errors: `{"id":n,"ok":false,"error":"not_trusted|no_app|no_window|bad_request|…","message":"…"}`.

**Interfaces:** the handle table maps handle → `AXUIElement`; the same element keeps the same handle across snapshots (CFHash + CFEqual), so ids are stable.

- [ ] Write the helper (single `main.swift`, stdin thread → serial main queue, one JSON reply per request, exits when stdin closes).
- [ ] `swiftc -typecheck` and `-O` build; run it by hand with `printf` pipes against Finder/Messages/Music/WhatsApp and record timings and node counts.
- [ ] Extend the embed script and commit the generated file.

### Task 2: Node client and locator

**Files:** Create `packages/daemon/src/desktop/ax-helper.ts` and `.test.ts`.

**Interfaces (produces):**
```ts
export interface AxNode { h: number; p: number; role: string; sub?: string; label?: string; value?: string; help?: string; ph?: string; en?: boolean; foc?: boolean; sel?: boolean; exp?: boolean; x: number; y: number; w: number; ht: number; acts?: string[]; off?: number }
export interface AxSnapshot { app: { name: string; pid: number; bundle?: string }; window?: { title: string; x: number; y: number; w: number; h: number }; nodes: AxNode[]; truncated: boolean; timedOut: boolean; elapsedMs: number }
export interface AxHelperPort { available(): boolean; ready(): Promise<boolean>; request<T>(op: Record<string, unknown>, timeoutMs?: number): Promise<T> }
export class AxHelperClient implements AxHelperPort
export function ensureAxHelperBinary(opts): Promise<{ ok: true; path: string } | { ok: false; error: string }>
```
- Spawns lazily, serialises requests, per-request timeout (kills and restarts a hung helper), restarts once after a crash, never throws out of `available()`/`ready()`, `RH_AX_HELPER=0` and non-darwin make it permanently unavailable.
- Builds the binary in the background from the embedded source (`~/.remote-hands/ax-helper.swift` → `~/.remote-hands/bin/rh-ax`, rebuilt when the source is newer, ad-hoc codesigned); until it exists `available()` is false.
- Tests use a fake helper (a node script speaking the protocol).

### Task 3: The compact view (`ax-model.ts`)

**Files:** Create `packages/daemon/src/desktop/ax-model.ts` and `.test.ts`.

**Produces:** `buildView(snapshot, opts) → { lines: ViewLine[]; text: string; fingerprint: string; ids: Map<number, ViewItem> }` and `renderDiff(prev, next)`:
- merge a row/cell with its text children into one line; hide images, splitters, scrollbars, unlabelled groups (promote their children); show scroll hints (`↓ N more below`);
- annotate: `disabled`, `selected`, `focused`, `checked`, `expanded`/`collapsed`, `= "value"` (secure fields `••••`), `{open}` style actions when the element has more than a plain press;
- a cap with an honest `… N more hidden` line, `filter` narrowing;
- `fingerprint` ignores nothing visible, so two equal fingerprints mean "the window did not change".

### Task 4: `DesktopEngine.snapshot` and the session delegate

**Files:** Create `packages/daemon/src/computer/desktop-engine.ts` and `.test.ts`; modify `session.ts` (optional `engine` dep), `createDefaultComputerSession`.

- `ComputerSession.desktopSnapshot` uses the engine when `engine.ready()`; otherwise the unchanged legacy path. Output keeps the `app: <name>` header and `[id] role "label"` lines so existing consumers keep working.
- Live check on four apps; commit.

## Stage 2: Actions by handle

### Task 5: Helper actions: `perform`, `click`, `focus`, `setValue`, `typeText`, `scroll`, `read`, `drag`

- `perform {h, action}` (`AXPress`, `AXOpen`, `AXShowMenu`, `AXIncrement`, `AXDecrement`, `AXConfirm`, `AXScrollToVisible`, …); `click {h, count, button}` posts CGEvents at the element's centre after checking that the point belongs to the same app (`covered` otherwise); `focus {h}`; `setValue {h, value}` with read-back; `typeText {pid, text}` in UTF-16 chunks (newline and tab as key presses); `scroll {h|pid, dx, dy}`; `read {h, max}`; `drag {from, to}`.
- A stale handle replies `stale`; nothing ever falls back to "find by label".

### Task 6: Engine operations, gating and tools

- `DesktopEngine.click/type/scroll/read/drag/set`, each: resolve id → gate (labelled actions) → helper op → wait for the window to settle → return a diff view.
- Tools: `desktop_click` gains optional `action` (`press`, `open`, `menu`, `double`, `right`) and keeps its `index`/`app`; `desktop_type` gains optional `index`, `replace`, `submit`; new `desktop_scroll`, `desktop_read`, `desktop_drag`. Prompt rule 4, tool descriptions, operator skill and the tool-name test are updated together.
- Live checks only on TextEdit (new untitled document, closed without saving) and read-only/scroll in Finder.

## Stage 3: Settling, polish

### Task 7: Settle by fingerprint and diffs

- After an action: wait 120 ms, snapshot, wait 150 ms, snapshot; equal fingerprints mean settled (max 1.5 s); results show `+ ~ -` lines against the pre-action view (full list when most of it changed). Accessibility notifications were considered and rejected: apps do not reliably post them for subtree changes.

### Task 8: Be less intrusive

- Set `AXManualAccessibility` only for Chromium/Electron apps; set `AXEnhancedUserInterface` only as a retry when a tree comes back nearly empty, and put it back afterwards.

### Task 9: Docs and final checks

- `docs/development.md` (helper, protocol, `RH_AX_HELPER`, live-check recipe), operator skill, full suites, type checks, Codex review where the reviewer is available.

## Not in this plan

- Vision/OCR fallback for apps without an accessibility tree, and curated AppleScript layers for scriptable apps (Notes, Mail, Calendar…). Both are separate designs; the fast lane already covers a few scriptable cases.
