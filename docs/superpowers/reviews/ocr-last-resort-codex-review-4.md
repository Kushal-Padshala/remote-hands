Reviewed `e6341bf`, the latest diff and all three earlier reports. No files modified.

**A. Round-3 items**

- **B1 — FIXED.** [ax-helper.swift:59](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:59): the HandleTable hunk is absent from `git diff main`; IDs keep increasing. [desktop-engine.ts:160](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/desktop-engine.ts:160) rejects OCR when snapshot IDs reach its namespace. In-memory verification confirmed that rejection and successful ordinary AX dispatch for ID `1000005`.

- **B2 — PARTLY; remaining P1.** [ax-helper.swift:1297](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1297): the real overlay matches—[desktop-overlay.ts:100](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/desktop-overlay.ts:100) creates a display-sized floating panel, disables mouse handling, and launches through `osascript -l JavaScript`. A live JXA process returned exactly `/usr/bin/osascript` through `proc_pidpath`. **Remaining scenario:** another JXA script creates the same-sized floating panel with mouse handling enabled. It passes this exemption; the underlying OCR window passes validation, but the physical click lands on the interactive panel. **Fix:** identify the specific Remote Hands overlay window/process, or dismiss that known overlay and exempt nothing. Executable path and dimensions do not establish click-through behavior. Swift type-checking remained blocked by sandbox permissions, so compilation is unverified.

- **B3 — FIXED.** [hud-feed.ts:269](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-feed.ts:269): batches now detect OCR clicks. Actual `HudFeed` execution emitted the rereading notice; an ordinary batch remained unchanged.

- **B4 — PARTLY; remaining P2.** [ax-helper.swift:1120](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.swift:1120): raising the cap fixes line 601, but line 1501 is still discarded before filtering. [ocr-model.ts:124](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ocr-model.ts:124) still recommends filtering to recover it. Reproduced with the current cap and actual view builder. **Fix:** pass the filter into the helper and apply it before the response cap, or provide retrieval of omitted results.

- **B5 — FIXED.** [ax-helper.live.test.ts:44](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/ax-helper.live.test.ts:44): the fixture test requires `RH_AX_OCR_FIXTURE=1`, and the documented command includes it. The child inherits that environment.

**B. New bug**

- **P3 — High ordinary AX IDs receive false OCR HUD messages.** [hud-feed.ts:241](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-feed.ts:241), also line 269. **Scenario:** the long-lived helper assigns AX button ID `1000005`. Its AX action works, but the HUD says “Clicking, then reading the window again by sight” and completes with “Clicked some text on the screen,” although no OCR runs. Reproduced. **Fix:** classify OCR from actual execution metadata/state rather than the numeric threshold.

TypeScript no-emit checking passed; embedded Swift exactly matches its source. Live capture latency and full Swift compilation remain unverified.

**Verdict: ship after fixes.**