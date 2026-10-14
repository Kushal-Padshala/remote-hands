Reviewed **commit `a42e705`**; line references below use that revision. The working tree already contains an uncommitted fix for the post-click PID loss. No files were modified.

**A. Round-1 findings**

1. **PARTLY — Window layers.** [ax-helper.swift:1302](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1302) includes all layers and skips alpha below 0.05. However, its process exclusion also hides the **interactive** floating HUD from occlusion checks; see B1.

2. **FIXED — Window identity.** [ax-helper.swift:1255](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1255) returns `SCWindow.windowID`; [desktop-engine.ts:219](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/desktop-engine.ts:219) forwards it; [ax-helper.swift:1369](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1369) rejects another topmost window number. PID and frame checks remain.

3. **PARTLY — Full text for approval/filtering.** [session.ts:235](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:235) gates on `item.full`, and [ocr-model.ts:104](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ocr-model.ts:104) filters it. But [ax-helper.swift:1122](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1122) still truncates recognized text to **200 characters** first. A risky suffix between characters 201 and 400 never reaches either operation.

4. **PARTLY — App pinning.** The initial snapshot passes its PID at [session.ts:155](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:155); the helper resolves that PID at [ax-helper.swift:1189](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1189), and the engine rejects mismatches at [desktop-engine.ts:174](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/desktop-engine.ts:174). The post-click read loses the pin; see B2.

5. **FIXED — Reported invalidation cases.** Snapshot branches clear OCR at [session.ts:112](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:112), typing clears it before dispatch at [session.ts:254](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:254), and scroll/drag/key/open/menu/non-OCR clicks likewise clear before mutations. [desktop-engine.ts:159](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/desktop-engine.ts:159) clears before reading, so failed refreshes retain nothing. OCR-ID validation can reject before clearing, but those paths perform no mutation. Additional uncovered actions appear in B3–B4.

6. **PARTLY — ID routing.** Membership routing at [session.ts:191](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:191) fixes rejection of high AX IDs **when no matching OCR item exists**. Namespaces remain overlapping: [ax-helper.swift:66](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:66) increments AX handles indefinitely, while [ocr-model.ts:93](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ocr-model.ts:93) restarts OCR numbering at 1,000,000. I reproduced AX “Save” and OCR “Play” sharing `1000001`; clicking the AX ID dispatched `clickAt` to “Play.”

7. **FIXED — HUD click privacy.** [hud-feed.ts:238](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-feed.ts:238) gives successful direct clicks with numeric IDs ≥ `OCR_ID_BASE` the fixed sentence, without extracting OCR text.

8. **FIXED — Async EOF lifetime.** [ax-helper.swift:1110](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1110) defers exit while pending, with the intended approximately 30-second cap. Each `beginAsync()` has exactly one terminal decrement: missing app, denied permission and missing window use `failAsync`; shareable-content/capture failures use `failCapture`; successful recognition ends at line 1256. Fixture, untrusted and unsupported paths never increment.

**B. New bugs**

1. **P1 — Interactive HUD is ignored as an obstruction.**  
   **Location:** [ax-helper.swift:1315](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1315).  
   **Scenario:** `rh-spotlight` runs from the excluded folder ([spotlight-hud.ts:101](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/spotlight-hud.ts:101)). Its panel is floating and joins full-screen Spaces ([spotlight-hud.swift:303](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/spotlight-hud.swift:303)), and contains clickable controls and an editable field. When it covers an OCR point, validation sees the underlying app, but the physical click lands on the HUD.  
   **Fix:** Exempt only individually identified windows that actually ignore mouse events; include interactive HUD windows.

2. **P1 — Post-click re-reading silently drops the PID pin.**  
   **Location:** committed [session.ts:242](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:242).  
   **Scenario:** `safeState()` calls `state()`, which clears OCR at line 82. Consequently, the subsequent `ocrPid()` is always undefined. I reproduced `{op:"ocr", app:"Game"}` without a PID. With multiple matching app instances or a restart, the re-read can install places from another process.  
   **Fix:** Capture the PID before clearing state and reuse it. The uncommitted working-tree change already does this.

3. **P1 — An uncertain OCR click preserves retryable coordinates.**  
   **Location:** [desktop-engine.ts:222](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/desktop-engine.ts:222).  
   **Scenario:** Only `stale` clears OCR. If mouse events were posted but the reply is lost, `timeout` or `helper_exited` leaves the old label and coordinates available. A retry dispatches another physical click without a fresh read; I reproduced that second dispatch.  
   **Fix:** Retain the selected item/window locally, then consume OCR state before dispatching the physical action. Require a new read after uncertain failure.

4. **P1 — Browser mutations leave desktop OCR places valid.**  
   **Location:** committed [session.ts:391](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:391), also browser focus/open/type/do.  
   **Scenario:** Read a browser canvas by OCR, then change its page or tab through a browser tool. The browser window keeps its PID, number and frame, so an old OCR click can pass validation against changed content. I reproduced retained OCR membership after `browserClick()`.  
   **Fix:** Clear desktop OCR before browser operations that can change screen content or focus, including partially failing operations.

5. **P2 — Post-click OCR runs without the required HUD notice.**  
   **Location:** [hud-feed.ts:238](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-feed.ts:238), committed [session.ts:243](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:243).  
   **Scenario:** An OCR click automatically performs another capture/recognition, but its HUD plan emits only `CLICKING`. The pause can last the full 15-second OCR timeout without saying it is reading by sight.  
   **Fix:** Report the re-reading phase, or give OCR clicks an appropriate before notice while preserving the fixed completion sentence.

6. **P2 — Raising the target can erase evidence of an obstruction.**  
   **Location:** [ax-helper.swift:1355](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1355).  
   **Scenario:** A same-process ordinary sibling window covers the captured point. The helper raises the captured window **before** inspecting the stack, potentially moving the sibling behind it and accepting a click that the stated covered-point rule requires refusing.  
   **Fix:** Check the original obstruction before activation/raising, then validate again immediately before sending events.

Other requested checks: process-path lookups are cached **per PID within each stack scan**, not performed for every window, and that cache does not persist across clicks. I found no demonstrated lookup-cost or PID-cache-reuse bug. The SDK declares `proc_pidpath` in `Darwin.libproc`, but Swift type-checking was blocked by the read-only sandbox; compilation remains unverified. The 15-second OCR timeout correctly precedes the 90-second tool timeout and kills the helper. Gate rejection occurs before clicking and causes no partial click. Retry notice deduplication retains the existing notice in HUD history.

**Missing tests**

- Real helper occlusion checks: interactive HUD, floating panels, same-PID sheets/popovers/menus, sibling windows, replacement windows, and full-screen/Spaces.
- Helper-to-session text preservation with a risky suffix **after character 200**, within the accepted 400-character limit.
- Actual AX/OCR collision and handle rollover, rather than merely asserting the raised base.
- PID-preserving post-click reads across duplicate app instances and failed `safeState()`.
- OCR-click timeout/exit invalidation and browser-mutation invalidation.
- Every async terminal path and EOF while capture/recognition is pending.
- HUD notice during post-click recognition and failed-read retries.
- Swift compilation across supported SDK/compiler versions.

The existing tests contain useful routing and invalidation checks, but the “window moved” test injects `stale` rather than testing detection. The “fails half way” test uses a close button and fails before typing ([session-ocr.test.ts:284](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session-ocr.test.ts:284)). Long-text tests bypass Swift truncation. Five committed-code checks reproduced the issues described above; the full suite was not run because its configuration writes files.

**Verdict: do not ship `a42e705`; fix the remaining approval, routing and click-safety gaps first.**