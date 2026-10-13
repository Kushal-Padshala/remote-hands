### [P0] Newly listed frame controls make the legacy driver click another element

`packages/daemon/src/browser-snapshot.ts:119`, `packages/daemon/src/browser-driver.ts:754`, `packages/daemon/src/browser-driver.ts:776`

Input: a same-origin iframe starts at `(300,200)` and contains “Next question” at local rect `(20,30,20,20)`; the top page has “Delete account” at `(30,40)`. The new snapshot exposes the frame button, with top-page rect `(320,230,20,20)`. Calling legacy `clickIndex` on that button first calls its DOM click, then sends CDP mouse press/release at **`(30,40)`**, because the action script returns the node's frame-local rect. The second click targets the top-page Delete control, without checking its identity or asking the gate about it. The throwaway experiment executed the actual driver method with DOM evaluation and recorded those CDP parameters. The new iframe test only invokes the fast action script and cannot catch this regression.

Suggested fix: keep deep controls out of the legacy snapshot until legacy actions safely support them, or resolve and validate the intended node's current top-viewport coordinates before sending any CDP input. Do not send a second coordinate click after a DOM click. Test the actual legacy driver with an offset iframe and a different control at the local coordinates, including nested and transformed frames.

### [P0] Slotted buttons can be advertised as a different, harmless action

`packages/daemon/src/browser-snapshot.ts:67`, `packages/daemon/src/browser-snapshot.ts:113`, `packages/daemon/src/browser/page-scripts.ts:341`

Input: an open shadow root contains `<button><slot>Save</slot></button>` and its host supplies the text `Delete account`. Slot assignment makes the displayed button label “Delete account”, but `name()` reads the slot's fallback children and the snapshot lists **`button "Save"`**. An action guarded with label `Save` succeeds and invokes the button's destructive handler. This is newly reachable because the commit exposes shadow controls. The experiment checked `slot.assignedNodes()`, the snapshot label, and the successful guarded click. Extraction also returns `Save Delete account`, including undisplayed fallback text.

Suggested fix: calculate labels and extracted text from slot assignments, using fallback children only when no nodes are assigned. Avoid reading assigned light-DOM text twice. Add a fixture where the assigned label and fallback label name different actions, and assert both the snapshot label and action guard.

### [P0] Full snapshots export plaintext passwords from frames and shadow roots

`packages/daemon/src/browser-snapshot.ts:98`, `packages/daemon/src/browser-snapshot.ts:195`, `packages/daemon/src/browser-driver.ts:671`, `packages/daemon/src/browser/page-scripts.test.ts:854`

Input: a newly traversed shadow root or same-origin frame contains a password field with value `FRAMESECRET`. Evaluating the full `DOM_SNAPSHOT_SCRIPT` returns masked action values but **`guards[node][3] === "FRAMESECRET"`**. `BrowserDriver.snapshot()` evaluates this full script with a result returned to the host, so the password leaves the page before `parseSnapshotOutput` discards guards. Both shadow and frame experiments reproduced this. The new password test deliberately uses only the light wrapper and explicitly acknowledges raw full-mode values, contrary to the plan's “Password values never leave the page” constraint. The previous top-level guard leak is extended to these new contexts.

Suggested fix: remove password plaintext from every serialized guard/page-key path; retain any necessary comparison state inside the page. Assert absence of secrets in the entire serialized full snapshot as well as both light wrappers, for top-level, shadow, and frame fields.

### [P1] The 100000-element limit does not bound the work

`packages/daemon/src/browser-snapshot.ts:106`, `packages/daemon/src/browser-snapshot.ts:109`, `packages/daemon/src/browser-snapshot.ts:172`, `packages/daemon/src/browser/page-scripts.ts:331`

Input: a root has 100010 empty elements followed by a button, or several sibling shadow roots each have tens of thousands of elements. `querySelectorAll(sel)` collects all matching controls before the cap; `querySelectorAll('*')` scans/materializes the entire root; the capped loop restarts its budget for every descendant root. All collected controls are processed before the 250-action output limit. Text walking is also unrestricted when nodes contribute no visible text, and extraction has no element budget. The beyond-cap button was still returned in the experiment. Depth 3 limits nesting, not breadth or total work. A sufficiently large page can therefore block browser evaluation despite the promised global bound.

