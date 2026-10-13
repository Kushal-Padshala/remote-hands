### [P0] Icon stripping removes risk keywords from approval labels

Locations: `packages/daemon/src/desktop/ax-model.ts:180`, `packages/daemon/src/desktop/ax-model.ts:328`, `packages/daemon/src/desktop/ax-model.ts:351`.

`textOf` strips icon syntax even when called with `MAX_GATE_LABEL`. An actionable `AXRow` or `AXCell` labelled `$(delete) Remove account` therefore gets both display label and `gateLabel` equal to `Remove account`. The original label classifies as `delete`; the new, nonempty gate label classifies as harmless. `ComputerSession.desktopClick` passes that label to the gate and then executes the row's AX action, so a destructive row action can run on the user's account without phone approval. The same helper also processes literal `$(...)` text without establishing that it is an editor icon. The added test checks raw approval text only on a button with a nonempty display label; rows and the empty-display-label fallback are not protected. An icon-only button labelled `$(delete)` loses its gate label entirely and is refused by the real gate, rather than retaining its original approval classification.

Suggested fix: keep display normalization separate from authorization text. Preserve raw labels through row folding and every fallback used to construct `gateLabel`, including nested groups and icon-only controls. Restrict display stripping to recognized icon syntax in an appropriate app context. Add gate-level tests for rows/cells, literal command text, and controls whose entire label is an icon token.

### [P1] Zoomed action results omit newly opened menus and dialogs

Locations: `packages/daemon/src/desktop/ax-helper.swift:420`, `packages/daemon/src/computer/desktop-engine.ts:246`.

After zooming into a Finder file list or a Music results pane, `desktop_click action=menu` can successfully open a context menu while the zoom root remains alive. The root branch returns before the app-level `AXMenu`/`AXPopover`/`AXDrawer` scan. A sheet or dialog outside the root subtree is likewise excluded. `settle` keeps reading the root and can report `no visible change`; the menu items are absent from `byId`, so the next indexed menu click is impossible. This contradicts the prompt's instruction that action results supply the new UI and a separate snapshot is unnecessary. An in-memory engine reproduction with a menu exposed only in the full snapshot returned `no visible change` after successfully opening it and retained no ID for its Copy item.

Suggested fix: inspect active overlays even during a zoom, and return their actionable contents or leave zoom automatically when an action opens UI outside it. Make the ID scope and prompt agree with that behavior. Test opening a context menu, popup and sheet from a zoomed native-app list.

### [P1] The global menu heuristic discards real native action targets

Locations: `packages/daemon/src/desktop/ax-model.ts:221`, `packages/daemon/src/desktop/ax-model.ts:546`; execution path: `packages/daemon/src/computer/desktop-engine.ts:159`.

The heuristic applies to every app and removes `AXShowMenu` from `actionTargets`, rather than just its annotation. In a native table with eight menu-bearing cells folded into rows, a row's menu action previously invoked the specific cell's `AXShowMenu`. Now `desktop_click action=menu` sends a right-click at the row's center. That point need not identify the same cell or offer the same menu, and a native control can implement `AXShowMenu` without implementing an equivalent right-click menu. The reproduced eight-cell fixture changed from a folded AX target to `{ op: 'click', h: 2, button: 'right', count: 1 }`. There is also an ID-loss case: eight unlabelled, unselected rows offering only `AXShowMenu` all disappear because the row emission condition sees no remaining actions; the resulting `byId` is empty.

Suggested fix: retain all actual action targets and use `menuNoise` only when rendering annotations. Scope any annotation suppression so meaningful native menus remain discoverable. Test menu-bearing folded cells, menu-only rows and a control where right-click cannot substitute for `AXShowMenu`.

### [P1] Switching apps carries the previous app's zoom root into the new snapshot

Locations: `packages/daemon/src/computer/desktop-engine.ts:242`, `packages/daemon/src/computer/desktop-engine.ts:248`; caller: `packages/daemon/src/computer/session.ts:283`.

Zoom into a Finder pane, then call `desktop_open app=Music`. The app opens, but its post-action `settle('Music', ...)` still sends Finder's root ID. Swift correctly rejects it with `bad_request: That element belongs to another app.` The catch handles only `StaleElementError`, so it never retries a full Music snapshot. `safeState` returns an unavailable-state message, and the session retains Finder's cache and IDs; indexed Music actions then fail the app check. The in-memory reproduction confirmed the Music request carried the Finder root and left `engine.current().app` equal to Finder. This breaks the documented open-app-then-use-its-controls flow.

Suggested fix: bind zoom to its app PID and window identity, and clear it before settling a different app/window. Preserve the helper's same-app rejection rather than weakening it. Test `desktop_open` and cross-app `desktop_menu` after a zoom. Also ensure window metadata comes from the root's own window: `chooseWindow` currently can select a different window while the helper still walks the old root.

### [P2] An invisible zoom root turns a missing visible frame into unrestricted traversal

Location: `packages/daemon/src/desktop/ax-helper.swift:421`; supporting paths: `packages/daemon/src/desktop/ax-helper.swift:292`, `packages/daemon/src/desktop/ax-helper.swift:515`.

Zoom into a row in a scroll area, then scroll until that row is entirely outside the viewport. Its AX object, role and label can remain valid, so `liveElement` passes. `visibleFrame(root)` returns nil for the empty intersection, but `Walker.visit(..., clip: nil, ...)` interprets nil as no clipping. It emits the old offscreen row and its descendants rather than dropping the zoom and reading the visible window. A frameless root also loses its ancestors' viewport/window clip because `visibleFrame` returns before examining those ancestors. The normal full-window walk excludes framed elements outside its clip; the new root path defeats that behavior.

