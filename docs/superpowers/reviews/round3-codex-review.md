### [P0] Refreshing labels rebinds an old numeric id in a new document

`packages/daemon/src/browser/engine.ts:883`, `packages/daemon/src/browser/engine.ts:896`, `packages/daemon/src/browser/engine.ts:915`

Scenario: snapshot tab T with `[1] Open details`; T subsequently navigates or reloads. The replacement document allocates node 1 to Delete account and node 2 to Menu. Run `[{op:"click",index:1},{op:"hover",target:"Menu"}]`. Because one step has a target, the new refresh replaces both the saved state and its document origin. Planning now interprets the model's old index 1 as Delete account and passes the replacement document's origin to the action guard. The actual engine/page-script experiment ran the Delete handler once and returned `did: click, hover`. Disabling only the new refresh branch made the same attempted action fail stale with zero clicks. Pinning a tab does not pin its document. This also affects a shown context with no concrete tab when the front tab changes.

Suggested fix: preserve the document identity and numeric-node bindings the model saw. For any batch containing an index, reject a refresh whose origin differs; validate every numeric binding against the original state. Refresh labels into separate state rather than silently replacing the indexed state. Add navigated-tab and unpinned-tab mixed-batch tests; the new numeric-id test uses the same document and does not exercise this case.

### [P0] Overlapping calls overwrite and clear each other's deadline

`packages/daemon/src/browser/engine.ts:269`, `packages/daemon/src/browser/engine.ts:585`, `packages/daemon/src/browser/engine.ts:862`, `packages/daemon/src/computer/mcp-server.ts:39`

Scenario: call A is waiting at its approval gate when MCP times it out and advances the queue. Call B begins another `browser_do` on the same engine. B replaces `this.deadlineAt` with B's later deadline. A's approval resolves after A's deadline: A now passes B's deadline check and clicks. A's `finally` then sets the field to null, disabling B's post-approval check too. A fresh experiment used the real MCP server, real engine and actual page scripts, a 60 ms outer timeout to reproduce queue abandonment, and an injected engine clock to model seconds: A timed out, B started at 90,001 ms, A clicked at 92,000 ms, and B clicked at 160,000 ms. Both were beyond their own 60-second cutoffs. No user account was involved.

Suggested fix: keep an immutable deadline/cancellation token local to each invocation and pass it through planning, approval and actions. Never let another call extend or clear it. Propagate MCP abandonment into the handler, and prevent abandoned work from mutating shared shown state or performing subsequent actions. The single-call deadline tests cannot detect this collision.

### [P1] The enlarged dropdown cap overflows the browser transport

`packages/daemon/src/browser-snapshot.ts:48`, `packages/daemon/src/browser-snapshot.ts:191`, `packages/daemon/src/browser-snapshot.ts:254`, `packages/daemon/src/browser/transport.ts:35`

