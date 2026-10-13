### [P0] An implicit snapshot rebinds old numeric ids to another tab

`packages/daemon/src/browser/engine.ts:860` (also `engine.ts:876`, `engine.ts:989`).

Scenario: the agent saw `[2] button "Next"` on tab A. A subsequent action's follow-up read fails, so `after()` clears `shown`. The user switches to tab B, whose new document assigns node 2 to "Add to cart". Input `[{op:"type",target:"Email",text:"new"},{op:"click",index:2}]` silently snapshots B, validates the old index against B, and clicks Add to cart. The new origin guard succeeds because it also comes from B. The `/tmp` reproduction recorded exactly this click; an index-only call in the same state rejected index 2. Approval checks receive the new label, not the intended old control or tab.

Suggested fix: validate numeric ids against the state available at call entry. If there is no valid shown state, reject every indexed step before taking an implicit snapshot; allow automatic snapshots only for batches whose element steps all use labels. Add a two-document/two-tab regression test after a failed follow-up read.

### [P0] Truncated snapshots turn ambiguous labels into destructive guesses

`packages/daemon/src/browser/targets.ts:48` (also `targets.ts:50`; snapshot truncation at `packages/daemon/src/browser-snapshot.ts:202`).

Scenario: an account list has 251 visible buttons: Remove for record A, 249 other buttons, then Remove for record B. Snapshot drops the final button and sets `omitted:1`. Input `[{op:"click",target:"Remove"}]` resolves the remaining Remove as unique and removes A instead of refusing the ambiguous request. The reproduction returned `ok:true`, node 1, and fired A's click handler once. No snapshot is required before this unsafe action. The action gate sees only "Remove", so even approval of that label cannot disambiguate records.

Suggested fix: fail closed on label resolution when capture is incomplete, or resolve against a complete, bounded page-side candidate search that reports truncation and ambiguity before any batch step runs. Test duplicate labels straddling the 250-action cap using the real snapshot script, including an earlier mutating step that must remain unexecuted.

### [P0] An exact label of the wrong kind redirects typing into another field

`packages/daemon/src/browser/targets.ts:48` (also `targets.ts:56`, `targets.ts:58`; test at `targets.test.ts:29`).

Scenario: account settings contains a button "Email", a textbox "Recovery email", and Save. Input `[{op:"type",target:"Email",text:"new@example.test"},{op:"click",target:"Save"}]` filters out the exact Email button, then accepts the substring match Recovery email. It overwrites and saves the recovery address instead of rejecting the wrong-kind target. The reproduction selected Recovery email with `ok:true`; the existing test explicitly approves this behavior with Email address and an Email button. The page-side label guard validates the substituted field's label, so it cannot detect the original mismatch.

Suggested fix: check exact label matches across all real elements first. If the exact match is incompatible with the operation, return a wrong-kind error with candidates rather than falling through to a different partial label. Add an engine batch test proving no typing or Save click occurs.

### [P0] The expanded batch limit permits actions after a reported timeout

`packages/daemon/src/browser/engine.ts:56` (also `engine.ts:916`, `packages/daemon/src/browser/legacy-port.ts:15`; timeout behavior at `packages/daemon/src/computer/mcp-server.ts:31`).

Scenario: a valid batch has 19 waits of 5000 ms followed by an Add to cart click. The MCP call times out at 90 seconds and releases the serialized queue, but the batch continues and clicks after at least 95 seconds. A retry can therefore add the item twice, or another call can act while the abandoned batch is still running. This batch was rejected by the previous 15-step limit. A scaled reproduction using the MCP server from `8782be3`, the real engine, and linked in-memory transports recorded: timeout returned, retry clicked, retry returned, abandoned batch clicked; two clicks total. The new 30-step acceptance test uses only zero-duration waits and misses this interaction.

Suggested fix: propagate cancellation/deadlines into both engines and check them before every step and after waits/approval, preventing further actions after a timeout. Keep serialization until the abandoned handler has stopped; reject batches whose minimum wait budget already exceeds the deadline. Test a timeout followed by another browser call and assert zero late actions.