Suggested fix: use one shared visit budget across documents and shadow roots, consumed during incremental traversal rather than after an unrestricted selector query. Apply it to action discovery and text traversal, including extraction; report budget exhaustion. Add flat-page, sibling-root, and empty/offscreen-text tests that count visits and assert an upper bound, not just a small output size.

### [P1] Typing inside shadow DOM fails to notify the component's input handler

`packages/daemon/src/browser/page-scripts.ts:51`, `packages/daemon/src/browser/page-scripts.ts:178`

Input: an open-shadow input belongs to a component whose host listens for `input` to update form state or enable its Submit button. Typing sets the field's value and returns `ok:true`, but `fire()` creates an event with `composed:false`; it never crosses the shadow boundary. The host handler receives zero events, so submission can use the old value or remain disabled. The experiment reproduced zero host events after a successful type; a composed input event reached the same listener. Checking only `input.value` in the new test misses this failure.

Suggested fix: dispatch events with the native event's appropriate composition behavior (`input` is composed), and verify host/delegated listeners and application state. Apply the same check to keyboard and pointer events introduced into shadow contexts; do not indiscriminately make every event composed.

### [P2] Frame keyboard events use the top document's realm and view

`packages/daemon/src/browser/page-scripts.ts:61`, `packages/daemon/src/browser/page-scripts.ts:268`, `packages/daemon/src/browser/page-scripts.test.ts:944`

Input: a focused frame field has a shortcut handler that accepts events only when `event instanceof frameWindow.KeyboardEvent` or `event.view === frameWindow`. `press` finds the correct field, but constructs `KeyboardEvent` in the parent realm with `view: window`. It returns `ok:true` while the frame's handler ignores the key. The experiment saw one key event, zero events passing the frame-realm check, and the wrong view. The new test merely increments a counter for any keydown. The input/change and mouse helpers likewise construct events from the parent realm.

Suggested fix: construct events through `el.ownerDocument.defaultView`, and use that view in UI event initialization. Test frame handlers that inspect both realm and view, along with cancellation and ordinary field typing.

### [P2] Action-time disabled checks do not follow the new snapshot's ancestor rules

`packages/daemon/src/browser-snapshot.ts:130`, `packages/daemon/src/browser/page-scripts.ts:146`

Input: snapshot an enabled shadow button, then put `aria-disabled="true"` on its shadow host before executing its cached action. Snapshot filtering follows `closestDeep`, but the action's disabled guard still uses `el.closest`, which stops at the shadow boundary. The action returns `ok:true` and calls the handler even though a fresh snapshot excludes it. The experiment reproduced one click. A disabled ancestor of the containing iframe has the same mismatch.

Suggested fix: share the composed-ancestor disabled predicate between snapshots and action guards, and recheck it immediately before acting. Test disabled state changes after a snapshot on both a shadow host and an iframe ancestor.

### [P2] Nested frame visibility skips intermediate viewport clipping

`packages/daemon/src/browser-snapshot.ts:119`, `packages/daemon/src/browser-snapshot.ts:136`, `packages/daemon/src/browser-snapshot.ts:179`

Input: an outer iframe at top-page y=200 has height 200; its child iframe is at outer-document y=250; a button is at child y=10. The child lies entirely below the outer iframe's viewport, but its button's own-window center and translated top-window center both pass the current checks. The snapshot lists that invisible button and can list its text. A layout-stubbed experiment reproduced the action being listed. Only checking the innermost and topmost windows misses every intermediate clipping boundary; discovery does not reject the offscreen child frame.

Suggested fix: carry the accumulated visible clip through each frame and intersect it at every boundary before collecting actions/text. Handle transforms when mapping frame coordinates. Test a three-document layout with the innermost control clipped by the middle viewport. The existing frame tests bypass layout checks because jsdom has no `window.CSS` and their inner controls have zero-size rects.

### [P2] Post-action deltas suppress unreadable-frame notes

`packages/daemon/src/browser/render.ts:161`, `packages/daemon/src/browser/render.ts:198`

