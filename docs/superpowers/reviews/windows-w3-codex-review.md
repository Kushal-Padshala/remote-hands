### [P1] Retire the previous listener's process tree before restarting Node

`packages/daemon/src/desktop/windows-hud/Hud.cs:845`, `packages/daemon/src/desktop/windows-hud/Hud.cs:860`

Scenario: the supervised `node ... hud listen` crashes or is terminated by PID. Its `rh-hud.exe listen` child survives and retains Ctrl+Shift+Space. The supervisor restarts Node, but keeps the same job handle open, so KILL_ON_JOB_CLOSE never removes the old child. The old helper has no stdin reader or other parent-death check; broken stdout is swallowed by `Wire.Send`. The new helper registers Ctrl+Alt+Space instead. After another Node crash, orphaned helpers hold both shortcuts and every replacement fails to register. Windows explicitly does not terminate children when their parent exits. This outcome is inferred from the lifecycle and [Windows process termination semantics](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process), rather than reproduced here.

Suggested fix: use a separate job for each listener attempt, and terminate/close that job and wait for its descendants before starting the next attempt. Check job configuration and assignment results. Also let the hotkey helper exit when its owning Node process disappears.

### [P2] Installation force-kills unrelated prompt sessions

`packages/daemon/src/desktop/hud-service.ts:131`, `packages/daemon/src/desktop/hud-service.ts:185`

Scenario: a person is typing in a prompt opened by a separate `rh hud prompt` invocation while `rh hud install` or `rh setup` reinstalls the background service. `/IM rh-hud.exe /T /F` matches the prompt as well as the supervisor and hotkey helper, discarding its unsent text. An executing standalone prompt also has its process tree forcibly ended. Uninstall has the same excessive scope: removing the login service ends independently launched prompts too.

Suggested fix: identify the installed supervisor by owned PID and verified executable/role, and stop that service through a controlled shutdown. Preserve independent prompts. During reinstall, defer replacing an active service session or explicitly arrange a shutdown that preserves its draft, instead of killing every process with this image name.

### [P2] A failed publication rename removes the working executable

`packages/daemon/src/desktop/windows-hud.ts:124`

Scenario: compilation succeeds and `rh-hud.exe` is moved to `.old`, but moving `.new` into place fails with a sharing violation or access denial. The outer catch returns an error without restoring `.old`. The installed Run entry now points at a missing executable, so the next login cannot start the HUD even though the previous build remains available. An injected failure on this second rename reproduced the missing executable in the isolated test copy.

Suggested fix: restore `.old` if publishing `.new` fails; retain the previous stamp until publication succeeds. Add a failure-path test that requires the old executable to remain launchable after this failure.

### [P2] Attaching input queues can freeze the prompt during activation

`packages/daemon/src/desktop/windows-hud/Hud.cs:64`

