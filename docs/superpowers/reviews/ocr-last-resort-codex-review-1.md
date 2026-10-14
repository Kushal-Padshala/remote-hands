1. **P1 — [packages/daemon/src/desktop/ax-helper.swift:1250](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1250)**  
   **Scenario:** An interactive floating panel covers an OCR target. `windowStack()` discards every nonzero-layer window, so the underlying app passes validation, but the physical click lands on the panel.  
   **Fix:** Check covering windows at all layers; exempt only overlays known to ignore mouse events.

2. **P1 — [packages/daemon/src/desktop/ax-helper.swift:1307](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1307)**  
   **Scenario:** Window A is read, then closed while approval is pending. Window B from the same process occupies the same frame. PID and frame checks accept B, and A’s OCR coordinates click B’s controls.  
   **Fix:** Return the captured `SCWindow.windowID`, retain it, and require the top window’s `kCGWindowNumber` to match before clicking.

3. **P1 — [packages/daemon/src/desktop/ocr-model.ts:90](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ocr-model.ts:90)**  
   **Scenario:** OCR recognizes `Continue with the selected operation for the current project and all its resources: Delete`. The 90-character label is truncated before storage. The full label classifies as `delete`; the label passed to `gate(item.text)` classifies as harmless, allowing the destructive click without approval. Filtering for `Delete` also returns nothing. Both results were reproduced.  
   **Fix:** Preserve the recognized text separately for approval and filtering; truncate only the displayed label.

4. **P1 — [packages/daemon/src/computer/session.ts:153](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:153)**  
   **Scenario:** With `app` omitted, the AX snapshot resolves Game. The frontmost app changes to Mail before the OCR request independently resolves `app: ''`. The session caches Game but remembers Mail’s OCR coordinates and PID. `desktop_click(..., app: "Game")` passes `snapshotApp()` and clicks Mail. This routing was reproduced.  
   **Fix:** Pin OCR to the app resolved by the AX snapshot, preferably its PID, and reject mismatched readings.

5. **P1 — [packages/daemon/src/computer/session.ts:110](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:110)**  
   **Scenario:** After an OCR read, a plain snapshot with `index` retains the old OCR places. A subsequent OCR snapshot that fails also retains them. Additionally, an action that partially succeeds and then throws skips `state()` and its invalidation—for example, typing succeeds but submitting fails. A later click can use the old label and coordinates against changed content. The retained-cache cases were reproduced.  
   **Fix:** Clear OCR state before every snapshot branch and before dispatching other mutations. Install fresh OCR state only after a successful read.

6. **P2 — [packages/daemon/src/computer/session.ts:188](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:188)**  
   **Scenario:** A long-lived helper allocates more than 100,000 AX handles. `HandleTable.limit` limits retained entries, but `next` keeps increasing after eviction. Normal AX id `100002` is therefore routed to OCR and rejected—or resolves to an unrelated OCR item when one exists. The normal AX rejection was reproduced.  
   **Fix:** Enforce disjoint namespaces during handle allocation. On rollover, invalidate the epoch and safely restart allocation and any affected snapshot.

7. **P2 — [packages/daemon/src/computer/session.ts:241](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/session.ts:241)**  
   **Scenario:** Clicking OCR text containing sensitive content returns `clicked [100001] text "Secret account number 1234" ...`. The existing HUD click parser displays `Clicked "Secret account number 1234"`. This was reproduced and violates the fixed-sentence requirement for OCR.  
   **Fix:** Recognize OCR clicks in the HUD planner and emit a fixed sentence without extracting the result’s label.

8. **P2 — [packages/daemon/src/desktop/ax-helper.swift:1408](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1408)**  
   **Scenario:** Send an authorized live `ocr` request through a pipe and close stdin. The main-queue handler starts asynchronous capture and returns; the queued `exit(0)` runs before capture/Vision replies. The request receives no reply.  
   **Fix:** Track outstanding asynchronous requests and defer EOF shutdown until their replies finish.

Missing tests:

- Helper click safety: floating overlays and replacement windows with identical PID/frame must receive no click.
- OCR invalidation: indexed snapshots, failed refreshes, and partially failed actions must invalidate previous OCR ids.
- OCR click approval/privacy: a risky suffix beyond character 80 must trigger approval, and sensitive OCR text must never appear in HUD updates.

Verdict: **ship after fixes**.