Suggested fix: distinguish unavailable geometry from a known empty visible intersection. Return `stale` for a framed root that has left its viewport so `settle` can use its existing full-window fallback. For frameless roots, derive a clip from their enclosing window/scroll areas. Add helper tests for a scrolled-out root, a partially visible root and a root without its own frame.

### [P2] Too many regions make fair trimming revert to the original prefix cut

Location: `packages/daemon/src/desktop/ax-model.ts:447`.

For 60 labelled groups with ten buttons each at the default 150-line cap, the reserved 50 headings plus one item and omission marker per group cannot fit. The quota reaches zero and the function returns `list.slice(0, max)`. The reproduced view showed only 14 of the 60 pane headings, omitted every control in the final panes, and supplied no per-region zoom markers. Thus the exact class of large window this feature addresses can still hide all late panes and the indices needed to inspect them. The generic filter footer brings `view.lines` to 151, although the retained item list remains capped. Hidden list/button IDs remained in `byId`; this is a visibility/fairness failure, not trimming-induced ID deletion.

Suggested fix: when the number of regions exceeds the available share, allocate region discovery/zoom entries fairly instead of reverting to a prefix slice. Reduce heading reservations or summarize/page excess regions, while preserving their IDs and a route to inspect them. Test more regions than fit at quota one, including nested labelled groups and small custom caps.

### [P2] The tool promises a full pane but zoom remains capped at 150 lines

Locations: `packages/daemon/src/computer/tools.ts:71`, `packages/daemon/src/computer/desktop-engine.ts:94`, `packages/daemon/src/desktop/ax-model.ts:573`, `.agents/skills/remote-hands-operator/SKILL.md:42`, `packages/cli/src/system/operator-skill.ts:46`.

The schema description and both operator-skill copies say that passing an index reads that part "in full." Zoom uses the same default `buildView` cap. With a list containing 500 visible buttons, the reproduced zoom returned 150 lines, hid 352 elements and advertised `desktop_snapshot index=2` for the same list again. Repeating that advertised call returned exactly the same text. This is within the helper's 3,000-node limit, so the incompleteness comes from model-view trimming rather than the AX read budget. The new zoom tests contain only a few lines and do not verify the advertised large-pane behavior.

Suggested fix: provide bounded pagination or an explicit zoom-view budget that actually advances through the pane, and test a pane larger than 150 lines. If retaining the current cap is intentional, replace "in full" with the actual guarantee across the tool description and both skill copies, and make omission markers give an effective next step instead of repeating the same zoom.

### Verified

Reviewed commit `b2fc505b2d3b6b6228b676707b09e2b0fa4bff57` against its parent; it was HEAD. Queried the existing graph before reading source. No implementation changes or commits were made.

Ran:

```sh
npx vitest run packages/daemon/src/desktop/ax-model.test.ts packages/daemon/src/desktop/ax-helper.test.ts packages/daemon/src/desktop/ax-actions.test.ts packages/daemon/src/desktop/ax-walker.test.ts packages/daemon/src/computer/desktop-engine.test.ts packages/daemon/src/computer/session-engine.test.ts packages/daemon/src/computer/session.test.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/computer/prompt.test.ts packages/daemon/src/approval-gate.test.ts packages/daemon/src/action-gate.test.ts packages/shared/src/approval.test.ts
npx vitest run packages/cli/src/action-gate.test.ts
```

Results: first command, 12 files / 234 tests passed; second command, 1 file / 7 tests passed. Total: 241 passed.

Also ran:

```sh
swiftc -typecheck -module-cache-path /private/tmp/rh-review-swift-module-cache packages/daemon/src/desktop/ax-helper.swift
```

Result: exit 0. The embedded Swift source equality check passed in `ax-helper.test.ts`.

Additional checks used in-memory transpilation of the actual TypeScript sources, without adding test files: approval-label classification, folded menu dispatch, disappearance of eight menu-only rows, post-zoom menu omission, app switching, the 60-region prefix fallback and repeated zoom of a 500-button list. Across 1,000 generated list/button layouts, trimming terminated, retained items never exceeded the supplied positive cap, and all list/button IDs remained addressable despite trimming. This does not assert that every raw AX node has a `byId` entry: the formatter intentionally folds or ignores some roles, and the menu-only-row regression above newly loses actionable IDs.

The actual `AxHelperClient` reassembled and parsed a synthetic 3,000-node, 6,778,921-byte Unicode JSON line in approximately 66 ms without timing out. The protocol has no observed line-size ceiling; raw buffers, parsed objects and the bounded handle table still consume memory proportional to the larger read. The model view remains capped separately. The 3-second AX deadline is checked between visits, not inside blocking AX calls, and `settle` checks its 1.5-second limit only after a snapshot, so neither is a strict end-to-end latency bound. These checks did not establish a new timeout or memory defect attributable solely to changing 600 to 3,000.

Static inspection confirmed that root requests reuse `liveElement`'s epoch/signature validation, enforce app ownership, and that `settle` retries a full snapshot on a stale zoom root. Successful zoom snapshots rebuild their ID maps from only the returned subtree; the existing tests verify refusal of an outside ID. Zoom intentionally skips the enhanced-UI retry; its interaction with apps requiring that retry was not exercised live. Finder/Music/TextEdit formatter and session behavior was checked through fixtures only. No live app actions or account mutations were performed, and real-app AX timing, geometry and overlay placement remain unverified.