Input: a click loads an unreadable embedded frame while the top URL, title, listed controls, and extracted text remain the same. `normalizeSnapshot` records `blockedFrames:1`, but `renderDelta` compares neither this field nor its note and returns **`no visible change`**. The normal post-action engine path uses this delta, so the agent receives no instruction to use the desktop view. The experiment reproduced this by changing only `frames_blocked` from absent to 1. Existing tests cover `renderFull` only. A removed frame also leaves the previous note uncorrected for consumers retaining notes.

Suggested fix: include frame-readability state in delta rendering before its early return, with a defined way to announce additions, changes, and removal. Test 0→1, 1→2, and 1→0 through an engine post-action result and the parser.

### [P2] Unreadable-frame counts include offscreen frames and misstate their origin

`packages/daemon/src/browser-snapshot.ts:120`, `packages/daemon/src/browser/render.ts:164`, `packages/daemon/src/browser/page-scripts.test.ts:861`

Input: an unreadable 400×300 frame is at y=10000, below the current viewport. Its dimensions and CSS visibility pass the predicate, so `frames_blocked` is 1 and the result tells the agent to inspect a part that is absent from the current desktop screenshot. The experiment reproduced this with an offscreen rect. CSS `checkVisibility` does not establish viewport intersection. Separately, a sandboxed same-site/srcdoc frame with an opaque origin is unreadable but is described as “from another website”; `contentDocument === null` cannot establish that claim.

Suggested fix: count only frames intersecting the accumulated viewport clip; distinguish unreadability from asserted site origin and use wording such as “embedded frame cannot be read here.” The test named “ignores small or hidden ones” never creates a hidden frame: add hidden, offscreen, and sandboxed cases.

### [P2] Direct text children of shadow roots disappear from snapshots

`packages/daemon/src/browser-snapshot.ts:174`

Input: an open shadow root's textContent is `Your appointment is confirmed`, with no wrapping element. Its text node has `parentElement === null`, so the snapshot skips it and returns an empty text field. The same fixture's extract result contains the confirmation. This prevents the usual post-action snapshot from confirming a successful operation displayed as direct shadow text.

Suggested fix: use the shadow host as the visibility context when a text node's parent is a ShadowRoot, while keeping the range anchored to the text's owner document. Add direct-root-text tests alongside the existing `<p>` fixture.

### [P2] The frame editor test passes without inserting any text

`packages/daemon/src/browser/page-scripts.test.ts:914`, `packages/daemon/src/browser/page-scripts.test.ts:923`

Input: run the new contenteditable test exactly as written. Its `execCommand` mock returns true without modifying the editor; the script reports success, the editor remains empty, and both assertions pass. The test verifies the chosen document and argument, but cannot establish that selection/replacement or typing works in a browser, particularly for an editor inside a shadow root in a frame. The frame fixtures also permit parent-realm event dispatch without checking realm-specific expectations.

Suggested fix: assert editor contents and selection/replacement behavior in an isolated real-browser fixture, including frame-plus-shadow combinations and an existing value. Retain the unit assertion about the document, but make any success mock perform the intended edit and add explicit failure/fallback cases.

No additional new leaks through logging or the frame-count note were identified. No P3 findings.

## Verified

- Read `git show f7a7f36`, then `git show 27ba1e8`, then `git show 8383490`; read the plan's Global Constraints and Review Focus, surrounding snapshot/action/render code, legacy CDP click/type paths, engine delta consumers, and relevant tests. Queried the existing graph before source searches.
- Used `git show 8383490:<path>` for reviewed-stage source and an archived checkout at `/tmp/rh-stage-a-review/checkout` to exclude subsequent feature commits. Finding locations in `page-scripts.ts` and its tests refer to that reviewed revision; later commits shift their line numbers.
- Ran `npx vitest run packages/daemon/src/browser packages/daemon/src/browser-snapshot.test.ts packages/daemon/src/browser-driver.test.ts packages/daemon/src/fast-lane/pilot/parse.test.ts` in the current checkout: **13 files, 355 tests passed**, exit 0.
- Ran the identical command in the archived `8383490` checkout: **12 files, 325 tests passed**, exit 0. No full-daemon run or typecheck was claimed.
- Ran throwaway Node/jsdom experiments under `/tmp` using transpiled reviewed-stage source: full versus light password serialization; actual legacy `clickIndex` with recorded CDP arguments; slotted labels, guarded clicks and extraction; shadow input event propagation; frame keyboard realm/view; disabled shadow ancestors after snapshot; beyond-100000 discovery; intermediate-frame clipping with layout stubs; blocked-frame delta and offscreen count; direct shadow text. Layout-stubbed experiments establish the code's predicates, not a real Chrome/Safari layout result.
- Checked closed-shadow exclusion and depth-3 fixtures in the passing tests. Reviewed identity/label guards and the newly exposed legacy action path. Label-target resolution and new-tab/Tab additions in later commits were excluded from this stage's findings.
- Attempted an isolated headless Chrome launch with a `/tmp` profile and a synthetic data URL; it aborted with exit 134 before loading the fixture. **Real Chrome/Safari verification was unavailable**; no user's tabs/accounts were driven. The legacy typing experiment hit a pre-existing `Unexpected identifier 'as'` in its generated script, so no successful legacy typing/CDP insertion result is claimed.
- Wrote only this review file in the repository. Preserved the existing `.gitignore` modification and untracked `.gitattributes` and `docs/superpowers/plans/2026-10-04-hud-speed.md`. No code fixes, commits, or graph regeneration.

