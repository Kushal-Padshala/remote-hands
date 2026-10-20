codex
No Critical findings confirmed. There are Important approval races and gaps in the timeout handling.

1. **Important — A competing decision can overwrite a denial.**  
   [hud-coordinator.ts:438](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:438), [local-task-store.ts:463](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/local-task-store.ts:463)

   **Scenario:** HUD Allow reads `pending`; the phone rejects it; HUD then writes `approved`. The store updates unconditionally, so the waiting tool can execute despite the recorded denial. Task-end rejection and superseding requests have the same read/write race. Expiration can also occur between validation and update.

   **Fix:** Make the transition atomic in SQLite: update only a pending, unexpired approval belonging to an eligible task. Return the actual winning row and derive the HUD outcome from it. Cleanup must also update only rows still pending.

   Reproduced by inserting a phone rejection between the HUD read and write: both the returned outcome and final database row became `approved`.

2. **Important — Stop does not immediately revoke pending approvals.**  
   [hud-coordinator.ts:681](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:681), [hud-coordinator.ts:430](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:430)

   **Scenario:** Stop aborts the runner, but approval cleanup waits until execution reaches `finally`. While the runner or its event chain settles, the card remains actionable. `decideApproval` checks neither active execution nor cancellation. The same gap exists during a new hotkey session or chat switch, and `offeredApprovals` is never cleared.

   **Fix:** Revoke approval eligibility synchronously on cancellation/session replacement, stop the watch, reject pending rows, and close cards. Associate offered approvals with their execution and HUD session; check that ownership when deciding.

   Reproduced: after `stopActiveTask()` returned, the row remained pending and HUD Allow returned `approved`.

3. **Important — A phone decision immediately before completion leaves an open card.**  
   [hud-coordinator.ts:503](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:503)

   **Scenario:** The phone approves or rejects the displayed request, and the task finishes before the next 500 ms tick. Cleanup skips every nonpending row, clears the interval, and forgets `shown`. No `approval-closed` event reaches Swift, leaving Allow/Deny—or “Allowing…”—on a completed task.

   **Fix:** Always settle the displayed card during shutdown, including already-decided rows, using its actual outcome. Remove its offered eligibility independently of whether a database update was necessary.

   Reproduced: one card shown, external approval recorded, watch ended, zero close events.

4. **Important — Shutdown does not fence an in-flight tick.**  
   [hud-coordinator.ts:483](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:483), [hud-coordinator.ts:499](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:499)

   **Scenario:** A tick passes the `stopped` check and awaits `getApproval`. Shutdown rejects the request and returns. The lookup then resolves with its earlier pending snapshot, and the tick displays a new card after shutdown. No future tick closes it. `busy` prevents tick/tick overlap but does not serialize tick/shutdown.

   **Fix:** Track and drain the active tick, and recheck the stopped/generation state after every await before displaying anything. Shutdown should close any displayed card unconditionally.

   Reproduced with a deferred lookup: the final row was rejected, but the card appeared after shutdown without a close event.

5. **Important — The prompt misses the timeout the MCP server actually returns.**  
   [prompt.ts:8](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/prompt.ts:8), [mcp-server.ts:20](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/mcp-server.ts:20)

   **Scenario:** An approval wait exceeds the MCP server’s default 90-second limit. The agent receives `error: tool call timed out after 90s`, which matches neither `Approval request timed out` nor `was not pressed`. The underlying approval wait continues, and the new instruction does not prohibit retrying this failure. The existing abandonment guard prevents that original tool call from acting later, but does not prevent another approval request.

   Explicit `rh approve` rejection also still follows “adjust, and re-request,” contradicting the requested prohibition on retrying denial.

   **Fix:** Propagate an identifiable approval timeout/cancellation result, settle its pending row, and explicitly prohibit retries or alternate execution after approval denial/timeout. Cover both automatic gates and explicit `rh approve`.

6. **Minor — “Was not pressed” also describes recoverable UI changes.**  
   [prompt.ts:8](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/prompt.ts:8)

   **Scenario:** The desktop command reports `Control under the coordinate changed; action was not pressed. Take a fresh snapshot and retry.` The new prompt interprets this as user refusal and abandons the step. An unverifiable control label uses the same phrase without any approval decision.

   **Fix:** Distinguish approval refusal from stale-control errors using specific error codes or unambiguous messages. Preserve snapshot-and-retry recovery for UI changes.

7. **Minor — Expiration hides the card but leaves the row pending.**  
   [hud-coordinator.ts:463](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:463)

   **Scenario:** A request expires while its task remains active. The watcher closes its card and excludes it from `waiting`, but does not persist rejection/expiration. Local approval listings still show it pending; the local decision endpoint delegates to the unconditional store update.

   **Fix:** Conditionally persist expiration when detected, and enforce expiration in the store’s decision operation. Reproduced an expired request remaining `pending` after a watch tick.

8. **Minor — Windows instructions advertise an unavailable approval card.**  
   [prompt.ts:49](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/prompt.ts:49), [prompt.ts:56](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/prompt.ts:56)

   **Scenario:** Windows receives instructions describing approval through the HUD, although `hudShowsApprovals('win32')` is false. The agent can direct an unpaired user toward a nonexistent Allow button.

   **Fix:** Use platform-specific approval wording; retain phone-only wording on Windows.

9. **Minor — The tests do not establish several behaviors their names claim.**  
   [hud-coordinator.test.ts:1537](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.test.ts:1537), [hud-coordinator.test.ts:1592](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.test.ts:1592), [local-task-store.test.ts:219](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/local-task-store.test.ts:219)

   **Scenario:** The Deny test reads a rejected verdict but never attempts a gated action. The superseding test checks card events after task cleanup, without proving the old row was rejected while execution continued. The cross-connection test does not assert resolution before the timeout callback’s existing final database read. None exercise the interleavings above.

   **Fix:** Assert an action spy never executes after denial; inspect superseded rows before task completion; bound polling latency independently of the wait timeout; add deterministic deferred-operation tests for cancellation, competing decisions, and shutdown. Add an explicit Windows test with an approvals handler supplied.

**Areas clean on inspection:** conversation-ID persistence now reaches the inserted task and claimed task; supported-browser title reads now replace stale supplied titles. The polling loop performs fresh SQLite reads and clears its added interval on settlement. Swift approval updates use the main queue, serialize outgoing decisions with JSONSerialization and newline/flush framing, capture the delegate weakly, and guard against a second button invocation. No independent layout or retain-cycle defect was found. The embedded Swift matches its source.

The Windows card capability gate and Cloudflare phone implementation remain unchanged. Their existing paths are clean with respect to accidental HUD-card activation; the shared prompt regression is noted above.

**Validation:** daemon TypeScript checking, including tests, and `git diff --check` passed. Findings above include in-memory reproductions using the changed source. The full test suite and native Swift runtime/layout were not verified under the read-only sandbox. No files were modified.