Scenario: a questionnaire has 40 visible dropdowns, each with 501 choices and a 900-character question label. This is within the control limit and the 500-unselected-option limit. The actual light snapshot emitted **20,678,591 bytes**, because the complete question is repeated in every option action. The same fixture with the pre-`edf7c4c` snapshot emitted **4,959,010 bytes**. The production transport allows only 16 MiB; forwarding the current output through `execFile` with that exact limit reproduced `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Normalization would render only about 9 KB, but it happens after transport. Snapshot/find and label batches cannot read this page on the fast path; a Safari user cannot use the Chrome-only fallback. Across 250 dropdowns the new limits permit 125,000 serialized option actions.

Suggested fix: serialize one control with a bounded options array instead of repeating the control label per option, and impose a total byte/option budget before serialization with truthful omission metadata. Add a transport-size test. The 800-option test verifies one dropdown's count, not aggregate output size.

### [P2] Standard contenteditable spellings still get skipped by Tab

`packages/daemon/src/browser/page-scripts.ts:123`, `packages/daemon/src/browser/page-scripts.ts:134`, `packages/daemon/src/browser/page-scripts.ts:161`

Scenario: First input, `<div contenteditable aria-label="Editor">`, Last input. The fresh action-script experiment moved First directly to Last. `contenteditable="plaintext-only"` does the same. Although the new `tabOrder` handles editing hosts, those hosts never reach it: collection requires the literal attribute value `true` unless another selector matches. Both are standard editing-host forms, per the [HTML contenteditable definition](https://html.spec.whatwg.org/multipage/interaction.html#attr-contenteditable). The new test uses only `contenteditable="true"`, so it passes with this omission.

Suggested fix: collect all contenteditable candidates and determine actual editing-host eligibility, including the empty, plaintext-only and case-insensitive true forms. Keep false/non-editing descendants out unless independently tabbable. Test these spellings in forward and reverse navigation. Native-browser execution was unavailable; the omission itself is established by the selector and actual script run.

### [P2] The transform guard checks width only

`packages/daemon/src/browser-snapshot.ts:153`, `packages/daemon/src/browser-snapshot.ts:156`, `docs/development.md:156`

Scenario: a 200×200 same-origin frame uses `scaleY(.5)` and occupies 200×100 parent pixels. A child button at local y=150 is displayed near parent y=75. Width still equals `offsetWidth`, so the new check reads the frame, adds unscaled offsets and invents a y=150 rectangle instead of reporting an unreadable frame. With a 100-pixel parent viewport this drops a visible control. A 180-degree rotation or reflection also preserves bounding width and is incorrectly accepted. The fresh geometry probe returned the child at `(20,150)` and no frame note. The guide's assertion that scaled or rotated frames are treated as unreadable is false.

Suggested fix: validate the complete transform mapping, including height, reflection/rotation and transformed ancestors, or reject non-translation mappings conservatively. Merely checking both bounding dimensions will still miss reflection and 180-degree rotation. The tests cover a width-changing scale only. This is a layout-model experiment using [CSSOM's transformed rectangles and untransformed offset dimensions](https://drafts.csswg.org/cssom-view/), not a successful native-browser run.

### [P2] Extraction still misclassifies boxless shadow content and invisible slots

`packages/daemon/src/browser/page-scripts.ts:451`, `packages/daemon/src/browser/page-scripts.ts:476`, `packages/daemon/src/browser/page-scripts.ts:484`

Scenario 1: an open shadow root on a `display:contents` host contains the visible invoice text directly. The snapshot now reads it, but extraction returns an empty string because `hidden(host)` rejects the host before descending. The fresh probe modeled only the native primitive `host.checkVisibility() === false`; [checkVisibility rejects an element without its own box](https://drafts.csswg.org/cssom-view/#dom-element-checkvisibility), which does not establish that its rendered descendants are hidden.

Scenario 2: `<x-a>Hidden account text</x-a>` has shadow markup `<slot style="visibility:hidden"></slot>`. The new explicit slot check looks only at `display`, and assigned Text nodes bypass all further visibility checks. Actual extract returned `Hidden account text`. The explicit hidden/aria-hidden/inert/display-none tests do not exercise CSS visibility. The plain-slot and direct-shadow-text fixes therefore do not establish visible-text extraction for these new contexts.

Suggested fix: distinguish a missing box from explicit flat-tree hiding. Traverse boxless hosts, and check rendered text plus inherited visibility/opacity in its assigned slot context before including it. Add both fixtures with browser-backed visibility assertions when native coverage is available.

### [P2] Tab keeps iterating after its node budget is exhausted

`packages/daemon/src/browser/page-scripts.ts:133`, `packages/daemon/src/browser/page-scripts.ts:136`, `packages/daemon/src/browser/page-scripts.ts:141`, `packages/daemon/src/browser/page-scripts.ts:150`

Scenario: a large body, shadow root or slot exposes 500,000 children. The new Tab walker stops processing candidates after 100,000 elements, but every parent loop continues calling `walk` on the entire remaining tail. A fresh instrumented child iterator yielded all **500,000** entries. The similarly instrumented extract walker, fixed in this commit, stopped after **200,001** entries. Each Tab on a wide page repeats the uncapped tail work on the browser thread; the comment claiming bounded node visits is false. A huge text/comment tail is not even counted by the element counter.

Suggested fix: stop each parent iterator immediately at exhaustion, share a budget that includes all visited nodes, and avoid materializing unbounded slot-assignment arrays where possible. Add iteration-count tests for Tab, not just output or focus assertions.

### [P2] A nested click overwrites the cancelled link event

`packages/daemon/src/browser/page-scripts.ts:251`, `packages/daemon/src/browser/page-scripts.ts:254`, `packages/daemon/src/browser/page-scripts.ts:255`

Scenario: a `_blank` link's click handler prevents navigation and forwards the action with `otherButton.click()`. The new capture listener stores the link event, then overwrites it with the nested button event. After dispatch it inspects the uncancelled button event and returns `opened:true` although the link was cancelled. The fresh actual-script fixture reproduced this. The previous bubble watcher retained cancellation of the original event. An existing window capture listener that calls `preventDefault()` plus `stopImmediatePropagation()` also leaves `clickEvent` null and produces the same false hint. Ordinary target-level `stopPropagation` is fixed, but the new test covers only that case.

Suggested fix: retain the first activation event for the intended element and never overwrite it with nested events. When no activation event could be observed, report uncertainty rather than affirmative opening. Keep attribute-based hints qualified; they are not observations of an actual new tab.

## Round 1 verification

Numbers refer to each author's disposition list. “Confirmed” below is scoped to the reported counterexample and pinning test, not an assertion of native-browser equivalence.

- **A1, legacy nested-control wrong-coordinate click → confirmed.** The full-mode exclusion test passed. Fresh complete serialized full snapshots were byte-identical to `main` on a fixture with text, a button, field, dropdown, password, shadow root and frame. Nested controls were absent. This removes that newly introduced legacy coordinate regression.
- **A2, slotted destructive label substitution → confirmed for naming and ordinary extraction.** Pinning tests passed; a fresh assigned Delete account/fallback Save fixture rejected the Save guard with zero clicks. Assigned content appears once. CSS-hidden extraction remains defective above.
- **A3, nested plaintext in full snapshots → confirmed for the new surface.** Pinning tests and the fresh full-mode comparison excluded both nested secrets. **Deferred top-document guard plaintext → accepted only as a pre-existing issue outside this diff**, not as a privacy guarantee or a claim that passwords never leave the page. The fresh full snapshot still contained TOPSECRET.
- **A4, global bounded work → NOT FIXED as the original total-work promise; accepted only as the later, narrower discovery limit.** The shared root-discovery, nested-control and nested-text pinning tests passed. Top collection/processing remains uncapped. Fresh extract parent iteration stopped at 200,001 entries; the separately reported Tab walk did not. Documentation now distinguishes discovery from total work; that is an accepted description of the limit, not proof of responsiveness on a large page.
- **A5, shadow input notification → confirmed.** The host-level input-listener test passed; the event is composed. Keyboard and over/move event composition is pinned separately.
- **A6, frame event realm/view → confirmed.** Tests asserted the frame's own KeyboardEvent/MouseEvent constructors and view, and passed. No native event behavior is inferred from these unit tests.
- **A7, disabled ancestor outside a shadow root → confirmed.** The action-refusal test passed after the host becomes aria-disabled; no click runs.
- **A8, intermediate frame clipping → confirmed for the original nested clipping fixture.** Its test and the new border-box test passed. **NOT FIXED for the broader transform claim**, as above.
- **A9, frame-only delta changes → confirmed.** Appearing/changing/removal tests passed; fresh recovery emitted the frames-gone note. The round-1 quiet-removal behavior has intentionally changed in round 2.
- **A10, offscreen/hidden frames and origin wording → confirmed for the pinned cases.** Offscreen, hidden and depth-boundary tests passed; changed production wording uses same-origin/unreadable terminology and now names depth. Native opaque-sandbox behavior was not tested here.
- **A11, direct shadow text → confirmed for snapshots, including a boxless host.** Both direct-text tests passed. This does not fix boxless-host extraction, as above.
- **A12, editor test manufactures insertion → confirmed for the unit-test repair.** It now checks that the frame selection covers `old text` as well as asserting replacement content. **Deferred native-browser coverage → accepted as an explicitly disclosed environment limitation only**; it is not evidence of native editing correctness.
- **B1, implicit snapshot rebinds ids without a shown page → confirmed for both original mixed-order cases.** Tests reject with zero evaluations. The latest shown-page refresh introduces a different numeric-rebinding regression, above.
- **B2, ambiguous labels behind control/scan caps → confirmed.** Target/engine cap-refusal tests passed, including no action evaluations and continued explicit-index support. One dropdown counts once. The new aggregate output failure remains above.
- **B3, wrong-kind exact match and unsafe prefix → confirmed for the original case and Unicode boundary repair.** Tests passed; fresh Email𝕚ng-list targeting refused Email. Code-point letters, digits and combining marks are covered.
- **B4, batch timeout → mitigation partly confirmed, safety claim NOT FIXED.** Tests pin the 30,000 ms wait cap and an isolated fast call's step/post-approval cutoff. The shared-deadline collision defeats that cutoff. Fresh `LegacyBrowserPort.do` using the real BrowserDriver with mocked script/CDP transport approved at 95,000 ms, then performed one DOM click and one CDP dispatch: the legacy cutoff is checked only before entering clickIndex, not after its approval gate. **Deferred cancellation / accepted stalled-step limit → not accepted as a safety resolution for ordinary accounts.** A timed-out operation can still act after the queue advances. The guide's “finishes before” and universal post-approval assertions remain false.
- **B5, flat-tree Tab order → confirmed for simple shadow/frame/slot fixtures.** **Page-wide positive-tabindex approximation → accepted only as a clearly stated ordering limitation**, not as native equivalence. **Negative owner scopes remain NOT FIXED:** fresh Tab entered an inner input under a shadow host with tabindex=-1; the documented positive-order qualification does not cover this. The [HTML focus-scope rules](https://html.spec.whatwg.org/multipage/interaction.html#tabindex-ordered-focus-navigation-scope) exclude negative owners before flattening.
- **B6, shadow Tab cancellation → confirmed.** The composed document-level cancellation test passed and retained the actual inner focus.
- **B7, first label call automatic setup → confirmed.** Auto-enable/retry and refused-setup tests passed. Real fallback still rejects target labels, as the fallback tests state; the permissive fake does not establish fallback label support.
- **B8, delegated shadow hover → confirmed.** Document-level mouseover received the composed event in the pinning test.
- **B9, attempted focus reported as actual focus → confirmed for the original invalid/refused/hidden candidates.** Pinning tests verify the deep active element. Contenteditable spellings remain defective above.
- **B10, cancelled-link hint → confirmed for ordinary cancellation and the newly pinned target-level stopPropagation case; NOT FIXED generally.** Nested activation and early capture cancellation still return opened:true, above. **Deferred pilot tab handling → accepted as a feature limit**, because the pilot has no tab operations; the note must remain an advisory hint, not confirmation of a tab.
- **B11, final focus hint → confirmed for later click/type/select/check/hover/other-key invalidation; NOT FIXED for asynchronous changes.** Pinning tests passed. Fresh Tab→wait changed actual focus from B back to A during the wait, yet the result said `focus now on: "B"`. Scroll handlers and settling can likewise change it. Read final actual focus or omit the assertion; preserving wait/scroll does not justify the guide's “any later step” guarantee.
- **C1, unseen-page duplicate-label guidance → confirmed for cap refusal and the fresh-at-call-start duplicate case.** Engine/target tests passed. This does not endorse the numeric refresh regression.
- **C2, click substitution for CSS hover → confirmed in the active descriptions and guide.** Tool tests forbid the old instruction and require “not a substitute.”
- **C3, concurrent log rewriting → confirmed that rewriting is removed; accepted limit for best-effort rotation.** The rotation test preserves the single-process chunk. Competing rotations can lose an older chunk; that limit is now qualified in the source and is acceptable for diagnostics that do not authorize actions. This is not confirmation of unconditional cross-process retention.
- **C4, disk-full trimming destroys history → confirmed for removal of destructive trimming.** Rotation tests passed; no truncate/rewrite path remains. The torn-append recovery is separately confirmed below.
- **C5, wall-clock duration → confirmed.** Exact injected durations and the new default-clock test passed. A fresh default-Date.now mutant failed the new default-clock assertion with 0 ms, proving the test now protects the production default.
- **C6, SDK-validation failures missing → accepted as the documented logging boundary.** A fresh MCP/logger probe recorded two handler calls and no record for invalid arguments. It did not serialize the private arguments, results, URL or error text.
- **C7, constant-zero / queue-wait timing test → confirmed.** The test asserts 400 and 7 exactly; those assertions passed. The default clock is additionally pinned now.
- **C8, Tab descriptions → NOT FIXED as a general focus/order guarantee.** Original counterexamples are confirmed fixed under B5/B9; remaining editor forms, negative scopes and stale final focus are concrete failures above.
- **C9, action frame notes → confirmed for frame-count transitions.** Rendering/engine tests passed; recovery notes were freshly exercised.
- **C10, same-site terminology → confirmed in changed production tool, skill and guide text.** Skill synchronization tests passed. Frame availability remains subject to visibility, depth, origin and geometry; transformation prose is still false above.
- **C11, total scan bound → NOT FIXED as the original bound; accepted as the revised discovery-only statement**, for the same reasons as A4. It cannot be used to claim a bounded total browser evaluation.

## Round 2 verification

Each item below corresponds to a disposition claim in the two specified round-2 reports, including overlapping claims.

- **R2a contenteditable Tab → confirmed for literal true; NOT FIXED for all editing hosts**, as the new empty/plaintext-only probes show.
- **R2a/R2b frame borders/transforms and A8 → confirmed for borders and width-changing scale; NOT FIXED for Y-only scale, rotation/reflection.** Both pinning tests passed; the fresh width-preserving transform probes reproduced the remaining failure.
- **R2a/R2b hidden slots → confirmed for hidden, aria-hidden, inert and display:none; NOT FIXED for CSS visibility:hidden assigned text.** Plain-slot expansion remains confirmed.
- **R2a option cap/count → confirmed for truthful omitted counts.** Fresh 800-choice normalization rendered eight shown plus 792 unshown, and selecting value 799 succeeded. **Bounded incomplete option discovery → accepted when the omission is disclosed**; browser_find cannot find an uncaptured choice. The enlarged serialization budget introduces the P1 regression above.
- **R2a/R2b scan delta/find notes → confirmed.** Delta truncation/recovery and frame removal tests passed; fresh recovery emitted both notes, and the engine find test includes frame/scan notes.
- **R2a depth wording → confirmed.** The production note explicitly includes nesting depth and its test passed.
- **R2a A4 narrowed bounds / extract parent loops → accepted for the documented discovery limit; confirmed for extract loop termination.** The instrumented extract yielded 200,001 of 500,000 entries. Tab still has an uncapped tail.
- **R2a A9 removal → confirmed.** Fresh removal emitted the frames-gone note.
- **R2a A11 boxless direct shadow text → confirmed in snapshot; extraction remains defective.** The snapshot pinning test passed.
- **R2a A12 editor unit mock → confirmed.** Selection coverage and inserted content are both asserted by the passing test. **Native coverage remains accepted only as unavailable evidence**, not certification.
- **R2a B3 Unicode boundary → confirmed.** Pinning tests and the supplementary-letter refusal probe passed.
- **R2a B4 deadline/cancellation → NOT FIXED as an account-safety claim.** Isolated fast cutoff tests passed; overlapping deadlines and the actual legacy post-approval probe failed the claimed protection. **Deferred cancellation / late stalled step → not accepted for shipping safety**, as under B4 above.
- **R2a/R2b B5 ordering qualification → confirmed as prose; accepted only for page-wide positive ordering.** Negative-owner scope inclusion is outside that qualification and remains NOT FIXED.
- **R2a/R2b B10 cancelled-link capture → confirmed for the reported stopPropagation case; NOT FIXED for nested click and earlier capture-stop cases**, as above.
- **R2a/R2b B11 focus invalidation → confirmed for hover and other key steps; NOT FIXED for a final focus guarantee across wait/scroll/settling.** The fresh wait probe reports the wrong control.
- **R2a A3 legacy top password deferral → accepted only as a pre-existing issue outside this diff.** Fresh full-mode output still contains it; no general password-export guarantee is accepted.
- **R2b fresh-label duplicate → confirmed for a duplicate added before call start.** The engine pinning test refuses before any action. **Mixed numeric ids across document changes are unsafe**, as the new P0 reproduction establishes.
- **R2b torn append → confirmed.** Pinning test passed; fresh torn JSON followed by a record placed the complete record on its own parseable line. The documented reader skips the torn line.
- **R2b closed-root/small-frame/depth qualifications → confirmed as the explicit limits now stated in the guide and descriptions.** They do not establish that nothing is missed. Transformation assurance remains false.
- **R2b default-clock regression test → confirmed.** Normal test passed; the freshly bundled Date.now mutant failed exactly the new default-clock test (12 other tests passed).
- **R2b legacy top-document statement → confirmed as corrected.** It now qualifies the snapshot and separately describes extract. Fresh actual LegacyBrowserPort extraction returned `Shadow only`.
- **R2b C3 log comment → confirmed as qualified; accepted for best-effort diagnostics**, under C3 above. **C11 bounds wording → accepted as narrowed**, under A4 above.
- **R2b claimed full-suite pass → not confirmed in this environment.** The exact requested daemon/CLI command failed before collection because Cloudflare inspector startup could not listen on port 9229. This is an environment failure, not evidence that the author's external run did or did not pass.

## Verified

- Reviewed HEAD `edf7c4cb576b2d8c90250eb855b5e99e21ef993d`, `git log --oneline main..HEAD`, the fix diff, and the whole `git diff main...HEAD` implementation/test changes. Read the specified dispositions separately and audited changed tool/prompt/skill/guide text, snapshot consumers, legacy driver, transport, pilot parser, action gates and MCP queue. Queried the existing graph before source searches. No code or graph was edited.
- Ran `npx vitest run packages/daemon/src/browser/page-scripts.test.ts packages/daemon/src/browser/targets.test.ts packages/daemon/src/browser/engine.test.ts packages/daemon/src/browser/legacy-port.test.ts packages/daemon/src/browser/render.test.ts packages/daemon/src/computer/call-log.test.ts packages/daemon/src/computer/mcp-server.test.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/computer/prompt.test.ts packages/cli/src/system/operator-skill.test.ts`: **10 files, 331 tests passed**, exit 0.
- Ran `npx vitest run packages/daemon/src/fast-lane/pilot packages/daemon/src/browser/transport.test.ts packages/daemon/src/computer/session.test.ts`: **8 files passed, 1 skipped; 163 tests passed, 6 skipped**, exit 0.
- Ran `npx vitest run packages/daemon/src/browser-driver.test.ts packages/daemon/src/browser-snapshot.test.ts packages/daemon/src/guidance/browser-guidance.test.ts packages/daemon/src/guidance/browser-overlay-script.test.ts`: **4 files, 40 tests passed**, exit 0. Together the normal targeted runs executed **534 passing tests**.
- Ran `npx vitest run packages/daemon packages/cli`: **startup failure, no tests collected**, `listen EPERM 0.0.0.0:9229`. Output: `/tmp/r3-review/full-tests.log`. No full-suite success claim is made.
- Ran `NODE_PATH=/Users/kushal/Desktop/project/remote-hands/node_modules npx vitest run packages/daemon/src/computer/mcp-server.test.ts --config /tmp/r3-review/mutant.config.mts` against a fresh temporary default-Date.now mutant: **12 passed, 1 intentionally failed**, at the new default-clock assertion. An initial attempt without NODE_PATH failed module resolution and is not mutation evidence. Repository source was never replaced.
- Fresh source bundles and experiments are in `/tmp/r3-review/`: `repro.cjs`, `extra.cjs`, `verify.cjs`, `hints.cjs`, `legacy-compare.cjs`, `option-regression.cjs`, `output-limit.cjs`, `revert-refresh.cjs`, `mcp-privacy.cjs`. Completed corrected probes exited 0. They use actual exported implementations with isolated jsdom pages, explicit geometry/visibility models, mocked transport/approval, instrumented iterators, an actual MCP client/server, and real child-process buffering where specified. No real account action was performed. Initial module-path/legacy-fixture setup failures were corrected before using results.
- Isolated headless Chrome launch with a fresh `/tmp` profile exited **134** before rendering a trivial fixture. Native-browser focus, selection, layout and slot visibility remain unverified. The linked primary specifications support the stated distinctions; mocked geometry is not described as native validation.
- No newly introduced page-content leak into the production call log was found. Fresh end-to-end records contained only fixed tool names, timestamps, durations, status and fixed outcome classes, despite private arguments/results/errors. This does not erase the explicitly deferred legacy full-snapshot password issue.
- **P0/P1 defects were found. This branch is not safe to ship to ordinary users with real accounts in its current state.** Passing unit tests do not protect the wrong-document numeric action, abandoned-call deadline collision or aggregate transport-size failure.
- Wrote only `docs/superpowers/reviews/round3-codex-review.md`; no fixes or commits. Left the pre-existing `.gitignore`, `.gitattributes` and `docs/superpowers/plans/2026-10-04-hud-speed.md` changes untouched. No graph update was needed because no code was edited.

---

## Disposition, round 3 (author)

Fix commit: `d4505f5`. Each new test was confirmed to fail on the previous source (14 failures).

- **P0 label refresh rebinds an old id in a new document: fixed.** If the refreshed page is a different document than the one the model saw, a batch containing a numeric `index` is rejected with "The page was reloaded or replaced…" and the engine forgets its state, so later stale ids fail instead of landing on new elements. Label-only batches are described relative to what the model last saw, so the new page appears as "changed" with its new ids. Tests: replaced document (also asserts a following `browser_click(1)` fails), label-only navigation, same-document mixed batch.
- **P0 overlapping calls overwrite each other's deadline: fixed.** The deadline is a local value passed into planning and `act`; there is no shared field. Test: call A waits at its gate, call B starts and finishes, A's approval returns late and is refused while B acted.
- **P1 dropdown cap overflows the bridge: fixed.** A 3000-choice budget for the whole page (500 per dropdown, at least one per dropdown so the control stays visible), with truthful `…(+N)` counts. Test: 40 dropdowns of 501 choices with 900-character labels stay under 8 MiB (they were 20.7 MB).
- **P2 contenteditable spellings: fixed** (`contenteditable`, empty, `plaintext-only`, mixed case; `false` stays out). **P2 transform check width only: fixed** (any non-translation transform on the frame or an ancestor, plus width and height mismatch; tests for Y-scale, 180° rotation, 90° rotation, and a pure translation that stays readable). **P2 extract misclassifies boxless hosts / CSS-hidden slots: fixed** (`display: contents` is not hidden; a slot with `visibility: hidden` is skipped). **P2 Tab keeps iterating after its budget: fixed** (parent loops stop; test counts yielded nodes). **P2 nested click overwrites the cancelled event: fixed** (first event kept; an unobservable click makes no claim).
- **Round 1/2 items you still list as not fixed:**
  - **A4 total-work bound: accepted, documented** as a discovery limit; top-document collection stays native and uncapped by design.
  - **B4 cancellation: accepted limit, now stated plainly.** Per-call 60 s limit on the fast path including after approval; the legacy path cannot re-check after its internal approval wait; real cancellation of an abandoned call is not implemented. This is called out in the final report to the user.
  - **B5 negative owner scope: fixed** (a host with negative `tabindex` keeps its shadow tree out of the tab order). Page-wide positive tabindex ordering stays an approximation, documented.
  - **B11 asynchronous focus: documented, partly mitigated.** The line is now worded as what Tab did (`tab moved focus to`), dropped after any later step or wait; focus moved later by page scripts cannot be seen.
  - **A3 top-document password in legacy guards: unchanged, pre-existing, listed in the final report.**
  - The full-suite sandbox failure (port 9229) is an environment limit for the reviewer; the author's run passes (96 files, 1664 tests).
