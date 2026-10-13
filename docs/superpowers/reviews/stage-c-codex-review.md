### [P0] Unseen-page label guidance can click the wrong Save button

`packages/daemon/src/computer/tools.ts:176`, `.agents/skills/remote-hands-operator/SKILL.md:63`, `packages/cli/src/system/operator-skill.ts:67`, `packages/daemon/src/computer/prompt.ts:9`

The new instructions recommend labels before seeing the page and promise ambiguous labels fail. Input: two account panels each have a visible `Save` button, with a country selector containing 250 options between them; call `browser_do([{op:"click",target:"Save"}])` without a snapshot. The snapshot's 250-action cap includes the first Save and 249 select-option actions, omitting the second Save (`browser-snapshot.ts:202`). Resolution only checks the captured elements (`targets.ts:49`). The actual engine experiment returned `did: click` and invoked the wrong panel's handler once, with no ambiguity error. Identity/label guards cannot distinguish these two labels.

Suggested fix: refuse label resolution on incomplete snapshots, or resolve against a complete, bounded candidate search that can prove uniqueness. Remove the unqualified safety promise and unseen-page recommendation until that holds. Add an engine test with duplicate labels separated by a large select.

### [P0] CSS-hover guidance instructs an unrelated click

`packages/daemon/src/computer/tools.ts:176`

Input: a menu parent reveals choices only through CSS `:hover`, while its click handler navigates or changes the account. The description says “click them instead.” Clicking executes `el.click()` (`page-scripts.ts:185`); it does not establish CSS hover. Following this instruction performs the parent action instead of opening the menu. A throwaway page confirmed the parent's click handler runs. The label gate sees the parent label, not the action hidden in that handler.

Suggested fix: remove the click substitution. Describe CSS-hover menus as unsupported by this synthetic hover operation; use a supported desktop interaction or an independently identified menu toggle. Add a description assertion preventing this unsafe instruction.

### [P2] Concurrent trimming overwrites completed call records

`packages/daemon/src/computer/call-log.ts:35`

Input: two MCP servers share the home directory and the log exceeds 200000 bytes. Server A reads the log for trimming; server B appends and finishes; A writes its earlier snapshot back. B's record disappears. The read/overwrite transaction has no cross-process coordination. A deterministic experiment paused A after its read, ran B's actual logger in a child process, then resumed A: B's completed record was absent. Overlapping truncations/writes can also damage JSONL.

Suggested fix: coordinate append and rotation across processes, with a bounded best-effort lock or separate per-process logs. Atomic rename alone does not prevent losing intervening appends. Add a multi-process regression test.

### [P2] Disk-full trimming destroys the existing log

`packages/daemon/src/computer/call-log.ts:37`, `packages/daemon/src/computer/call-log.test.ts:34`

Input: the threshold is exceeded and the truncating `writeFileSync` runs out of space. Opening with the default `w` flag destroys the original log before the replacement succeeds. The catch preserves the tool result but leaves a partial JSON line, breaking the documented `jq -s` command. An injected ENOSPC after 123 bytes reproduced this: the logger returned normally, the old history was gone, and the retained tail was invalid JSON. The trim test only checks at most 1000 lines and the last record; retaining just one line would pass.

Suggested fix: write a temporary replacement completely and atomically replace the log only on success, under the same coordination as appends. Test failed append/write/stat/read paths, valid JSONL, and retention of exactly the newest 1000 records from a larger valid log.

### [P2] Wall-clock adjustments produce invalid elapsed timings

`packages/daemon/src/computer/mcp-server.ts:52`, `packages/daemon/src/computer/mcp-server.ts:65`

Input: macOS corrects the system clock backwards while a handler runs. Both endpoints use `Date.now()`, so `ms` becomes negative; a forward correction inflates it. A handler with a simulated 60-second backwards adjustment emitted `ms: -59998`. These values feed the documented latency percentile calculation.

Suggested fix: keep wall time for `at`, but measure elapsed work with a monotonic clock such as `performance.now()`. Test backwards and forwards wall-clock changes as well as exclusion of queue wait.

### [P2] Schema failures are missing from the promised per-call log

`packages/daemon/src/computer/mcp-server.ts:49`, `docs/development.md:158`

Input: call an existing tool with invalid arguments, for example a numeric value where its schema requires a string. The SDK rejects the request before invoking the registered callback, so `onCall` never runs. A valid request followed by a schema-invalid request produced only one record. The documentation and callback comment promise every call, including failures, but these errors are absent from the diagnostics.

