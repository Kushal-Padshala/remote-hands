### [P0] Reader changes and helper restarts reuse IDs for unrelated controls

Locations: `packages/daemon/src/desktop/ax-helper.swift:40`, `packages/daemon/src/desktop/ax-helper.ts:249`, `packages/daemon/src/computer/session.ts:72`, `packages/daemon/src/computer/session.ts:153`.

The helper starts its handle counter at 1 on every process launch, while the legacy reader also supplies small integer indexes. Neither the session nor the protocol gives exposed IDs a reader/process generation. For example, a helper snapshot identifies `[2]` as a file; an action's state read times out and switches to a legacy snapshot where `[2]` is another control. A queued/batched click using the original ID now acts on the latter control. Restarting the helper similarly assigns previously exposed numbers to new elements. The counters are only unique within one helper lifetime, despite the tool's stable-ID contract.

Suggested fix: allocate public IDs in the session across both readers and all helper generations, map them to generation-qualified underlying handles, and invalidate old mappings on a reader/process change. Reject old IDs rather than interpreting them in the new namespace.

### [P0] Failed secure-field classification permits plaintext output

Locations: `packages/daemon/src/desktop/ax-helper.swift:80`, `packages/daemon/src/desktop/ax-helper.swift:266`, `packages/daemon/src/desktop/ax-helper.swift:535`, `packages/daemon/src/desktop/ax-helper.swift:557`, `packages/daemon/src/desktop/ax-helper.swift:610`.

