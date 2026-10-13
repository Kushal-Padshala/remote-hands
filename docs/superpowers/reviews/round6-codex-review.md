### [P0] Scheme-less navigation URLs expose query tokens

`packages/daemon/src/guidance/hud-feed.ts:30`

Scenario: `browser_open` receives `example.com/reset?token=SECRET`. This is accepted by the real `normalizeOpenUrl`, which opens `https://example.com/reset?token=SECRET`. The HUD parses the original argument instead; `new URL` throws and the fallback displays **`Opened example.com/reset?token=SECRET`**. The throwaway test exercised the actual normalizer and feed. The previous MCP-call HUD formatter did not print the nested URL argument. Shortening a raw URL is not host-only filtering. A longer path can similarly disclose private path components before the cutoff.

Suggested fix: use the navigation URL normalizer before extracting a hostname, or fall back to `Opened a page` when parsing fails. Never echo unparsed URLs. Bound the resulting hostname as well. Add scheme-less URLs with sensitive paths/query strings to the privacy tests; the current test at `hud-feed.test.ts:30` supplies only an already-qualified URL.

### [P0] Editable contents are displayed as supposedly safe field names

`packages/daemon/src/guidance/hud-feed.ts:121`

Scenario: an unlabelled `contenteditable` textbox contains a private draft from an earlier typing step. The real snapshot name function uses its text contents as the control label. The throwaway snapshot returned `label: "PRIVATE_DRAFT_123"`; a subsequent `browser_type` result became **`Typed into "PRIVATE_DRAFT_123"`** in the HUD, even though the new text argument was withheld. Textarea initial contents can also be used as names. A label supplied to a single-step `browser_do` is likewise echoed without knowing where it came from. Thus “what was typed ... is never shown” is false: excluding `Arguments.text` alone does not establish privacy. The existing test uses a clean `Email` label and cannot detect this leak.

Suggested fix: display a generic typing/filling sentence unless the tool supplies a separately identified, safe accessible field name. Do not infer that textbox labels derived from contents are safe. Test a second edit of an unlabelled editable, as well as a textarea containing private initial text.

### [P1] MCP error envelopes are reported as successful actions

`packages/daemon/src/guidance/hud-feed.ts:60`, `packages/daemon/src/guidance/hud-feed.ts:228`

Scenario: the agent's tool `DONE` record contains the MCP result object `{isError:true, content:[{type:"text", text:"error: Approval rejected by user: Stop now"}]}` without an outer agent-step error. This output shape is supported by `parseAgyStreamLine` and produced by the MCP server. The parser serializes it and sets `payload.ok` from the outer step, not `isError`. The feed checks only `ok` and a string beginning with `error:`. With a planned `browser_do` click on Pay, the actual parser/feed experiment displayed **`Clicked "Pay"`**, although the result says the approval was rejected. Other branches can falsely report opening a page, typing, or editing a file.

Suggested fix: normalize MCP results at the event boundary, carry their error flag and text content, and only summarize a verified successful outcome. Add a parser-to-feed test using the actual MCP envelope, including rejected approvals. All new feed/coordinator success tests manufacture flattened result strings, so they bypass this protocol failure.

### [P1] Batch summaries count steps that never ran

`packages/daemon/src/guidance/hud-feed.ts:69`, `packages/daemon/src/guidance/hud-feed.ts:81`

Scenario: a batch plans Click Continue followed by Type Name. The click navigates. `BrowserEngine.do` returns success with `did: click` and `step 1 click ok but the page navigated; remaining steps not run` (`browser/engine.ts:1005`). The feed counts the original arguments, ignores these outcome lines, and displays **`Filled in 1 field and clicked 1 button`**. The throwaway feed test reproduced this. This misstates what happened on the person's account.

Suggested fix: summarize the executed operations reported by the tool, including early navigation stops, rather than the plan. Prefer structured executed-step data. The new batch test at `hud-feed.test.ts:39` supplies a result matching every planned operation; it would pass if result content were ignored entirely, as it is now. Add a navigation-shortened batch and assert that skipped fields/buttons are never counted.

### [P1] Markdown stripping can block the daemon before the output cap applies

`packages/daemon/src/guidance/hud-feed.ts:39`, `packages/daemon/src/guidance/hud-feed.ts:40`

