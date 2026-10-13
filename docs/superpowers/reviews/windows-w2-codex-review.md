### [P1] Do not select a command shim that every launcher refuses to start

`packages/daemon/src/system/windows.ts:50` (lookup also at `:30`); consumers: `packages/daemon/src/warm-agy-session.ts:223`, `packages/daemon/src/agy-runner.ts:637`, `packages/cli/src/commands/mcp.ts:25`.

With `Path=C:\tools`, `C:\tools\agy.cmd` present, and the installer executable present under `%LOCALAPPDATA%\agy\bin\agy.exe`, lookup returns the shim immediately and never considers the executable. Preferring `.exe` within one PATH directory does not prevent this. All three launchers use `spawn`/`spawnSync` without a shell. Node 22 refuses `.cmd`/`.bat` this way with `EINVAL`; the HUD turn fails with the raw summary `spawn EINVAL`, and MCP registration fails rather than registering the tools. The same failure occurs when only a shim is installed. This Windows restriction is documented in [Node's security release](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2).

Suggested fix: prefer a runnable native executable, including the installer location, before accepting a shim. Support shims through a shared, tested Windows launcher (prefer executing their underlying runtime directly), or reject unsupported shims with a plain installation/recovery message. Do not merely enable `shell: true` with arbitrary task prompts and paths as shell arguments.

### [P1] Select the Windows prompt for both CLI daemon runners

`packages/cli/src/commands/daemon.ts:229` and `packages/cli/src/commands/daemon.ts:427`; default selection: `packages/daemon/src/agy-runner.ts:508`.

On Windows, both local and connected daemon runners now resolve the executable but still omit the system-prompt argument. They consequently send `getDefaultRemoteHandsSystemPrompt()`, which instructs the agent to run `open "<url>"`, control native applications with `rh desktop ax-action`, and use Mac Accessibility helpers. For example, a task asking to change something in Word receives an instruction to operate its native window, although W2 deliberately supplies no Windows desktop tools. The browser-only limitation and web-version alternative in `computerPrompt('win32')` never reach these tasks. Only the HUD runner selects that prompt. Cold conversation continuations also substitute the Mac-oriented reminder at `packages/daemon/src/agy-runner.ts:267`.

Suggested fix: select the Windows computer prompt and a corresponding continuation reminder for Windows daemon tasks, preserving the existing default prompt/reminder on Mac. Test the actual daemon-created runner's first and continued prompts on Windows.

### [P2] Stop sending taskkill a PID after its child has exited

`packages/daemon/src/agy-runner.ts:658` (abort listener and escalation at `:668` and `:672`); `packages/daemon/src/system/windows.ts:82`.

Cancellation issues forced `taskkill /T /F`, then unconditionally issues it again 400 ms later. The second call runs even after the child has exited; `ChildProcess.pid` retains its old value. The abort listener also remains after a completed run. The daemon shares its abort signal across runs and approval waits (`packages/daemon/src/daemon.ts:170` and `:249`), so cancelling during a later wait can invoke listeners belonging to agents that exited long ago. If Windows has reused one of those PIDs for another user application, taskkill force-terminates that application's tree, potentially losing unsaved work. Checking only that the PID is an integer greater than 4 does not establish ownership. Mocked execution reproduced both the delayed call and an abort-after-completion call with `exitCode=0`.

Suggested fix: remove the abort listener and cancel escalation when the child exits; do not escalate again after a successful Windows forced tree kill. Refuse termination for exited children, and carry child identity rather than exposing only a naked PID. For protection against the exit/reuse race, use verified process identity or an owned Windows job/handle; explicitly reject the daemon's own PID as well.

### [P2] Preserve complete shared rules instead of copying their first line

`packages/daemon/src/computer/prompt.ts:19` and `packages/daemon/src/computer/prompt.ts:20`; approval-rule consumption at `:35`, assertions at `packages/daemon/src/computer/prompt.test.ts:97`.

The string surgery silently takes just the first newline-delimited line of each numbered Mac rule, and silently returns an empty string if the prefix is absent. A concrete undetected edit is inserting `\n` after `--risk=high` in Mac rule 8. The Mac prompt still contains the complete approval rule, and its current numbered-rule and approval assertions still see their required fragments. The Windows prompt loses everything after that break, including `proceed only on exit code 0` and the rejection-handling instructions. Its tests check only an earlier approval sentence, so they do not detect the loss. An in-memory mutation reproduced this truncation without modifying source files.

Suggested fix: share complete rule strings before numbering/joining them, and derive platform differences structurally. If surgery remains, assert that every source rule and replacement anchor exists, preserve continuation lines, and test complete Windows approval/rejection semantics and contiguous nonempty rules, including multiline source rules.

Verified

Reviewed `fd4a428f590eda9d6219c48215ff8148717556d7` against its parent, focused on W2. Ran:

```sh
npx vitest run packages/daemon/src/system/windows.test.ts packages/daemon/src/warm-agy-session.test.ts packages/daemon/src/agy-runner.test.ts packages/daemon/src/guidance/hud-coordinator.test.ts packages/daemon/src/computer/prompt.test.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/computer/mcp-server.test.ts packages/daemon/src/desktop/macos-driver.test.ts packages/cli/src/commands/daemon-local.test.ts packages/cli/src/commands/mcp.test.ts
npx vitest run packages/daemon/src/daemon.test.ts
```

Results: 244 tests in 10 files passed; 12 tests in one additional file passed (256 total). These are Mac-hosted tests; no native Windows executable or real process was terminated.

Additional in-memory checks compared the Mac prompt byte-for-byte with the parent and compared all 20 Mac tool names, ordering, descriptions and schemas. The warm Mac group-kill and direct-kill fallback matched the parent; the cold Mac kill branch is unchanged. Mac command resolution remains the literal `agy`. Windows desktop tools are removed before constructing the batch dispatch map, and the batch rejection test passed. Quoted PATH entries with outer whitespace and spaces/accents are covered by the lookup tests. Production lookup uses Windows' case-insensitive `process.env`; ordinary `Path` versus `PATH` casing is not a separate defect. `shellQuote` has no production caller in this commit, and the new prompt text contains no interpolation of page-provided content by this TypeScript code.

Only this review file was added. Pre-existing `.gitignore` and `.gitattributes` changes were left untouched. No fixes or commits were made.
