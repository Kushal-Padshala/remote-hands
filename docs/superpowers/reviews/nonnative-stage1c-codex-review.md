### [P2] The overview still provides no way to discover omitted regions with repeated labels

Locations: `packages/daemon/src/desktop/ax-model.ts:446`, `packages/daemon/src/desktop/ax-model.ts:500`, `packages/daemon/src/desktop/ax-model.ts:608`; `packages/daemon/src/desktop/ax-model.test.ts:394`.

With 160 unlabelled scroll areas containing five identically labelled `Continue` buttons each, the overview lists the first 149 areas and says `11 more parts not listed`; its suggested recovery is filtering. `filter="scroll area"` returns `nothing matches`, because filtering searches original emitted items and scroll areas have no heading item. `filter="Continue"` produces the same first 149 area entries. The remaining IDs exist in `regions`, but the model has never been told them and cannot request their indexed snapshots. This reproduces the undiscoverable late-region case from prior finding 4. The new test checks only internal ID retention, not whether a caller can discover those IDs.

Suggested fix: provide a bounded pagination/continuation route for region entries, including scroll areas, and make region labels/roles searchable. Test discovering the final region when labels repeat and the number of regions exceeds the line cap; counting omitted regions is insufficient.

### [P2] A filtered overview reintroduces panes excluded by the filter

Locations: `packages/daemon/src/desktop/ax-model.ts:498`, `packages/daemon/src/desktop/ax-model.ts:501`, `packages/daemon/src/desktop/ax-model.ts:625`.

The `q === 0` branch now takes entries from the entire `regions` map rather than from the filtered list. In a window with 20 early `Unrelated` lists and 160 later `TargetPane` lists, each containing five buttons, with only the later buttons labelled `Send`, `desktop_snapshot filter="Send"` shows the 20 unrelated panes first and no Send buttons. None of those early entries leads to a matching control. Executing the parent commit's formatter on the same fixture returns 150 Send buttons and no unrelated panes; this is a regression introduced by this commit.

Suggested fix: derive overview candidates from regions represented by the surviving filtered items, or preserve matching control results for filtered reads. Add a regression asserting that excluded panes cannot consume a filtered overview's budget.

### [P2] Known empty viewports can still be accepted as zoomable

Locations: `packages/daemon/src/desktop/ax-helper.swift:560`, `packages/daemon/src/desktop/ax-helper.swift:573`, `packages/daemon/src/desktop/ax-helper.swift:585`.

The empty-size check requires both position and size and runs only on ancestors. A frameless group inside an `AXScrollArea` that reports size `(200, 0)` but no position skips that viewport and inherits the surrounding `(200, 100)` window clip. Executing the actual `zoomClip` and `Walker` bodies then includes a framed descendant button at y=80 despite the viewport having no height. Also, when a previously visible scroll area itself becomes the zero-height indexed root, `frameOf(root)` converts its known empty frame to nil; its nonempty parent window supplies a clip, and `gone` remains false. Settling retains the collapsed pane instead of falling back to the full window.

Suggested fix: check reported empty sizes independently of position for viewport/window/sheet bounds, including the root when it has such a role. Preserve the distinction between an ordinary frameless group and a viewport known to have no size. Test both a positionless empty ancestor and an empty viewport used directly as the root.

### Verified

Reviewed `a433398e3d00247e64756411e52d7aabeeafedf8` against its parent `59e3f6d`, following the supplied chronological order. Queried the existing graph before reading project source.

| Prior finding | Verification |
|---|---|
| 1. Window identity | Swift emits the chosen window's stable handle as `frontWindow`. `snapshot` rejects a switch before the first indexed read; `settle` drops zoom and rereads the full window on an identity change. Same-title switches and same-window renames passed. The zoom's metadata comes from the root's `AXWindow` attribute when available. |
| 2. Overlay starvation | Zoom traversal reads owner-window sheets, then app menus/popovers/drawers, then the root. Mocked execution included overlay controls when the root exhausted the 3,000-node limit and separately the time budget. Parent/current non-zoom execution produced identical nodes and order with both small and budget-exhausting roots: window first, then app overlays. |
| 3. Clipping | The loop covers 64 ancestors and terminates on a cycle. A frameless root behind 17 intermediate groups inherited its viewport; an ordinary framed root inside a window remained zoomable; an unbounded frameless root returned gone. A positioned zero-height ancestor returned gone. The incomplete empty-viewport cases are reported above. Explicit indexed stale reads return `That part of the window is no longer there. Call desktop_snapshot again.` |
| 4. Region overview | Overview entries now come from regions and include scroll areas. Omitted-ID discovery remains incomplete, and filtering regresses as reported above. |

Ran:

```sh
npx vitest run packages/daemon/src/desktop/ax-model.test.ts packages/daemon/src/desktop/ax-helper.test.ts packages/daemon/src/desktop/ax-actions.test.ts packages/daemon/src/desktop/ax-walker.test.ts packages/daemon/src/computer/desktop-engine.test.ts packages/daemon/src/computer/session-engine.test.ts packages/daemon/src/computer/session.test.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/computer/prompt.test.ts packages/daemon/src/approval-gate.test.ts packages/daemon/src/action-gate.test.ts packages/shared/src/approval.test.ts packages/cli/src/action-gate.test.ts
```

Result: exit 0; 13 files, 250 tests passed, including embedded Swift source equality.

Also ran:

```sh
swiftc -typecheck -module-cache-path /private/tmp/rh-stage1c-review-module-cache packages/daemon/src/desktop/ax-helper.swift
```

Result: exit 0. Additional temporary harnesses outside the repository executed the actual TypeScript formatter/engine and extracted Swift `Walker`, `walkOnce`, `frameOf` and `zoomClip` bodies with mocked AX attributes, comparing parent/current behavior where stated. These checks do not establish live app accessibility behavior. No real app actions were performed.

Only this review file was written in the repository. Existing `.gitignore`, `.gitattributes` and prior-review changes were left untouched. No implementation was edited, no graph update was run, and no commit was made.