Scenario: a final answer contains a long run of unmatched `[` characters. The link regex retries its greedy label scan at every opening bracket. On Node v22.22.0, the real function took approximately **38 ms / 893 ms / 3646 ms** for 10000 / 50000 / 100000 brackets, despite returning at most 4001 characters. A run of newlines took approximately **52 ms / 1225 ms / 4889 ms**: the bullet regex's `\s*` can traverse successive lines and repeatedly backtrack. This is quadratic backtracking, not evidence of an exponential bound, but it already stalls the Node event loop for seconds. Stop/cancel processing shares that loop. The cap is applied only after all replacements.

Suggested fix: impose a processing-input budget before conversion and use a linear parser or line-local, bounded patterns. In particular, indentation should not consume newlines. Add adversarial unmatched delimiters and whitespace under a deterministic work/time budget; the current long-input test only uses `a`, which never exercises either expensive pattern.

### [P1] Requests for manual help and uncertain-action warnings disappear while work continues

`packages/daemon/src/guidance/hud-feed.ts:237`, `packages/daemon/src/guidance/hud-feed.ts:77`

Scenario: after a browser login or permission failure, the agent emits `Please sign in to your account in the browser. I will wait until you finish.` and continues polling/waiting. The actual parser/feed experiment produced only empty WRITING/READING updates. The person never sees the required intervention until the runner ends and supplies a final summary. Unlike phone approvals, this manual assistance has no separate request channel in the inspected path. The previous formatter displayed the agent's text.

A related safety loss occurs when a batch result says `step 1 click ran, but checking the page afterwards failed ... (step 1 ok)`: the new feed replaces it with **`That didn't work. Trying another way.`** The experiment reproduced the loss of the already-ran warning. A payment/send may have happened; the sentence implies failure and a retry without evidence that either is appropriate. Failed reads, commands and unknown tools can produce no text at all. Their tool-result text was not generally visible in the old formatter either, but the agent's subsequent explanation now disappears too.

Suggested fix: retain a non-streamed, explicit needs-user/intervention channel, and distinguish a refused action, a partial batch, and an action whose effect is unknown. Show a short safe explanation without raw commands, tokens or tool plumbing. Do not announce a retry before one is selected. Test a login/permission request while the runner remains pending, and an irreversible action that ran before its confirmation failed.

### [P2] An empty queued text event can revive the HUD after Stop

`packages/daemon/src/guidance/hud-feed.ts:237`, `packages/daemon/src/guidance/hud-coordinator.ts:454`

Scenario: the coordinator's event callback is awaiting `store.appendEvent` for an `agent_text` event containing whitespace. The person presses Stop; `stopActiveTask` aborts and sends STOPPED. When the append finishes, the callback still invokes the feed, which now emits `WRITING, ""`. The actual coordinator throwaway experiment recorded **STARTING → STOPPED → WRITING**. Replaying the exact Swift update branch shows that this final pill-only message sets `isWorking = true` and exposes the stop button again. The parent formatter returned empty text for this whitespace event, and the parent coordinator did not send it: this particular revival is introduced by the new feed.

Suggested fix: suppress HUD events after abort or loss of execution ownership, rechecking after the append await; close the feed on terminal completion. Give Swift a task/generation boundary so late updates cannot revive a terminal task. Existing cancellation tests check the store and signal but emit no queued event, so they pass despite this regression. The more general late-message revival, including READING after COMPLETE, already existed in Swift; it remains unguarded.

### [P2] Plain-text conversion corrupts code and leaves Markdown behind

`packages/daemon/src/guidance/hud-feed.ts:37`, `packages/daemon/src/guidance/hud-feed.ts:41`

Scenario: `Use \`__init__\` and \`a__b__c\`.` becomes **`Use init and abc.`** because emphasis stripping runs inside inline code. A fenced Python snippet containing `# Keep the record` and `x = "**secret**"` loses the comment marker and literal asterisks after the fences are removed. `[guide](https://example.com/a_(b))` becomes `guide)`. Conversely, `*important*`, `~~cancelled~~` and pipe-table Markdown remain verbatim. These outputs were obtained from the real function. Thus both the content-preservation goal and the advertised plain-text contract are incomplete. The math/snake-case test uses only single underscores and spaced multiplication; it does not cover double-underscore identifiers, code literals, or nested parentheses.

Suggested fix: parse Markdown into plain text while preserving code/literal contents, and handle emphasis, links and tables explicitly. Add the concrete examples above. Keep ordinary URLs, math, snake_case and numbered-list meaning; do not globally delete syntax characters from literal text.

## Round 1 verification

The three named dispositions concern browser discovery/actions, tool descriptions and call logging; they contain no prior HudFeed/Swift filtering finding. Browser fixes unrelated to the HUD focus are not certified as new fixes by this review. Their current test suites were run as additional baseline evidence, not as real-browser validation. The privacy/cancellation items and every explicit deferred/accepted limitation are assessed below:

