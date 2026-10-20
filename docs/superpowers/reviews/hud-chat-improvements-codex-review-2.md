codex
Not clean: **5 Important, 2 Minor findings. No Critical findings confirmed.**

1. **Important — Stop still permits approval through another surface.**  
   [hud-coordinator.ts:511](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:511), [local-task-store.ts:474](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/local-task-store.ts:474)

   **Scenario:** Stop removes HUD eligibility synchronously, but database rejection waits for the active lookup to drain. During that wait, the task is cancelled while its approval remains pending. The local decision endpoint can still approve it because the store does not check task eligibility. Reproduced with a deferred lookup: HUD Allow returned `expired`, but the store accepted `approved`.

   **Fix:** Revoke database eligibility before draining, and atomically require an eligible task when accepting approval. Prevent cancelled tasks from creating fresh actionable requests.

2. **Important — Expiration validation is still separate from the decision update.**  
   [local-task-store.ts:469](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/local-task-store.ts:469)

   **Scenario:** `expireOverdue()` runs before expiry, then execution pauses or waits for SQLite contention until after expiry. The following update checks only `status = 'pending'`, so it approves the overdue request. Reproduced an approved row whose `decided_at` exceeded `expires_at`.

   **Fix:** Include the expiry condition in the atomic decision statement, evaluated when SQLite performs the transition. A preceding sweep cannot enforce this invariant.

3. **Important — Harmless clicks reset the tool timeout.**  
   [call-scope.ts:45](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/call-scope.ts:45), [mcp-server.ts:54](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/mcp-server.ts:54)

   **Scenario:** Every gate invocation pauses the timer, including gates that immediately return for ordinary controls. Each completion then grants a fresh full timeout. Reproduced five ordinary gate calls completing successfully after 131 ms with a 40 ms call limit. The wrapper also disables timeout protection during approval setup, including capture/network work before any person can answer.

   **Fix:** Pause only the actual human-decision wait and resume with the remaining execution budget. Keep approval setup under timeout protection.

4. **Important — Explicit approval denial still permits re-requesting.**  
   [prompt.ts:8](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/prompt.ts:8)

   **Scenario:** Explicit `rh approve` returns `Approval rejected by user`, but the prompt still instructs the agent to “adjust, and re-request or cancel.” The new action-gate suffix does not apply to direct CLI approval calls.

   **Fix:** Apply the prohibition on retrying or using another execution route to explicit denial as well as automatic gates and timeouts.

5. **Important — Lazy expiry can turn an unanswered task into successful completion.**  
   [local-task-store.ts:454](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/local-task-store.ts:454), [daemon.ts:211](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/daemon.ts:211)

   **Scenario:** An agent turn returns while awaiting an approval that has just expired. `getPendingApproval()` now expires and excludes that row. `runDaemonOnce()` interprets the resulting `null` as permission to complete the task, bypassing its approval-timeout failure path. Reproduced `task.status === 'done'` alongside an unanswered `expired` approval.

   **Fix:** Distinguish an expired unresolved approval from having no outstanding approval before declaring completion.

6. **Minor — Shutdown can close a card with the wrong winning outcome.**  
   [hud-coordinator.ts:515](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.ts:515)

   **Scenario:** Cleanup reads `pending`; another surface approves; cleanup’s conditional rejection returns the winning approved row. That return value is ignored, so the card closes as `expired`. Reproduced database `approved` with an `approval-closed` outcome of `expired`.

   **Fix:** Derive the displayed outcome from the row returned by `decideApproval()`, including supersession cleanup.

7. **Minor — The shutdown-race test never establishes an in-flight watcher lookup.**  
   [hud-coordinator.test.ts:1619](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/guidance/hud-coordinator.test.ts:1619), [local-task-store.test.ts:219](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/local-task-store.test.ts:219)

   **Scenario:** The deferred first `getApproval()` is called inside `createApproval()`. The test releases approval creation and can finish before the watcher’s first tick, so it does not prove shutdown fences a stale watcher snapshot. The cross-connection test also lacks an independent deadline proving polling settled before the waiter timeout.

   **Fix:** Create the approval before installing the deferred lookup; explicitly synchronize watcher entry and shutdown. Bound cross-connection resolution independently of the approval timeout.

Earlier findings: **#1 partially fixed**—decision overwrites are prevented, expiry remains racy; **#2 partially fixed**—HUD eligibility is revoked immediately, database eligibility is not; **#3 partially fixed**—cards close, but a competing outcome can be misreported; **#4 fixed**—a genuine deferred watcher lookup is drained and fenced; **#5 partially fixed**—approval waits pause, but timeout scope and explicit denial remain problematic; **#6 fixed**; **#7 fixed**, with the new completion regression above; **#8 mitigated** by conditional HUD/phone wording; **#9 partially fixed**.

Daemon and CLI TypeScript checks and `git diff --check` passed. Findings were checked with in-memory source reproductions. Delayed and overlapping approval waits resumed the timer correctly; watcher shutdown cleared its interval and offered IDs. Full suites and native Swift execution were not run. No files were modified.
tokens used
