### [P1] Zoom still follows the old window when window titles do not identify it

Locations: `packages/daemon/src/computer/desktop-engine.ts:92`, `packages/daemon/src/computer/desktop-engine.ts:247`, `packages/daemon/src/computer/desktop-engine.ts:260`, `packages/daemon/src/desktop/ax-helper.swift:412`, `packages/daemon/src/desktop/ax-helper.swift:428`.

Zoom into window A, then switch to window B in the same app while A's AX objects remain valid. Swift walks A's root but supplies metadata from `chooseWindow`, which now chooses B. `settle` checks only the window title. If the windows have identical or empty titles, it keeps A's zoom and IDs and reports `no visible change`; B's controls never become available. Two Finder windows showing different directories with the same folder name satisfy the title collision. A switch between the full snapshot and the first `desktop_snapshot index=N` is also missed even with different titles: `snapshot` immediately records B's title alongside A's subtree, so subsequent settling compares B's title with itself. In-memory executions reproduced both cases and retained only the old window's row IDs.

The comparison also introduces the opposite regression. Changing a document title in the same AX window, such as adding an edited indicator, drops a still-valid zoom. A 500-button fixture fell from the zoom's 400 items to the full view's 150 items after only its title changed.

Suggested fix: carry the owning window's stable AX identity with the zoom and validate it against the chosen window in Swift, including the first indexed snapshot. Do not publish one window's subtree under another window's metadata. Invalidate by app/window identity and root visibility, rather than by mutable, nonunique titles. Test same-title windows, switching before the first zoom, and renaming within the same window.

### [P1] A large zoom root still consumes the budget before its opened overlays are read

Locations: `packages/daemon/src/desktop/ax-helper.swift:263`, `packages/daemon/src/desktop/ax-helper.swift:428`, `packages/daemon/src/desktop/ax-helper.swift:432`, `packages/daemon/src/desktop/ax-helper.swift:438`.

Zoom into a list with at least 3,000 visible raw AX nodes, then open its context menu or a sheet. The root is visited first using the entire node/time budget. When it fills the budget, the sheet's `visit` immediately returns and the app-level menu/popover/drawer loop breaks. The new overlay scan therefore does not repair this case: its actionable IDs are still absent from the result and from the engine's rebuilt `byId`. Applying `filter` cannot recover them because filtering happens after the AX read. This affects the large windows that prompted the feature.

An execution of the actual `Walker` and `walkOnce` bodies with mocked AX attributes returned 3,000 nodes, `truncated: true`, and neither the opened `AXMenu` nor its `Copy` item. The same bodies included the menu, popover, drawer and sheet when the root was small.

Suggested fix: discover and read active overlays before spending the budget on the underlying zoom root, or reserve an independently enforced budget for their controls. Test a context menu and a sheet opened over a root that exhausts both the node limit and the time budget.

### [P2] Frameless zoom roots can still lose their ancestor viewport clip

Locations: `packages/daemon/src/desktop/ax-helper.swift:522`, `packages/daemon/src/desktop/ax-helper.swift:549`, `packages/daemon/src/desktop/ax-helper.swift:553`, `packages/daemon/src/desktop/ax-helper.swift:560`.

A labelled, frameless group separated from its scroll area by 17 ordinary groups is within the full walker's 48-level traversal limit. `zoomClip` stops after 16 parents, never reaches the viewport, and returns `(nil, false)`. The zoom walk interprets that nil as unrestricted traversal and emits framed descendants outside the scroll area. The full-window walk excludes those same descendants. This preserves the original offscreen-root problem for deeply nested trees.

There is another lost-clip case with a known zero-height viewport. `frameOf` returns nil for its empty frame, and `zoomClip` treats that as unavailable geometry and skips it. A frameless root inside that collapsed viewport inherits the surrounding window's nonempty clip instead. An execution of the actual `zoomClip` and `Walker` bodies with mocked geometry reproduced both cases: the offscreen button was absent from the full read and present in the zoom read.

Suggested fix: distinguish unavailable geometry from a known empty viewport and return stale for the latter. Traverse enough ancestors to cover the supported tree depth, with cycle detection, and preserve a containing viewport/window bound for frameless roots. If that bound cannot be established, fall back to a full read instead of silently treating the subtree as unrestricted. Add geometry tests for deep frameless roots and zero-size viewport ancestors.

### [P2] The overview fallback still hides late regions and omits scroll-area discovery

Locations: `packages/daemon/src/desktop/ax-model.ts:396`, `packages/daemon/src/desktop/ax-model.ts:484`, `packages/daemon/src/desktop/ax-model.ts:486`, `packages/daemon/src/desktop/ax-model.ts:487`.

