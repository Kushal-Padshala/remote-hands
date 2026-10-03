# Code review: `feat/fast-hud-computer-use`

Reviewed against `main` at merge base `f7cf59ede3e28c394af13f6583e6a9e459ba0f0b` (branch head `784d86a`). Findings are ordered by severity.

## Findings

### 1. [P1] Prewarming can run a workspace task in the wrong directory

**Location:** `packages/daemon/src/warm-agy-session.ts:182-200` (caller: `packages/daemon/src/agy-runner.ts:535-541`)

`ensure()` reuses a live process when model, effort, and mode match, but its key omits `config.workspace`. HUD prewarms with no workspace. If `HermesBrain` later resolves a workspace for a code task, `runWarm()` passes that path to `runTurn()`, yet `ensure()` keeps the prewarmed process. Its `cwd` and `--add-dir` were fixed at spawn time, so the agent starts in the HUD service directory and lacks access to the requested workspace. A later task that changes workspaces has the same problem. Include the workspace in the process key and restart when it changes, or establish the workspace before prewarming.

### 2. [P1] Warm turns ignore the task's conversation ID

**Location:** `packages/daemon/src/agy-runner.ts:527-541`; `packages/daemon/src/warm-agy-session.ts:188-190`

The previous one-shot path passes `task.conversation_id` to `agy --conversation`. The warm path only checks whether that ID is present; it never supplies the ID to `WarmAgySession`. `ensure()` instead uses its own `lastConversationId`, which starts as `null` and may belong to a different task. A continuation executed after a HUD/process restart therefore starts a new conversation, while a task requesting a different conversation can inherit the current warm process's history. Use the requested ID when spawning and reset or replace the live process when it differs from the active conversation.

## Verification

- Targeted tests: 14 files, 212 tests passed across the changed CLI, HUD, agent runner, computer tools, and desktop paths.
- `git diff --check` passed.
- `npm run typecheck` did not pass because `packages/shared/src/context-attachment.test.ts:61-62` has three `TS2532` errors. Those lines are identical on `main`, so this is not a branch finding.
- The two findings follow from the process reuse and spawn arguments above; the current tests do not cover workspace changes or resuming a specified conversation on a fresh warm process.
