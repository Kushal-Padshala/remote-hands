### [P2] Exercise an executing warm turn in the model-change regression test

`packages/daemon/src/guidance/hud-coordinator.test.ts:1329`

The test named “does not restart the agent for a pick made while a task is running” never runs a task. Its setup omits `autoExecute: true`, returns only `{ id: 't1', status: 'queued' }` from `createTask`, and leaves `fakeRunner.run` unused. `hasActiveTask()` is true solely because `currentTaskId` names that queued task. No warm process, pending turn, or `conversation_id` participates.

Consequently, a regression that restarts the process when executing the selected model, or drops the conversation when executing a follow-up with another model, still passes this test: it checks only the prewarm call count and the next `createTask` input. Suggested fix: return complete tasks with distinct IDs, enable automatic execution, and use `ProcessAgentRunner` with a fake-process `WarmAgySession`. Hold the first turn pending while selecting another model and assert no process termination; complete it with a conversation ID, submit the follow-up with the new model, and assert the replacement process receives both that model and `--conversation` with the prior ID.

Verified

- Reviewed commit `79198d8e571828ef9741d1985def949b8a03f965` against its parent. Used `graphify query` before reading project sources.
- Ran `npx vitest run packages/daemon/src/hud-models.test.ts packages/daemon/src/guidance/hud-coordinator.test.ts packages/daemon/src/desktop/spotlight-hud.test.ts packages/daemon/src/agy-runner.test.ts packages/daemon/src/warm-agy-session.test.ts`: 5 files passed, 146 tests passed.
- Ran `swiftc -typecheck -module-cache-path /tmp/rh-review-swift-cache packages/daemon/src/desktop/spotlight-hud.swift`: exit 0.
- Ran an in-memory, fake-process integration check with an isolated temporary home: selecting Claude during an executing Gemini turn caused no termination; after completion, the follow-up restarted with Claude and resumed the same conversation ID. The unresolved-intent task-creation path also selected GPT-OSS. No real agent or desktop action ran in this check.
- Traced settings reads and atomic write/rename, malformed and unknown saved values, both task-creation sites, model-menu callbacks, prewarm/reset/cancellation paths, old positional callers, and the legacy `event.query` listener path. Model-key validation prevents arbitrary model strings from reaching task configuration. The differing named-effort case supplied in the request is omitted by both argument builders; matching named efforts remain forwarded.
- Checked that the model JSON is passed as one argument to `spawn` without a shell; the offered model arguments total 327 UTF-8 bytes. The embedded Swift source exactly matches the edited Swift file. Checked Swift argument parsing, JSON events, menu targets, and compact/expanded frame calculations by inspection; the existing no-model path is covered by the runner tests. Native menu interaction was not exercised.
- Live agy model validation could not run: `/Users/kushal/.local/bin/agy --log-file /tmp/rh-model-review-agy.log models` exited 1 with `listen tcp 127.0.0.1:0: bind: operation not permitted`. No claim is made that the CLI accepts matching named-effort combinations.