Scenario: the HUD opens while the foreground application's UI thread is hung or busy and initial window activation has not transferred foreground ownership. `ForceForeground` attaches the HUD UI thread to that application's input queue, then synchronously calls `SetForegroundWindow`. This is the [documented hanging pattern](https://devblogs.microsoft.com/oldnewthing/20080801-00/?p=21393/). The prompt can become unresponsive before reaching `input.Focus()` or starting its stdin reader; the exception handler does not handle a blocked native call. This is a static inference from that documented failure mode.

Suggested fix: remove cross-process input-queue attachment. Arrange foreground permission handoff from the hotkey recipient to the prompt process, check activation success, and keep the window responsive with a click-to-focus fallback if permission is denied.

### [P2] The synchronous Windows prompt exits on its initial stdin EOF

`packages/daemon/src/desktop/windows-hud/Hud.cs:643`, `packages/daemon/src/desktop/spotlight-hud.ts:193`

Scenario: a caller uses the exported `SpotlightHudRunner.openPrompt('Google Chrome')` on Windows. Its default executor uses `spawnSync` without input, which closes the child's stdin. Once `OnShown` starts `ReadDaemon`, the reader immediately reaches EOF and calls `Environment.Exit(0)`. The window disappears before the person can type, and `openPrompt` returns null. The existing successful-prompt tests fake stdout and cannot detect this. The interactive CLI route uses a different method; this defect concerns the synchronous API newly routed to the Windows helper.

Suggested fix: implement `openPrompt` using the asynchronous interactive helper, retaining stdin until submit/cancel and closing the helper after the first result, or provide a one-shot native mode that does not read daemon updates and exits after submission.

### [P2] The startup command can exceed the Run key's command-length limit

`packages/daemon/src/desktop/hud-service.ts:125`

Scenario: the home directory is `C:\Users\Alexandra.Catherine.Montgomery-Smith` and Node is at `C:\Users\Alexandra.Catherine.Montgomery-Smith\AppData\Local\fnm_multishells\1234567890123\node.exe`. With the default HUD and copied CLI paths, the generated Run command is 275 characters. All individual paths fit ordinary Windows path limits, but the Run command exceeds the [documented 260-character limit](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys). Writing the registry value successfully and launching directly now does not establish a valid login launch command.

Suggested fix: store Node/CLI paths in a separate configuration file and register only the short supervisor command, or use a Startup shortcut that supports the arguments. Validate the startup command length and cover long paths in tests.

### [P2] Readiness and shortcut messages precede hotkey registration

`packages/daemon/src/desktop/hud-service.ts:137`, `packages/cli/src/commands/hud.ts:56`, `packages/cli/src/commands/setup.ts:641`

Scenario: another app holds Ctrl+Shift+Space on the first installation. Installation returns immediately after spawning the supervisor, and the CLI reads the default/stale shortcut file before the new Node listener receives `hotkey-ready`. It can tell the person to press Ctrl+Shift+Space even though the helper subsequently selects Ctrl+Alt+Space. If both shortcuts are occupied, installation still reports success, setup announces that the HUD is ready, and `rh hud status` treats the surviving supervisor as an active hotkey listener. The `hotkey-failed` message goes to the hidden listener's unrecorded stderr, so the person receives no usable explanation.

Suggested fix: wait for a bounded registration handshake before reporting installation success or printing the shortcut. Surface registration failure in setup/status, and distinguish supervisor liveness from a registered hotkey. Preserve diagnostics for the background listener.

### Verified

Reviewed `c1610c451ff144e1ded4b3fa5c477b2859a70216` (the only supplied commit), including both C# files, build/swap/stamp logic, service installation and supervision, Windows runner branches, CLI changes, and W3 requirements.

Commands ran in `/private/tmp/rh-w3-review-xl44vcnu`, an isolated archive of the commit using the existing dependencies, so tests/builds did not write artifacts into this repository:

```sh
npx vitest run packages/daemon/src/desktop/windows-hud.test.ts packages/daemon/src/desktop/hud-service.test.ts packages/daemon/src/desktop/spotlight-hud.test.ts packages/cli/src/commands/hud.test.ts packages/cli/src/commands/setup.test.ts packages/daemon/src/guidance/hud-coordinator.test.ts packages/daemon/src/guidance/hud-feed.test.ts packages/daemon/src/hud-models.test.ts
```

Result: 8 test files passed, 135 tests passed.

```sh
node packages/daemon/scripts/check-windows-hud.mjs
```

Result: C# 5/net48 compile succeeded with 0 warnings and 0 errors; 102 logic checks, 0 failed. The command also emitted a macOS `CSSM_ModuleLoad` diagnostic without failing.

```sh
npx vitest run --project=@remote-hands/daemon packages/daemon/src/desktop/windows-w3-review-characterization.test.ts
```

Result: 1 temporary characterization test passed, demonstrating the missing executable after an injected publication failure. This test exists only in the isolated copy. Its initial run without `--project` failed during unrelated Cloudflare Vite plugin startup with `listen EPERM ... 0.0.0.0:9229`; the project-scoped rerun passed.

No Windows execution was possible. WinForms focus, hotkey registration, console-handle behavior, registry startup, executable replacement on Windows, and job/process termination were reviewed statically; compile and logic tests do not establish their runtime behavior. No implementation files were changed or committed.