`fetch` turns attribute errors into nil, and security classification treats missing role/subrole information as non-secure. For an `AXTextField` whose secure subrole lookup fails while its value lookup succeeds, snapshot emits the value. `readText` likewise proceeds after an unsuccessful classification request, and `setValue` emits read-back after the same failure. The formatter then has no secure flag to redact that plaintext, including in diffs. These are distinct AX requests, so success of the value request does not establish success of classification. Per-attribute errors are explicitly supported by [Apple's multiple-attribute API](https://developer.apple.com/documentation/applicationservices/1462051-axuielementcopymultipleattribute).

Suggested fix: preserve classification errors and fail closed for text values when classification is unknown. Remember known-secure handles, classify before requesting values/selected text, and never read back a known-secure field after setting it. Test failed subrole/classification lookups followed by successful value lookups.

### [P0] Approval uses a shortened or invented control label

Locations: `packages/daemon/src/desktop/ax-model.ts:303`, `packages/daemon/src/desktop/ax-model.ts:239`, `packages/daemon/src/computer/session.ts:147`, `packages/daemon/src/computer/session.ts:245`.

The gate receives the display label, shortened to 80 characters. A button whose raw label is 90 harmless characters followed by ` Delete` is classified as destructive by `classifyRiskyAction`, but its `ViewItem.label` is just a shortened harmless prefix; the click/open/double/right action proceeds without approval. An unlabeled control is passed as `button` instead of an empty label, defeating `createActionGate`'s explicit refusal to act when the label cannot be verified. Drag labels have the same shortening problem. The Swift snapshot already shortens labels to 200 characters, which creates another loss before classification.

Suggested fix: retain an unshortened label for authorization separately from display text, authorize the actual action target, and refuse unknown labels instead of substituting a role. Keep sensitive full labels out of persisted diagnostics.

### [P1] Long text is rendered without the ID needed to read it

Locations: `packages/daemon/src/desktop/ax-model.ts:232`, `packages/daemon/src/desktop/ax-model.ts:297`, `packages/daemon/src/desktop/ax-model.ts:283`, `packages/daemon/src/desktop/ax-helper.swift:615`.

A long message exposed as `AXStaticText` becomes `text "<120-character prefix>…"` with no ID. The advertised recovery tool, `desktop_read`, requires an index from that snapshot, so the model cannot request the rest. Folding text into a row also loses the read target: reading that row requests only the row's own value/title/description, which can all be empty even though its child text supplied the visible message. It returns `(empty)` rather than the folded content.

Suggested fix: expose IDs for readable text and preserve explicit read targets for folded rows, or implement bounded descendant reading for those rows. Test reading a long static-text message and a row whose only text lives in its cell.

### [P1] Diffs suppress incomplete snapshots and changes in reading order

Locations: `packages/daemon/src/desktop/ax-model.ts:448`, `packages/daemon/src/desktop/ax-model.ts:460`, `packages/daemon/src/desktop/ax-model.ts:481`.

With identical reported nodes, changing `timedOut` from false to true produces the same fingerprint and `no visible change`; the warning that only part of the window was read disappears. Changes to hidden counts and disappearance of scroll hints can also disappear. Reordering the same controls changes the full view but is reported as unchanged because the diff compares each keyed line independently. A model following the prompt's instruction to avoid another snapshot therefore keeps an incorrect ordering or assumes that the state was fully observed. Both the timeout and reorder cases were reproduced with the real formatter.

Suggested fix: include completeness, omitted-content metadata and relevant raw state in settling fingerprints. Make diffs preserve warnings, hint removals and ordering changes, or return a full view when the diff cannot express them.

### [P2] Visible-row optimization loses the promised scroll hints

Locations: `packages/daemon/src/desktop/ax-helper.swift:221`, `packages/daemon/src/desktop/ax-helper.swift:261`, `packages/daemon/src/desktop/ax-model.ts:253`.

For a table with thousands of rows that correctly implements `AXVisibleRows`, the helper visits only the visible rows. `off` is incremented only for children it actually visits and rejects by geometry, so the omitted rows are never counted. At the top of this table the snapshot has no `more below` hint, even though that is the prompt's signal to scroll. Synthetic tests provide `off` directly and cannot catch this.

Suggested fix: obtain a bounded total-row count or another explicit indication of scrollability when using visible-row attributes. Expose the scroll-area ID and direction/end state even when an exact omitted-row count is unavailable.

### [P0] A valid AX object can change identity or action without being rejected

Locations: `packages/daemon/src/desktop/ax-helper.swift:404`, `packages/daemon/src/desktop/ax-helper.swift:464`, `packages/daemon/src/computer/session.ts:147`.

`liveElement` verifies only that reading the object's role does not fail. It does not establish that it is still visible, still describes the same content, or still offers the approved action. For example, a reused dialog button changes from `Next` to `Delete`, or a virtual list reuses a row for another message after the user scrolls. The cached label still passes the gate as the old benign control, the role lookup succeeds, and `AXPress` acts on the new destructive control/content. Waiting for approval makes this gap longer.

Suggested fix: retain the observed target identity/context and validate current role, full label, app/window and visibility before authorization and again at execution. Pass expected attributes to the helper so it refuses a changed target with a snapshot-again error rather than executing on a merely valid AX object.

### [P0] Click hit testing accepts unknown hits and covering windows from the same app

Locations: `packages/daemon/src/desktop/ax-helper.swift:448`, `packages/daemon/src/desktop/ax-helper.swift:489`, `packages/daemon/src/desktop/ax-helper.swift:500`, `packages/daemon/src/desktop/ax-helper.swift:650`.

The check refuses only a successfully resolved hit whose PID differs. A failed hit test permits input, and another window/sheet/control owned by the same app also passes. Thus an element behind another Finder or Mail window can be double/right-clicked at the covering window's control, rather than the observed element. An element partially intersecting its viewport is retained by the walker even when its full-frame center is outside that viewport; that center can also hit a different control of the same app. Activation occurs after hit testing and can change which window occupies the point. [Apple documents this hit test as returning the topmost accessibility object](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition?changes=_2_2&language=objc), not proof that an arbitrary element of the same PID is uncovered.

Suggested fix: fail closed on hit-test errors, choose a point inside the visible clipped target, and check the actual hit against the target/allowed descendant and expected window after activation, immediately before posting input. Apply the same target validation to scrolling.

### [P0] Drag never verifies the drop destination is uncovered

Locations: `packages/daemon/src/desktop/ax-helper.swift:688`, `packages/daemon/src/desktop/ax-helper.swift:694`, `packages/daemon/src/desktop/ax-helper.swift:698`, `packages/daemon/src/desktop/ax-helper.swift:717`.

The destination PID is discarded, and only the source point is hit-tested. If a browser upload area covers the intended Finder folder, dragging the observed file onto that folder's coordinates can instead upload it to the user's signed-in browser account. A different Finder window covering the destination can move the file into a different folder. Neither case is checked before mouse-up. Endpoint resolution also bypasses `liveElement` and checks only whether a frame can be fetched.

Suggested fix: validate both live endpoints and their visible clipped hit targets after activation, retain both owner/window identities, and revalidate the destination before releasing the drag. Abort safely on a changed or unknown destination and always restore pointer/button state.

### [P0] Focus success does not establish where subsequent typing goes

Locations: `packages/daemon/src/desktop/ax-helper.swift:433`, `packages/daemon/src/desktop/ax-helper.swift:526`, `packages/daemon/src/desktop/ax-helper.swift:570`, `packages/daemon/src/computer/desktop-engine.ts:151`.

`activate` gives up after 300 ms without reporting failure. `focus` returns success when the AX setter succeeds even if the read-back says `focused: false`. The engine ignores that response and sends `typeText` without a PID or target handle; the helper posts global HID keys. If focus has not moved, or another app takes focus between the two requests, the text goes to the previous/frontmost app. Replacement's global Cmd+A can then select and overwrite unrelated content, and a password intended for a secure field can land in an ordinary editor or chat composer.

Suggested fix: require verified activation and actual system-wide focused-element identity. Send the expected PID and handle with typing/select-all/submit, and validate or target delivery in the helper instead of trusting a previous focus request.

### [P0] Physical modifiers alter generated clicks and text into unintended actions

Locations: `packages/daemon/src/desktop/ax-helper.swift:474`, `packages/daemon/src/desktop/ax-helper.swift:571`, `packages/daemon/src/desktop/ax-helper.swift:590`, `packages/daemon/src/desktop/ax-helper.swift:658`.

All event sources use `.hidSystemState`, and events never explicitly clear modifier flags. If the user is holding Command while the helper emits a newline as Return, the event can be Cmd+Return, sending a draft without the risky-key gate. Holding Option can change a Finder drag from move to copy; holding Control can change a requested left click into a context-menu action. These operations no longer match the action the model requested or authorized. Apple's [event-source documentation](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid) describes HID state as the shared hardware modifier/button state; [event flags](https://developer.apple.com/documentation/coregraphics/cgeventflags?changes=_4_5) encode modifiers at creation.

Suggested fix: use a private source state and explicitly set the intended flags on every generated keyboard, mouse and scroll event. Guard against real user interaction changing delivery mid-operation.

### [P0] The new typing options bypass approval for writes and submission

Locations: `packages/daemon/src/computer/session.ts:180`, `packages/daemon/src/computer/session.ts:183`, `packages/daemon/src/computer/session.ts:191`, `packages/daemon/src/computer/session.ts:194`, `packages/daemon/src/desktop/ax-helper.swift:588`.

`desktop_type({index, replace:true})` sets a labelled `Send`/`Delete` field without calling the gate unless `submit` is also true, contrary to the plan's labelled-value-write rule. Omitting `index` with `submit:true` bypasses the gate entirely. Even indexed submission gates only the field's label: `Message` or `TextField` classifies as harmless, so Return can send a chat message without approval. With `submit:false`, newline text still emits actual Return key presses in Swift and can submit the same composer. Read-only probes confirmed zero gate calls for both labelled replacement and no-index submission.

Suggested fix: gate labelled value changes before mutation. Identify and authorize the effective submit/send action (using an explicit action kind where needed), for both indexed and focused typing, and treat embedded Return/Tab/control input as actions rather than an alternative route around submission authorization.

### [P0] Successful replacement submits whichever app currently has focus

Locations: `packages/daemon/src/computer/session.ts:194`, `packages/daemon/src/computer/session.ts:195`, `packages/daemon/src/computer/session.ts:208`, `packages/daemon/src/desktop/ax-helper.swift:552`.

Take a snapshot of a background app's field, then call `desktop_type` with `index`, `replace:true` and `submit:true`. AX value setting succeeds without activating or focusing that field. The session skips `engine.focus` on this success path and sends Return through the global legacy driver. A foreground chat composer can send its existing draft instead of submitting the replaced field; a foreground dialog can confirm an unrelated action. The action sequence was reproduced as just `setValue` followed by global Return, with no focus operation.

Suggested fix: before submission, establish and verify the intended app/field focus on every replacement path, including successful direct AX setting. Submit through a target-qualified helper operation and reject changed focus.

### [P1] Batch results discard state changes needed for subsequent calls

Locations: `packages/daemon/src/computer/tools.ts:267`, `packages/daemon/src/computer/tools.ts:275`, `packages/daemon/src/computer/session.ts:82`.

Batching previously returned a complete final desktop state. The new engine instead returns a diff against each immediately preceding state, but `computer_batch` still discards all results except the last. If step 1 opens a menu/adds controls and step 2 produces no further visible change, the result contains only success markers and `no visible change`. The model never receives the new controls or IDs, despite the session caching them and the prompt telling it not to snapshot again. A two-step real-session/fake-port probe reproduced this loss.

Suggested fix: compose a diff against the state visible before the batch, return all intermediate diffs, or provide a full final state. Test a batch whose first step changes the tree and whose final step leaves that changed tree unchanged.

### [P2] Safety tests assume the Swift behavior they claim to verify

Locations: `packages/daemon/src/computer/session-engine.test.ts:26`, `packages/daemon/src/computer/session-engine.test.ts:157`, `packages/daemon/src/computer/session-engine.test.ts:174`, `packages/daemon/src/desktop/ax-helper.test.ts:206`.

The covered-click test injects a `covered` error rather than exercising hit testing. The Unicode/newline test verifies only that a JSON request contains the input string. The secure fixture is already classified correctly, and the embedded-source check proves only that two copies match. These tests still pass if Swift removes coverage checks, sends keys to the wrong app, mishandles CGEvents, or classifies secure fields incorrectly. No live action tests were run during implementation, so these are the only purported checks of those paths.

Suggested fix: put AX calls, activation, hit testing and event posting behind injectable Swift boundaries. Assert emitted event targets, flags, coordinates, Unicode units and key order, plus refusals on failed focus/classification/hit tests and covered destinations. Keep separate unlocked-screen integration checks using throwaway data.

### Verified

Reviewed the requested commits in this order: `79e9b2d`, `1eaa7bb`, `a187549`, `ab90760`, `e331fdb`, `3780a4f`, `7900349`. Findings refer to the resulting source at `7900349`; supporting research included the approval classifier/gate, legacy reader/driver, MCP call scope, batch implementation and plan. Ran the existing graph query before source searches.

Ran from the repository root:

```sh
npx vitest run \
  packages/daemon/src/desktop/ax-helper.test.ts \
  packages/daemon/src/desktop/ax-helper.live.test.ts \
  packages/daemon/src/desktop/ax-model.test.ts \
  packages/daemon/src/computer/desktop-engine.test.ts \
  packages/daemon/src/computer/session-engine.test.ts \
  packages/daemon/src/computer/session.test.ts \
  packages/daemon/src/computer/tools.test.ts \
  packages/daemon/src/computer/prompt.test.ts \
  packages/daemon/src/computer/call-scope.test.ts \
  packages/daemon/src/computer/mcp-server.test.ts \
  packages/daemon/src/action-gate.test.ts \
  packages/shared/src/approval.test.ts
```

Result: exit 0; 11 test files passed, 1 skipped; 176 tests passed, 2 skipped. The skipped tests are the opt-in live, read-only AX checks.

Also ran:

```sh
swiftc -typecheck -module-cache-path /tmp/rh-ax-review-module-cache packages/daemon/src/desktop/ax-helper.swift
swiftc -O -module-cache-path /tmp/rh-ax-review-module-cache packages/daemon/src/desktop/ax-helper.swift -o /tmp/rh-ax-review-helper
```

Both exited 0. A read-only Swift scheduling probe using the same `DispatchQueue.main.async` / `dispatchMain()` pattern printed `Thread.isMainThread == true` on this Mac. The AX and CGEvent coordinate references were checked against the installed SDK headers and Apple documentation.

Additional in-memory TypeScript probes exercised the actual formatter, engine and session with synthetic nodes/fake ports. They reproduced label-classification loss, omitted text IDs, suppressed timeout/reorder diffs, absent typing gate calls, replacement submission without focus, and discarded batch changes. They did not send native input. Click, type, scroll and drag were not run live; the event-delivery findings are source-level conclusions, not claims of live validation. No fixes or commits were made.

## Disposition, round 1

- **IDs reused across helper restarts / reader switches (P0):** fixed for the helper: it now has an epoch (random per launch, changed when its table is emptied) returned with every snapshot and sent with every action; an old epoch is refused as `stale`. Switching between the helper and the slower reader still gives the model a fresh state with its own ids in the same result; a queued call using ids from the other reader is not detectable (the plan already tells batches to avoid index steps). Accepted limit.
- **Secure-field classification fails open (P0):** fixed. `classifySecure` fails closed (an unreadable role or subrole counts as a password field) and is used by the snapshot, `read` and `setValue`; setValue never reads a password back.
- **Approval label shortened/invented (P0):** fixed. `ViewItem.gateLabel` keeps up to 400 characters (the helper sends up to 200); clicks, replace/submit and drag are judged on it; no role is substituted for an empty label.
- **Long text without id / folded rows unreadable (P1):** fixed. Cut text keeps its id; `read` falls back to a row's descendant text.
- **Diffs hide partial reads / reorders / vanished hints (P1):** fixed. Notes are part of the fingerprint and a change in them, a reorder of shared lines, or a changed header shows the whole window; a vanished scroll hint is listed.
- **Visible-row lists lose scroll hints (P2):** fixed in the helper (counts `AXRows` minus visible rows); not exercised live yet.
- **Element identity not validated (P0):** mitigated. The helper remembers role and name at snapshot time and refuses the action as `stale` when they differ. A row whose own attributes are empty (text lives in children) is not covered; accepted.
- **Hit test accepts unknown hits / same-app covers (P0):** fixed. An unanswered hit test counts as covered; the hit must be the element, inside it, or contain it; the click point is the centre of the visible clipped frame, after activation. Not exercised live yet.
- **Drag destination unchecked (P0):** fixed. Both ends are validated; the drop spot is re-checked right before release and the drag is returned to its start when covered.
- **Focus does not establish typing target (P0):** fixed. Activation must succeed, `focus` fails unless the field reports it has focus, and typing/select-all/Return carry the app pid and field handle; the helper refuses if the app is not in front or the cursor is not in that field.
- **Held modifiers alter input (P0):** fixed. All events come from a private event source with explicit empty flags (Command only for select-all).
- **Typing options bypass approval (P0):** partly fixed. Replace and submit with an index are gated on the field's full label. Typing without an index (including a newline or `submit`) is not gated, exactly like `desktop_key return`, which the existing policy leaves ungated. Accepted.
- **Replacement submits whichever app has focus (P0):** fixed. Submit always focuses the field first and presses Return through the helper with the same checks.
- **Batch discards earlier changes (P1):** fixed. When the last result is only a diff, earlier desktop steps' `+ ~ -` lines are listed under "changes during earlier steps".
- **Safety tests assume the Swift behaviour (P2):** deferred. The Swift has no unit seams; the live checks on an unlocked screen (TextEdit, Finder) are the test for click/type/scroll/drag.