- **Stage A #3, nested password serialization → confirmed for the claimed new surface.** Ran `page-scripts.test.ts`'s `legacy full mode keeps seeing only the top document and never serialises nested secrets`, which asserts absence of both secrets from the whole full snapshot, and the light/extract password tests. **Top-document legacy guard deferral → accepted only as a pre-existing, scoped deferral for this HUD commit.** The full snapshot still serializes top-level values in guards/page-key; this is not a promise of password-free serialization. The new field-name leak above is separate and is not covered by that disposition.
- **Stage B #4, batch wait mitigation → confirmed for the 30000 ms wait cap**, through engine and legacy-driver tests. **“A batch finishes well inside the timeout” → NOT FIXED as a general guarantee:** action/approval/browser time is not bounded by the explicit-wait sum. **Deferred abandonment cancellation → superseded, accepted only with the current cancellation checks.** Fresh MCP, tool and engine tests verify abandonment, no later batch step, no click after a late approval, and isolation of subsequent calls. The old disposition's claim that cancellation is merely deferred is stale; it does not excuse the HUD stop race above.
- **Stage A #12, frame editor unit-test repair → confirmed at the unit-test level.** The executed test now checks `Thanks!` in the editor and that its own frame selection covered `old text`. **Real-browser deferral → accepted for this HUD-only review boundary; not accepted as evidence of final production browser correctness.** The selected browser tests use jsdom/layout stubs. No native browser editor or cross-realm event behavior was exercised here.
- **Stage B #10, pilot handling of the new-tab hint deferred → accepted as an explicitly limited hint**, not proof that a tab opened or was handled. This HUD commit adds no pilot tab handling; no new claim of it is made here.
- **Stage C #3, simultaneous rotations may replace an older `.1` early → accepted as a diagnostic-retention limit.** The executed rotation test checks valid retained records and a fresh subsequent file; source inspection confirms rename instead of truncate/rewrite. This does not prove lossless concurrent retention, and that limitation must remain stated.
- **Stage B #5, page-wide positive-tabindex approximation → accepted as a documented browser-order limitation outside this HUD change**, not exact native Tab fidelity.
- **Stage C #6, schema rejections are not logged → accepted as a documented logging boundary.** The executed MCP test proves invalid arguments do not reach the handler; the server option comment and `docs/development.md` explicitly exclude these calls.

## Verified