### [P1] Tab traverses outer controls before intervening shadow roots and frames

`packages/daemon/src/browser/page-scripts.ts:106` (also `page-scripts.ts:117`; helper at `packages/daemon/src/browser-snapshot.ts:105`).

Scenario: DOM order is First input, a shadow host containing Inner input, Last input. After a snapshot and focus on First, `press Tab` focuses Last instead of Inner. A same-origin iframe between First and Last has the same problem. `deepAll()` gathers every outer-document match before appending nested matches; globally sorting positive tabindex values also ignores focus-navigation scopes. The reproduction returned `focused:"Last"`. The existing shadow test puts the host at the end, where the incorrect traversal accidentally agrees with the expected result. The expected scoped ordering is defined by the [HTML focus-navigation rules](https://html.spec.whatwg.org/multipage/interaction.html#flattened-tabindex-ordered-focus-navigation-scope).

Suggested fix: construct sequential focus order at each host/frame's position, respecting shadow/slot and document scopes and their local tabindex order. Test intervening and nested hosts/frames, slotted controls, positive tabindex inside a shadow root, and reverse traversal.

### [P1] Tab escapes a shadow-root focus trap despite document-level cancellation

`packages/daemon/src/browser/page-scripts.ts:61` (also `page-scripts.ts:326`, `page-scripts.ts:329`).

Scenario: focus is on an input inside an open shadow root, and a document keydown handler cancels Tab to retain focus in a modal. Input `press Tab` emits a KeyboardEvent with the default `composed:false`. The document handler never receives it; `allowed` stays true and the new manual focus movement escapes the trap. The reproduction saw zero document keydown events and moved focus to another control. The cancellation test covers only a light-DOM input. Native keydown is composed according to [UI Events](https://www.w3.org/TR/uievents/#event-type-keydown).

Suggested fix: dispatch keyboard events with `composed:true` from the appropriate document/window, and honor the cancellation result before moving focus. Add cancellation tests at shadow-host and document listeners with actual deep-active-element assertions.

### [P1] A first label-targeted call skips automatic browser setup

`packages/daemon/src/browser/engine.ts:864` (also `engine.ts:869`; existing setup/retry path at `engine.ts:355`).

Scenario: the supported browser has JavaScript from Apple Events disabled, and `autoEnable` can enable the user-approved profile. A first `browser_do([{op:"click",target:"Next"}])` needs a snapshot. Its direct `show()` call catches `js_disabled`, disables the fast path, and throws instead of invoking the existing self-healing path. The next label call goes to legacy and fails because targets are unsupported. The reproduction observed zero autoEnable calls, followed by legacy rejection. An explicit browser_snapshot would have attempted setup.

Suggested fix: route this read-only implicit snapshot through the same availability/setup/retry logic as browser_snapshot, keeping action execution outside that retry. Test first-call label resolution with js_disabled, successful autoEnable, and rejected setup.

### [P1] Hover events cannot reach delegated handlers outside a shadow root

`packages/daemon/src/browser/page-scripts.ts:196` (also `page-scripts.ts:210`).

Scenario: a menu component places its link inside an open shadow root and opens the menu from a host/document mouseover listener, using the event's composed path. Input `hover` on the link returns success, but MouseEvent/PointerEvent initialization omits `composed:true`; over/move events stay inside the root and the menu never opens. The reproduction returned `ok:true` with zero document mouseover events. Manually firing mouseenter on ancestors does not invoke a mouseover handler. The current hover test uses only light DOM.

Suggested fix: give bubbling over/move events their correct composed behavior, using the target's window for event construction. Add a shadow-root menu test that asserts the delegated handler opens its submenu, rather than only checking that selected event names occurred.

### [P2] Tab reports focus on controls that never received it

`packages/daemon/src/browser/page-scripts.ts:112` (also `page-scripts.ts:125`, `page-scripts.ts:334`).

Scenario: before any snapshot, First input is followed by an inert or display:none subtree containing an input, then Last input. The missing cache means visibility/inert checks are skipped, so Tab attempts the unavailable input and reports its label even if the browser refuses focus. Independently, a second summary inside details is selected despite being nonfocusable: the reproduction returned `focused:"Not tabbable"` while activeElement remained the first summary. Repeating Tab can stay stuck because moveFocus returns the attempted node without inspecting actual focus. The existing no-snapshot test has only ordinary visible controls.

Suggested fix: make focusability/visibility checks available without a snapshot, enforce native summary and other control eligibility, and verify deepActive after focus(). Skip candidates whose focus attempt fails; omit focused when nothing moved. Test hidden/inert controls before a snapshot and silent focus refusal.

### [P2] The new-tab result claims an opening after a cancelled click

`packages/daemon/src/browser/page-scripts.ts:179` (also `page-scripts.ts:187`, `packages/daemon/src/browser/engine.ts:76`; test at `page-scripts.test.ts:1063`).

Scenario: an anchor has target=_blank, but its click handler prevents navigation to show a consent dialog or perform an in-page action. Input click still returns `opened:true` and the engine tells the agent that the link opens in a new tab. The reproduction confirmed that result for a cancelled event. The existing hint test cancels every click and nevertheless expects opened, so it enshrines the false inference. The pilot retains the note but has no tabs/focus action to follow its instructions.

Suggested fix: describe the attribute result as an advisory ("may open in a new tab") rather than evidence of an opening, or confirm a new tab through the transport. Check cancelled activation if returning an affirmative result. Test cancelled clicks separately from successful activation and define pilot handoff behavior for confirmed new tabs.

### [P2] The final focus hint can describe an earlier step instead of current focus

`packages/daemon/src/browser/engine.ts:928` (also `engine.ts:955`).

Scenario: with no control focused, input `[{op:"press",key:"Tab"},{op:"click",target:"Go"}]` moves focus to First, then the click's reveal() focuses Go. The returned final state ends with `focus now on: "First"`. The reproduction confirmed actual focus on Go; the pilot parser preserved the false line as a note. A later type, page navigation, or focus-changing handler can similarly invalidate the saved label. The aggregation test supplies fabricated hover responses and never checks actual final focus.

Suggested fix: read actual focus when producing the final state, or invalidate the cached hint after any subsequent action that may change focus and phrase retained information as a past movement. Add an integrated page-script/engine test for Tab followed by click/type and for navigation.

Privacy: no additional password-value, URL, or typed-text leak attributable to these commits was identified in logs, notes, or errors.

P3: no nit findings.

## Verified

- Read `git show 7a00de1`, `git show b02ebe9`, and `git show 8782be3` in that order, including all changed files; read the plan's Global Constraints and Review Focus and the surrounding snapshot, render, engine, legacy, tool-schema, session, approval-gate, MCP timeout, and pilot adapter/parser/loop code.
- Ran graphify query before source searches. Did not update/build the graph because no code was edited.
- Ran `npx vitest run packages/daemon/src/browser packages/daemon/src/fast-lane/pilot packages/daemon/src/action-gate.test.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/computer/session.test.ts`: 21 files passed, 1 skipped; 527 tests passed, 6 skipped; exit 0.
- Ran `npx vitest run packages/daemon/src/computer/mcp-server.test.ts packages/daemon/src/computer/call-log.test.ts packages/cli/src/action-gate.test.ts`: 3 files passed; 22 tests passed; exit 0.
- Ran `npx vitest run packages/daemon/src/fast-lane`: 22 files passed, 3 skipped; 413 tests passed, 10 skipped; exit 0. This overlaps the first run; the counts are not additive.
- Tests ran at working-tree HEAD `91b4afa`. Browser and pilot source/tests have no differences from `8782be3`. Later tool-description/log changes were inspected as surrounding code; the timeout reproduction used the MCP server source at `8782be3`.
- Ran `node /tmp/rh-stage-b-review/repro.mjs`, `node /tmp/rh-stage-b-review/mixed-index-repro.mjs`, `node /tmp/rh-stage-b-review/timeout-repro.mjs`, and `node /tmp/rh-stage-b-review/heal-repro.mjs`; all exited 0. These execute bundled repository scripts/engine against synthetic jsdom pages and fake transports, with the timeout case using real MCP in-memory transport. Reproduced each failing scenario above; the timing experiment scaled seconds to milliseconds.
- Checked that a rejected gate for a label-targeted Delete click receives the resolved label and sends zero action evaluations. Reviewed legacy target/hover validation before execution and existing index-based pilot step construction. Checked unknown hints survive parsing without changing element/header parsing. No additional pilot parser-format regression was found.
- Relevant existing tests exercise password masking in open shadow roots/same-origin frames, extract exclusion, cross-origin frame handling, nested-frame depth limits, stale-document/changed-label guards, and disabled controls. The truncation, focus-order, cancellation, focus-verification, and timing gaps are described above.
- No live-browser/native focus or popup smoke test was run; no real user page or account was touched. The full daemon suite and typecheck were not run.
- Changed only this review file in the repository; left the pre-existing `.gitignore`, `.gitattributes`, and HUD speed-plan changes alone. No fixes or commits.

---

## Disposition, round 1 (author)

1. **P0 implicit snapshot rebinds old ids to another tab: fixed.** A batch that uses any numeric `index` never triggers an implicit snapshot; only all-label batches do. Index steps without a shown page fail as before. Test: two scenarios, zero evaluations.
2. **P0 truncated snapshots turn ambiguous labels into guesses: fixed.** Label resolution fails closed when the snapshot omitted controls or the scan was truncated. The 250 cap now counts controls (a long dropdown counts once and lists at most 120 options) so truncation is rare. Test: duplicate `Remove` straddling the cap, nothing runs, `index` still works.
3. **P0 exact label of the wrong kind falls through to a partial match: fixed.** An exact match of another kind now fails with the candidates; the fallback is only a unique label that *starts with* the target at a word boundary ("Recovery email" no longer matches "Email"). Tests in `targets.test.ts` and an engine test proving no typing and no Save.
4. **P0 30-step batches can outlive the 90 s tool timeout: mitigated.** Total `wait` per call is capped at 30000 ms (engine and legacy), so a batch finishes well inside the timeout. **Deferred:** real cancellation of an abandoned handler (pre-existing behaviour of the MCP server; documented in `docs/development.md`).
5. **P1 Tab order ignores shadow hosts and frames: fixed.** Flat-tree order (shadow children, slots expand to assigned nodes, frames at their position). Positive tabindex is still ordered page-wide (documented approximation).
6. **P1 Tab escapes a shadow focus trap: fixed.** Key events are composed and a cancelled `keydown` leaves focus alone. Test with a document-level handler.
7. **P1 first label call skips automatic setup: fixed.** The implicit snapshot goes through the same `run()` path as `browser_snapshot` (auto-enable, retry, fallback). Tests: heals once and proceeds; refused setup falls back.
8. **P1 hover cannot reach delegated handlers across a shadow root: fixed.** Over/move events are composed and built from the element's window. Test: document-level `mouseover` fires once.
9. **P2 Tab reports focus on controls that never got it: fixed.** Effective `tabIndex`, disabled/hidden/inert checks without a snapshot, and focus is verified through the deep active element; refused candidates are skipped, nothing is reported when focus did not move.
10. **P2 new-tab hint after a cancelled click: fixed.** The hint is dropped when the page cancels the click (window-level bubble listener). **Deferred:** pilot handling of the hint (pilot treats it as a plain note; it has no tab actions).
11. **P2 final focus hint stale after later steps: fixed.** A later click/type/select/check or a navigation drops the earlier Tab report.