The fallback only lists emitted `container` items, while scroll areas are registered as regions without emitting such an item. With 160 labelled scroll areas, each containing five buttons and no offscreen-count hint, the default view falls back to the first 150 buttons plus a generic footer. It supplies no scroll-area IDs or zoom markers, hides every late region, and `filter="scroll area"` returns nothing. The fixture has only 961 raw nodes, so this is not the helper's read limit.

Even emitted headings are prefix-cut: 160 lists with five buttons each show only the first 149 list headings. Filtering by `list` repeats that prefix and cannot reveal the final 11. The added regression test uses 60 panes, which fit in the 150-line overview, and checks only the first 30 pane IDs; it does not cover more region headings than available lines. Keeping the remaining IDs internally does not give the model a way to discover them.

Suggested fix: construct overview entries from `regions`, including scroll areas, and provide pagination or another explicit route to discover excess region IDs within the line cap. Do not revert to the control prefix when no container headings exist. Test more than 150 regions, scroll-area-only layouts, repeated labels, and small custom caps.

### Verified

Git ancestry is `b2fc505b2d3b6b6228b676707b09e2b0fa4bff57` (feature), then `59e3f6d6c4757661952961479b3b113eadf6a57f` (fix, HEAD), despite the reversed order and fix identification in the request. Reviewed in that chronological order against `b2fc505^`, and checked the seven findings in `docs/superpowers/reviews/nonnative-stage1-codex-review.md`. Queried the existing graph before reading project source.

| Prior finding | Result |
|---|---|
| 1. Raw approval labels | Raw `$(delete)` survived direct rows, rows folded from cells, nested groups, icon-only buttons and help-text fallback. Executing the actual formatter and risk classifier classified each fixture as `delete`. No surviving icon-stripping approval bypass was reproduced. |
| 2. Overlays during zoom | The Swift root path now reaches direct window sheets and app-level menus/popovers/drawers. Mocked execution verified their inclusion with a small root; budget starvation remains as reported above. Real-app overlay placement was not exercised. |
| 3. Menu action targets | `AXShowMenu` is retained; only the annotation is suppressed. Nine unlabelled menu-only rows folded from cells remained addressable. Actual engine execution dispatched `perform` to the cell's AX handle, rather than right-clicking the row. Zoom snapshots and settling inherit `menuNoise`, as covered by the passing engine test. |
| 4. Other app/window | The passing engine tests cover another app, a different window title, and root `bad_request`/`stale` conversion and full-read retry. Actual window identity remains unchecked, and title-only invalidation introduces the regression above. |
| 5. Scrolled-out root | The actual `zoomClip` function returned stale for an ordinary framed root outside its viewport, clipped a partially visible root, and derived an ancestor clip for a shallow frameless root. Deep and empty-viewport cases remain as reported above. |
| 6. Region overview | The 60-pane case now supplies headings. More headings than lines and scroll areas without heading items remain incomplete. |
| 7. Zoom cap/wording | A 500-button zoom retained 400 items and directed the caller to filter instead of repeating the same root zoom. Filtering that zoom fixture exposed the final button. The tool, development documentation and both operator-skill copies now describe the bounded 400-line zoom rather than promising a full pane. |

Ran:

```sh
npx vitest run packages/daemon/src/desktop/ax-model.test.ts packages/daemon/src/desktop/ax-helper.test.ts packages/daemon/src/desktop/ax-actions.test.ts packages/daemon/src/desktop/ax-walker.test.ts packages/daemon/src/computer/desktop-engine.test.ts packages/daemon/src/computer/session-engine.test.ts packages/daemon/src/computer/session.test.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/computer/prompt.test.ts packages/daemon/src/approval-gate.test.ts packages/daemon/src/action-gate.test.ts packages/shared/src/approval.test.ts packages/cli/src/action-gate.test.ts
```

Result: exit 0; 13 files, 248 tests passed.

Also ran:

```sh
swiftc -typecheck -module-cache-path /private/tmp/rh-stage1b-review-module-cache packages/daemon/src/desktop/ax-helper.swift
```

Result: exit 0. The embedded Swift source equality test passed in the Vitest run.

Additional checks used in-memory transpilation of the actual TypeScript sources and temporary Swift harnesses outside the repository. The Swift harnesses executed the unchanged `zoomClip`, `Walker` and `walkOnce` bodies with mocked AX attributes/geometry; they do not establish live macOS accessibility behavior. No live app actions or account mutations were performed. No implementation files were changed, no graph update was run because no code was edited, and no commit was made. The pre-existing `.gitignore`, `.gitattributes` and prior-review working-tree changes were left alone; the only repository file written by this review is this report.