Suggested fix: either instrument validation failures at the request boundary using only the registered tool name and fixed outcome class, or explicitly document that only handler invocations are logged. Add a schema-failure logging test without recording argument values or SDK error text.

### [P2] The elapsed-time test accepts a logger that always reports zero

`packages/daemon/src/computer/mcp-server.test.ts:59`

Input: replace the elapsed measurement with constant zero. The new test still passes because it only asserts the quick call is below 100 ms; the other timing assertion accepts every nonnegative number. The 120 ms slow call is never checked. This would make the speed diagnostics useless while passing the added tests.

Suggested fix: use controlled timers and assert both measured handler durations, with a queued call's duration independent of its wait. Require the slow record to reflect the slow handler's elapsed time.

### [P2] Tab descriptions overpromise focus order and focus reporting

`packages/daemon/src/computer/tools.ts:176`, `docs/development.md:156`

Input: `First` input, an open shadow host containing `Inner`, then `Last` input; focus First and press Tab. The script reports/focuses Last, skipping Inner because `gather` collects all main-document controls before shadow descendants (`browser-snapshot.ts:106`). Input: a nonfocusable `<div tabindex="wat" aria-label="Not focusable">` between two inputs; Tab returns `focused: "Not focusable"` while actual focus stays on the first input. `moveFocus` returns the attempted element without checking focus (`page-scripts.ts:125`). Both results contradict “next or previous control” and “says which one has focus.” In addition, a document-level cancelling keydown listener receives no Tab from a focused shadow input because the synthetic keyboard event is not composed; the script moves focus anyway.

Suggested fix: build focus order across shadow/frame boundaries in the correct position, reject elements whose effective tabIndex is negative, dispatch composed keyboard events, and report the actual deep active element. Qualify the descriptions until these cases work. Add tests for a shadow host between controls, failed focus, and cancellation across a shadow boundary.

### [P2] Frame-note guarantee is false for action results

`packages/daemon/src/computer/tools.ts:141`, `.agents/skills/remote-hands-operator/SKILL.md:63`, `docs/development.md:156`

Input: an action inserts a visible unreadable iframe without changing the page title, URL, text or controls. Although the snapshot counts it, `renderDelta` ignores `blockedFrames` and returns `no visible change` (`render.ts:198`). A throwaway delta from zero blocked frames to one reproduced the missing note. Ordinary action results therefore do not reliably tell the agent to switch to desktop tools as the new prose promises; the skill also tells it never to snapshot after an action.

Suggested fix: include blocked-frame notes and changes in delta rendering, including the no-change path. Add an action/delta test where only the frame count changes, or limit the claim explicitly to full snapshots.

### [P2] Same-site iframe support is incorrectly advertised

`packages/daemon/src/computer/tools.ts:141`, `.agents/skills/remote-hands-operator/SKILL.md:63`, `packages/cli/src/system/operator-skill.ts:67`

Input: `https://www.example.com` embeds `https://checkout.example.com`. These are same-site but different origins; `contentDocument` is inaccessible and the controls are omitted (`browser-snapshot.ts:116`). The newly added tool and skill text says same-site frames are included and describes blocked frames as being from another website. Sandboxed same-origin URLs without `allow-same-origin` are also unreadable. `docs/development.md` uses the more accurate same-origin term but omits the sandbox qualification.

Suggested fix: consistently say accessible same-origin frames and open shadow roots; describe notes as unreadable frames, including cross-origin and sandboxed frames. Keep the installed skill and repository skill identical, and test the sandbox case.

### [P2] The documented 100000-element scan bound is not enforced

`docs/development.md:156`

Input: a root has more than 100000 controls. `gather` first queries and collects every selector match (`browser-snapshot.ts:106`); `MAX_SCAN` only bounds its later search for nested roots, after another unrestricted `querySelectorAll('*')`. Action processing and the text walker also run outside that bound. An instrumented root returning 100010 matches produced `omitted_actions: 99760`, proving every match was processed before the 250-action output cap. The new prose states “at most 100000 elements scanned per root,” which is false and does not establish the plan's huge-page reliability guarantee.

Suggested fix: apply a traversal budget to collection and processing, including text and nested roots, and expose incomplete traversal so label resolution can fail safely. Until then describe this as a nested-root discovery limit. Add a bounded-work test that counts visited elements rather than only output size.