---

## Disposition, round 1 (author)

Fix commits: `03dc1a5`, `55eb7dd`, `fbb9ef4`, and the extract fix after them. Every finding was checked against the code before acting; new tests were confirmed to fail on the old code.

1. **P0 legacy click lands on another element: fixed.** Shadow roots and frames are read only in the fast engine's light mode. The legacy driver's full mode sees exactly the top document as before, so its rect-based click can never target nested content. Test: `legacy full mode keeps seeing only the top document…`.
2. **P0 slotted button advertised under fallback text: fixed.** Names come from what is assigned to a slot (fallback only when nothing is), in both the snapshot (`kidsOf`) and extract (slot expansion before the visibility check, because a slot has no box). Extract no longer also walks the light children of a shadow host. Tests: slot naming, extract slot tests.
3. **P0 plaintext passwords from frames/shadow in full snapshots: fixed for the new surface.** Nested contexts are not read in full mode at all (see 1) and the light path strips guards. Test asserts neither secret appears anywhere in the full snapshot. **Deferred, pre-existing:** the legacy full snapshot still puts the top-document password value into `guards`; it stays inside the local daemon process (CDP) and is not part of this change.
4. **P1 100000 bound not a real bound: fixed.** One element budget is shared by every root; nested controls are capped at 2000, nested text visits at 20000, extract at 200000 nodes, and the page is flagged (`scan_truncated`, a `note:` line, and label targets fail closed). Tests count behaviour past the budget (a control beyond 100000 elements is not read).
5. **P1 typing in shadow DOM does not notify host listeners: fixed.** `input` events are composed; keyboard and mouse over/move events are composed; enter events are not. Test: host-level `input` listener sees one event.
6. **P2 frame events built in the parent realm: fixed.** Events are constructed from the element's own window and carry that window as `view`. Test asserts `instanceof frameWindow.KeyboardEvent` and `view === frameWindow` for keys and mouse.
7. **P2 disabled check stops at shadow boundary: fixed.** The action guard uses a composed-ancestor check (shadow hosts and frame elements). Test: `aria-disabled` on the host after the snapshot refuses the click.
8. **P2 nested frame clipping: fixed.** The visible clip rectangle is carried and intersected at every frame boundary; a frame clipped away is skipped with its controls and text. Test with a three-document layout.
9. **P2 deltas hide a new unreadable frame: fixed.** `renderDelta` announces a frame that appears or changes count even when nothing else changed; removal stays quiet. Tests: 0→1, 1→2, 1→0, unchanged.
10. **P2 offscreen frames counted / "from another website" wording: fixed.** Only frames intersecting the visible clip and not hidden are counted, including a frame at the nesting limit. Wording is now "cannot be read here (from another website or sandboxed)". Tests: offscreen, `aria-hidden`, depth boundary.
11. **P2 direct text in a shadow root dropped: fixed.** The shadow host is the visibility context for such text. Test added.
12. **P2 frame editor test passed without inserting text: fixed in the unit test** (the mock now edits the editor and the test asserts the content). **Deferred:** a real-browser fixture is not available in this environment (headless Chrome did not start for the reviewer either); real-browser behaviour of cross-realm events is unverified and is called out in the final report.