- Reviewed `fbcfb2e` against its parent, all six changed files, the three original review/disposition files, and the event parser, warm/cold runner queues, browser result formats, approval gate/CLI path, and Swift update loop. No browser action/visibility/frame/focus implementation is changed by this commit; no user's browser/accounts were driven.
- Ran exactly `npx vitest run packages/daemon/src/guidance packages/daemon/src/desktop`: **17 files, 260 tests passed**, exit 0. This includes embedded-source equality. No tests in this selection run Swift's actual native update UI; `accepts onStop callback` only constructs/closes a handle and does not trigger Stop.
- Ran `npx vitest run packages/daemon/src/approval-gate.test.ts packages/daemon/src/action-gate.test.ts packages/cli/src/commands/approve.test.ts packages/cli/src/action-gate.test.ts packages/daemon/src/computer/mcp-server.test.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/fast-lane/fast-lane.test.ts packages/daemon/src/fast-lane/skills/builtin.test.ts`: **8 files, 232 tests passed**, exit 0. An earlier selection mistakenly named the CLI gate under `commands/`; it ran 7 files/225 tests. The corrected command above includes the actual CLI gate test.
- Ran `npx vitest run packages/daemon/src/browser packages/daemon/src/browser-snapshot.test.ts packages/daemon/src/browser-driver.test.ts packages/daemon/src/computer/call-log.test.ts packages/daemon/src/computer/tools.test.ts packages/cli/src/action-gate.test.ts`: **15 files, 461 tests passed, 1 skipped**, exit 0. No claim that these jsdom/mocked tests establish native browser layout/focus correctness.
- Ran `npx vitest run --config /private/tmp/rh-round6-review/vitest.config.ts /private/tmp/rh-round6-review/review.test.ts`: **1 file, 9 reproduction tests passed**, exit 0. These deliberately assert the observed defective behavior. Experiments live outside the repository and import its real feed, coordinator, parser, URL normalizer and snapshot builder. A temporary config-path error and an erroneous expected trailing `undefined` were corrected before the final run; no repository code was changed.
- Ran isolated Node probes against a TypeScript-transpiled copy of the feed for URL/privacy behavior, Markdown examples and delimiter/whitespace performance, with a 5-second child-process timeout. Runs of `_`, `*`, backticks, `]`, `(`, `)` and mixed delimiters completed quickly at the tested sizes; unmatched `[` and newlines showed the quadratic growth reported above. This is not an exhaustive complexity proof.
- Compiled/replayed the **exact extracted Swift update branch** with minimal UI stand-ins using `swiftc -module-cache-path /private/tmp/rh-round6-review/swift-cache ...`, then executed it. Initial compilation using the default user cache was sandbox-denied; the temporary cache run succeeded. Empty STARTING/READING/WRITING/UNKNOWN updates set working, show Stop and add no history; `role: ACTION` selects the action icon/color. COMPLETE and STOPPED clear working and hide Stop; a following empty READING reverses both. **FAILED does not clear working, change the pill, hide Stop or restore the input responder**: it shares the nonfatal ERROR branch. That terminal-failure defect predates this commit and is not presented as a new finding. This replay checks branch behavior, not AppKit rendering, stdin chunk framing, or live focus.
- Ordinary final failures retain their summaries through the coordinator, or fall back to `Task failed`; caught exception text is now capped at 400 characters. Stop/cancel reasons are still sent by the existing path. Phone approval creation/decision enforcement is independent of HudFeed and remains covered by the gate/approve tests; the new erroneous HUD interpretation of its results is reported above.
- Qualified HTTP(S) navigation strips userinfo, path, query and fragment; it retains the port. `data:` and `javascript:` inputs produced `Opened a page` in the feed probe; the browser normalizer rejects JavaScript navigation. Invalid/bare URLs and very long parseable hosts are not safely handled by the host helper. Raw `run_command` arguments, `view_file` paths, and parent directories of file-edit paths are omitted by the new call planner (file-edit sentences retain the basename). Error-event text, final summaries and fast-lane progress still accept arbitrary text and are not privacy sanitizers; no blanket claim that secrets/paths/commands can never reach the HUD is warranted.
- Ran the required graphify query before source searches. Only this review document was written in the repository; no implementation edits, commit, or graph update was made. The pre-existing `.gitignore`, `.gitattributes` and HUD speed-plan worktree changes were left untouched.

---

## Disposition (author)

All findings were reproduced and fixed in the follow-up commit; new tests fail on the previous version (11 failures, the hostile-input one took 106 s).

- **P0 scheme-less URL echoed: fixed.** `hostOf` only ever shows a parsed host: a scheme-less address is parsed as https, any other scheme (`javascript:`, `data:`, `file:`), unparseable text, and over-long hosts say "Opened a page". Test covers `example.com/reset?token=SECRET`, credentials, ports and junk.
- **P0 field names built from contents: fixed.** Typing never shows the text or the field's name ("Typed into a field"); batches count fields instead of naming them. Clicking still names the button (its text is on the user's screen anyway).
- **P1 MCP error envelopes reported as success: fixed.** `flattenResult` reads `{isError, content[].text}`; only a verified success is announced. Rejected approvals say "That action wasn't approved, so it was skipped."
- **P1 batch counts the plan: fixed.** The summary comes from the tool's own `did:` line; a batch cut short by navigation counts only what ran.
- **P1 markdown stripping blocks the loop: fixed.** Input is cut before any pattern runs, every pattern is line-local and bounded (no `\s*` across lines, bounded labels/URLs/emphasis). Hostile inputs (200k brackets, newlines, `*`, `_`, backticks, `[a](`) finish in well under 1.5 s in total.
- **P1 requests for the person and uncertain actions vanish: fixed.** One sentence asking the person to act ("please sign in", captcha, "waiting on you"...) is shown when the agent next acts; "ran, but I couldn't confirm" and "took too long" are said as such; the false "trying another way" is gone.
- **P2 Stop revival: fixed.** The coordinator sends nothing to the HUD once Stop aborted the task, including for an event still being stored; the Swift side ignores a status-word-only update after the task ended. Also fixed a pre-existing Swift bug the review found: FAILED now ends the task (spinner off, Stop hidden, input back) instead of sharing the non-fatal error branch.
- **P2 plain-text conversion corrupts code: fixed.** Code (inline and fenced) is kept as written; links with parentheses, `*em*`, `~~x~~` and tables are handled; math, snake_case, numbered lists and URLs are untouched.
- **Accepted:** error-event text, the final summary and fast-lane progress are the agent's own words, shown on the user's own screen; they are bounded but not sanitized.