No new page-content, URL, typed-text, password or raw-error leakage into `calls.jsonl` was found in the production call-record path.

No P1 findings. No P3 findings.

## Verified

- Read `git show c8a4163`, then `git show 91b4afa`, plus surrounding MCP, session, schema, batch, browser engine, target resolution, snapshot, action, extraction, rendering, fallback and tests. Read the plan's Global Constraints and Review Focus. Queried the existing graph before source searches.
- Ran `npx vitest run packages/daemon/src/computer/call-log.test.ts packages/daemon/src/computer/mcp-server.test.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/computer/prompt.test.ts packages/cli/src/system/operator-skill.test.ts packages/daemon/src/browser/page-scripts.test.ts packages/daemon/src/browser/targets.test.ts packages/daemon/src/browser/engine.test.ts packages/daemon/src/browser/legacy-port.test.ts packages/daemon/src/browser/render.test.ts`: 10 files, 277 tests passed.
- Those suites cover password masking/extraction in open shadow roots and same-origin frames, stale identity/label guards, hidden/small/unreadable frames, nesting depth, cancelled Tab in the main document, hover events, `_blank` attribute hints, fallback rejection, schema limits, prompt tool names and byte-identical operator skill copies. Their passing results do not cover the counterexamples above.
- Ran `/tmp/rh-stage-c-review/run-fast.cjs`, `more.cjs` and `engine-check.cjs` against bundled current source: cross-process append/trim interleaving, injected ENOSPC, wall-clock adjustment, schema-error omission, duplicate labels behind the action cap through the actual engine, Tab ordering/failed focus/shadow cancellation, missing frame delta note, unrelated click-handler execution, and instrumented over-budget selector collection. These were isolated Node/jsdom experiments, not actions on real browser accounts. An initial real 100010-button jsdom experiment was interrupted; it is not counted as a successful bounded-work check.
- Confirmed elapsed measurement starts after queue admission and stops at the timeout/result, before the synchronous logger; timed-out handlers remain uncancelled as before these commits. Batch subhandlers bypass MCP recording, so a batch receives one outer record. `RH_CALL_LOG=0` bypasses the production logging callback. Directory/write errors are swallowed; synchronous I/O still blocks the event loop.
- Ran `git diff --check`. Left the pre-existing `.gitignore`, `.gitattributes` and speed-plan changes untouched. Wrote only this review file; no code fixes, commits or graph updates.

---

## Disposition, round 1 (author)

1. **P0 unseen-page label guidance clicks the wrong Save: fixed** (same fix as stage B finding 2): fail closed when the list is incomplete, control-based cap, and the descriptions now say labels are matched among controls visible on screen and fail when too many were listed. The unqualified safety wording is gone.
2. **P0 "click them instead" for CSS-only hover: fixed.** The description now says hover cannot open CSS-only menus and that clicking the parent is not a substitute; a test forbids the old sentence.
3. **P2 concurrent trimming overwrites records: fixed** by removing rewriting entirely: the log rotates by renaming to `calls.jsonl.1`. Appends from another process land in whichever file they opened; nothing is rewritten. **Accepted limit:** two servers rotating at the same moment can replace the older `.1` early (diagnostics only).
4. **P2 disk-full trimming destroys the log: fixed** (same change; no truncate/rewrite path remains). Test: rotation keeps every old line valid.
5. **P2 wall-clock timing: fixed.** Durations use a monotonic clock (`performance.now`, injectable), clamp at 0, and exclude queue wait.
6. **P2 schema failures missing from the log: documented.** The comment and `docs/development.md` now say only calls that reach a tool are logged.
7. **P2 elapsed-time test too weak: fixed.** Controlled clock; asserts both durations exactly (400 and 7) so queue wait or a constant zero fail it.
8. **P2 Tab descriptions overpromise: fixed** by the Tab rewrite (stage B 5, 9); descriptions say the result names the control that really has focus.
9. **P2 frame-note guarantee false for action results: fixed** (stage A 9).
10. **P2 same-site wording wrong: fixed.** Skill (both copies), tool and development docs say open shadow DOM and same-origin iframes, and describe unreadable frames as other websites or sandboxed.
11. **P2 documented scan bound not enforced: fixed** (stage A 4) and the docs now state the real bounds.
