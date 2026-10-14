Reviewed **`4620e44`**, including `git diff a42e705 4620e44`, both earlier reports, and the full `main...HEAD` diff. No files modified.

**A. Verification of round-2 items**

1. **PARTLY — Interactive HUD obstruction.** [ax-helper.swift:1318](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1318) removes the blanket Remote Hands process exemption. Small interactive HUD windows now participate. However, [isDisplayWideOverlay:1303](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1303) exempts interactive windows based solely on dimensions and layer; see B2.

2. **FIXED — Post-click PID pin.** [session.ts:234](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:234) captures the PID before clicking/clearing state; line 244 passes it to the refresh. The engine also rejects a returned PID mismatch.

3. **FIXED — Uncertain click retry.** [desktop-engine.ts:217](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/desktop-engine.ts:217) consumes OCR state before dispatch. An in-memory execution reproduced one `clickAt` dispatch across two attempts after an injected timeout; the retry was rejected.

4. **FIXED — Browser mutations.** [session.ts:380](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:380) and the subsequent open/click/type/do methods all clear OCR before calling the browser, including calls that fail.

5. **PARTLY — Post-click HUD notice.** Direct OCR clicks receive the required notice and fixed completion sentence at [hud-feed.ts:238](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-feed.ts:238). OCR clicks inside batches still miss the notice; see B3.

6. **FIXED as a review concern — Raising before validation.** I withdraw the earlier raise-only objection. Capture uses `desktopIndependentWindow`; after activation/raising, [ax-helper.swift:1365](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1365) checks the top window’s PID, number and frame. I found no concrete wrong-click scenario caused solely by the intended raising behavior. The exemption in B2 is a separate defect.

7. **PARTLY — Handle reset and epoch safety.** [ax-helper.swift:67](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:67) keeps AX IDs below `OCR_ID_BASE`, but introduces the regression in B1.

   Production perform/click/focus/setValue/read/scroll/typeText/key/drag requests carry the snapshot epoch through [desktop-engine.ts:247](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/desktop-engine.ts:247). Root zoom carries it at line 130. Swift validates it through `liveElement` at [line 517](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:517), separate type/key checks at lines 827/875, and copies the drag epoch into both endpoints at line 984. These checks remain optional when the epoch is omitted.

   **Two duplicate node IDs inside one reply are prevented by `Walker.seen` at line 277. That does not prevent a displayed ID from resolving to a different element after a mid-snapshot reset.**

8. **FIXED — Helper text limit.** [ax-helper.swift:1125](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1125) now clips to 400 characters. Approval and filtering use `item.full`, with the corresponding 400-character TS limit.

**B. New or remaining bugs**

1. **P1 — Mid-snapshot rollover can redirect ordinary AX actions.**  
   **Location:** [ax-helper.swift:67](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:67), with snapshot epoch assignment at line 491.  
   **Scenario:** The table contains 60,000 elements. A walker emits existing window `[1]` and “Save” `[2]`. A new element resets the table and receives ID 1; another receives ID 2. `seen` suppresses their emission, leaving the old “Save” node in the reply. The reply nevertheless carries the **new epoch**. Its subsequent click passes epoch validation and resolves ID 2 to the new element—potentially “Delete.” Reset also cleared its remembered signature.

   A faithful allocation/`seen` simulation using the actual 60,000 limit reproduced `shown=Save`, `resolved=Delete`, matching epoch, no signature, and **no duplicate node IDs**. This affects windows Accessibility can read, without using OCR.

   **Fix:** Make snapshot assembly atomic with respect to handle generations. Abort/restart the entire snapshot if allocation changes the epoch, covering enhanced retries and the final `frontWindow` allocation. Require epochs for every handle-bearing request.

2. **P1 — Size-based overlay exemption allows clicks through interactive panels.**  
   **Location:** [ax-helper.swift:1303](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1303).  
   **Scenario:** A display-sized, mouse-taking floating panel covers the captured window. Its positive layer and dimensions cause it to disappear from validation; the underlying target passes PID/window/frame checks, but the click lands on the panel.

   Different-sized displays make this worse: a **1300×800 panel on a 3000×2000 display** is exempted merely because another active display is 1280×800. Neither position nor actual mouse handling is checked. A floating panel over a full-screen app remains a concrete wrong-click scenario. Ordinary thin menu-bar/Dock bounds generally fail the height threshold, but the predicate provides no protection for larger windows owned by those processes.

   **Fix:** Exempt only specifically identified overlay windows known to ignore mouse events. Dimensions and layer cannot establish that property.

3. **P2 — Batched OCR clicks perform recognition without announcing it.**  
   **Location:** [hud-feed.ts:264](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-feed.ts:264).  
   **Scenario:** After an OCR snapshot, call `computer_batch` containing `desktop_click index=1000001`. The batch detector recognizes only OCR snapshots. Inner handlers execute directly at [tools.ts:284](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/tools.ts:284), so the direct-click HUD plan never runs. Actual `HudFeed` execution produced only `WORKING` with empty text.

   **Fix:** Include OCR clicks in batch notice detection, or emit notices for individual batch phases.

4. **P2 — Filtering cannot recover helper-truncated OCR lines.**  
   **Location:** [ax-helper.swift:1123](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1123).  
   **Scenario:** Required text is recognition line 601. Swift returns only the first 600 lines. Filtering happens afterwards in TS, so repeating the snapshot with that text as the filter can never find it. [ocr-model.ts:124](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ocr-model.ts:124) nevertheless advises using the filter to search omitted lines.

   **Fix:** Pass the filter to the helper and apply it before the response cap, or provide a way to retrieve omitted recognition results.

5. **P3 — The fixture test does not enable fixture mode.**  
   **Location:** [ax-helper.live.test.ts:45](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.live.test.ts:45).  
   **Scenario:** The documented invocation supplies `RH_AX_FIXTURE`, but neither it nor the test enables `RH_AX_OCR_FIXTURE=1`. The helper ignores `image` unless that separate flag is enabled at [ax-helper.swift:1268](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1268). Consequently, the purported fixture test attempts real screen capture and can fail on permissions or examine the wrong image.

   **Fix:** Explicitly enable fixture mode for the child and correct the documented command.

**Missing tests and verification**

- Real helper rollover across snapshot assembly, enhanced retry and `frontWindow` allocation; verify displayed identities and every handle request path, not just uniqueness.
- Real obstruction checks: interactive HUD, display-sized panels, unequal displays, menu-bar/Dock, and floating panels in full-screen Spaces.
- Batched OCR-click HUD notice; filtered text beyond recognition line 600.
- Helper-to-session preservation of risky text after character 200; successful fixture-mode activation.
- Real capture/recognition latency, supported Swift toolchains, async terminal paths and EOF handling.

The “window moved” test at [session-ocr.test.ts:197](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session-ocr.test.ts:197) injects `stale`; it verifies error handling, not movement detection. The “IDs cannot clash” fixture likewise never exercises rollover.

`main...HEAD` changes **17 files, +1,332/−16**. `state().dropOcr()` changes only OCR state, and `BLIND_NOTE` is restricted to full, unfiltered blind snapshots; I found no additional AX behavior change there. **HandleTable is the concrete non-OCR regression.**

TypeScript no-emit checking and Swift parsing passed; embedded Swift matches the source. Vitest and Swift type-checking were blocked by sandbox-denied cache writes, so runtime tests, full Swift compilation and capture timing remain unverified.

**Verdict: ship after fixes.**