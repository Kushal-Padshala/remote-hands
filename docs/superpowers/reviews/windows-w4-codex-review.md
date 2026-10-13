### [P1] The installed Node stops taking precedence in the next terminal

`scripts/install-windows.ps1:32`, `scripts/install-windows.ps1:35`

Scenario: Node 20 is already installed on the machine PATH. Installation appends the private supported Node to the persistent user PATH, but prepends it only to this PowerShell process. The first setup works; the next PowerShell window resolves the machine's Node 20 first. The normal global `rh.cmd` has no sibling `node.exe`, so it uses that unsupported runtime and the CLI's `node:sqlite` import fails. Running the installer again does not recover: the private folder already appears later on PATH, so line 35 does not move it forward and the post-install check still finds Node 20. [npm documents machine-before-user PATH precedence](https://docs.npmjs.com/try-the-latest-stable-version-of-npm/).

Suggested fix: bind Remote Hands launchers to the selected supported Node executable, rather than letting every new shell select its runtime. Always put the selected runtime first in the installation process, even when its folder already appears elsewhere on PATH. Test installation and a second run from a newly opened terminal with an older machine-wide Node.

### [P1] Cancelling or idling the agent also closes the user's browser window

`packages/daemon/src/chrome-manager.ts:421`, `packages/daemon/src/warm-agy-session.ts:66`, `packages/daemon/src/warm-agy-session.ts:319`

Scenario: the first Windows HUD task starts Remote Hands' Chrome or Edge from the agent's MCP server. `detached: true` does not remove Windows process ancestry. Cancel/reset terminates the agy tree with `taskkill /T`, which includes that browser. The same happens after the default ten-minute agent idle timeout, even while the person is signing in or editing a form in the window. Open work disappears as a consequence of stopping the agent. [Node's Windows detached-process behavior](https://nodejs.org/api/child_process.html#optionsdetached) does not provide process-tree isolation.

Suggested fix: start and own the browser outside the tree that agent cancellation and supervisor cleanup terminate. Verify that cancelling a task, resetting a conversation, and reaching the idle timeout leave the browser and its open tabs alive.

### [P2] A running W3 installation has no PID file for the new stop logic

`packages/daemon/src/desktop/hud-service.ts:110`, `packages/daemon/src/desktop/hud-service.ts:162`

Scenario: upgrade a running installation from `c1610c4`. That supervisor never wrote `hud-supervisor.pid`, so the new installation skips stopping it. The replacement supervisor exits immediately because the old supervisor still holds `Local\RemoteHandsHudSupervisor` (`Hud.cs:915`). The previous listener continues running without the fixes or readiness protocol. Uninstall also fails to stop it. This occurs even when compiling and publishing the replacement executable succeed.

Suggested fix: migrate legacy installations by identifying the supervisor's executable and `supervise` role, then stopping and verifying that specific process before replacement. Do not fall back to killing every `rh-hud.exe`.

### [P2] PID reuse can still cause an independent prompt to be killed

`packages/daemon/src/desktop/hud-service.ts:113`, `packages/daemon/src/desktop/hud-service.ts:124`

Scenario: a supervisor crashes and leaves its PID file. Windows later reuses that PID for an independently opened `rh-hud.exe prompt`. Both tasklist filters match, so reinstall/uninstall executes `taskkill /PID ... /T /F` against that prompt and discards its draft or stops its task. An image-name check distinguishes another executable, but cannot distinguish the roles of this executable or an earlier process generation. The existing stale-PID test covers only a different image.

Suggested fix: verify executable path, supervisor role, and process creation identity before termination, or use supervisor IPC with a per-instance token. Add a stale-PID test in which the reused PID belongs to the same image in prompt mode.

### [P2] Failed job assignment leaves the listener running without descendant cleanup

`packages/daemon/src/desktop/windows-hud/Hud.cs:939`, `packages/daemon/src/desktop/windows-hud/Hud.cs:951`

Scenario: the supervisor runs inside an enclosing job with UI restrictions. Windows can reject nested job assignment, but the return value of `AssignProcessToJobObject` is ignored. A zero result from `MakeJob` also permits unmanaged execution. When Node dies, closing the per-attempt job cannot remove agent descendants that were never assigned to it; a replacement attempt starts alongside them. The new stdin EOF watcher protects the HUD helper, not all agent descendants. [Windows documents nested-job assignment restrictions](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs).

Suggested fix: require successful job creation and assignment before accepting the listener, and log/fail safely or provide explicit descendant cleanup when either fails. Ensure the startup sequence does not leave children outside the job.

### [P2] Missing or stale hotkey status still becomes a readiness claim

`packages/cli/src/commands/hud.ts:64`, `packages/cli/src/commands/setup.ts:663`, `packages/cli/src/commands/doctor.ts:107`

Scenario: security software blocks Node, the saved CLI cannot start, or hotkey registration takes longer than the handshake deadline. `waitForHotkey` returns null. Installation warns that it is still starting, then prints an available shortcut; setup says "Desktop HUD is ready" and returns zero. Doctor and HUD status also describe a live retrying supervisor as a working listener when status is absent. After a previously ready listener crashes, its old `hud-status.json` can produce the same false result because readiness is not associated with the current attempt.

Suggested fix: announce a usable shortcut only after a ready handshake from the current listener instance. Represent starting/unavailable separately, invalidate status on listener exit/restart, and have setup, install, status, and doctor use the same readiness check. Temporary characterization tests reproduced the contradictory setup output after a timeout.

### [P2] Setup reports success after a required installation step fails

`packages/cli/src/commands/setup.ts:612`, `packages/cli/src/commands/setup.ts:668`, `packages/cli/src/commands/setup.ts:677`

Scenario: adding the Windows Run entry fails, or MCP registration fails. Setup prints a note but does not mark either failure in `helperError`, and still returns zero with "Desktop HUD is ready". The one-line installer consequently prints "All done" although the hotkey service or browser tools are absent. A missing browser follows the same success path. The Windows setup tests skip actual MCP registration whenever a mock runner is present and explicitly expect success with no browser.

Suggested fix: propagate failure of every required step into the setup result and suppress readiness instructions until the dependencies are present. Add failure tests for service installation, real MCP registration through an injected transport, and browser discovery. A temporary test reproduced exit zero and the ready message after an injected registry-install failure.

### [P2] Early Node 22 releases are accepted although the CLI cannot load

`scripts/install-windows.ps1:98`, `packages/cli/src/commands/doctor.ts:28`

Scenario: Node 22.4 or 22.12 is already installed. The major-only check accepts it and skips installing a usable runtime. The CLI imports `node:sqlite` through `local-task-store.ts:1`, but that module was added in 22.5 and required an experimental flag until 22.13. The unflagged CLI therefore fails before guided setup begins. [Node's SQLite version history](https://nodejs.org/api/sqlite.html) establishes this compatibility boundary.

Suggested fix: check the complete version against the actual unflagged runtime minimum, or probe the required module before accepting an existing Node. Align doctor, package engine declarations, and documented requirements with that minimum.

### [P2] The captured npm prefix corrupts non-ASCII Windows profile paths

`scripts/install-windows.ps1:114`

Scenario: Windows PowerShell 5.1 uses its default OEM console encoding and the profile is `C:\Users\José Müller`. npm writes the captured prefix as UTF-8, but the native-output reader decodes it using the console encoding. The resulting mojibake path is added to PATH and used to look for `rh.cmd`, so setup stops even though npm installed the package. This is a static encoding inference, not a native Windows reproduction: the [.NET Framework process reader](https://raw.githubusercontent.com/microsoft/referencesource/main/System/services/monitoring/system/diagnosticts/Process.cs) uses `Console.OutputEncoding`, while [Node documents UTF-8 console output](https://nodejs.org/api/child_process.html#maxbuffer-and-unicode).

Suggested fix: capture this output with an explicitly UTF-8 decoder, restoring any temporary console-encoding change afterward. Exercise the real PowerShell 5.1 installer with a non-ASCII user/global-prefix path.

### [P2] The prefix lookup can disagree with the global installation

`scripts/install-windows.ps1:114`

Scenario: run the installer from a project whose `.npmrc` defines a prefix. `npm install -g` ignores project configuration, whereas `npm config get prefix` reads it. The installer then removes shims and searches for `rh.cmd` in the project's prefix instead of the global installation directory, and fails at line 121. Temporary-directory reproduction returned different directories for the two prefix queries. [npm documents that project configuration is excluded in global mode](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc/).

Suggested fix: query `npm config get prefix -g` and check its exit status before using the result.

### [P2] A huge PATH prevents the batch launcher from starting guided setup

`scripts/install-windows.ps1:126`

Scenario: the process PATH exceeds 8,191 characters. PowerShell can find Node, and the portable `npm.cmd` can invoke its sibling Node by absolute path. The global APPDATA `rh.cmd` normally has no sibling Node and falls back to the bare `node` command. `cmd.exe` drops an inherited PATH of this size, so that launcher fails before setup starts. [Microsoft documents the inherited-variable limit](https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation); [npm's shim generator contains this runtime fallback](https://raw.githubusercontent.com/npm/cmd-shim/main/lib/index.js).

Suggested fix: invoke setup through the selected absolute Node executable and installed CLI entry point, and supply persistent launchers that use that runtime. Avoid depending on cmd's inherited PATH for the core installation journey.

### [P2] The agy shell command leaves valid Windows path characters executable

`packages/cli/src/system/agy.ts:22`, `packages/daemon/src/system/windows.ts:65`

Scenario: agy is installed under `C:\Users\Ana&Lee\AppData\Local\agy\bin\agy.exe`. `shellQuote` quotes only whitespace, so the command is returned unquoted. `defaultRunner` uses `shell: true`; cmd splits it at `&` and agy never starts. Parentheses and environment-expansion characters provide further valid-path cases that whitespace-only quoting does not handle. The space-path and quoted PowerShell-pipe tests do not cover these inputs. [Microsoft documents cmd metacharacter handling](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd).

Suggested fix: execute the native Windows agy executable without a shell and pass arguments separately. If the runner must retain a shell, apply Windows command/argument escaping rather than whitespace-only quoting. Preserve the existing Mac runner sequence.

### [P2] Ordinary Chrome being open blocks the Windows browser CLI

`packages/cli/src/commands/browser.ts:31`

Scenario: the person's ordinary Chrome is open without remote debugging, and Remote Hands' own browser has not started yet. `ensureChromeAutomationReady` returns before constructing its dedicated-profile manager whenever any system Chrome exists. Thus `rh browser tabs`, `snapshot`, and `open` cannot bootstrap the Windows browser, although the separate profile can coexist with ordinary Chrome. MCP uses a different startup path and does not have this refusal. A temporary test verified that the dedicated manager is never called in this case.

Suggested fix: limit the existing system-browser refusal to the platform/profile modes that require it. Allow Windows dedicated-profile startup while ordinary Chrome is running.

### [P2] The workspace guard does not enforce Windows path boundaries

`packages/shared/src/security.ts:21`, `packages/shared/src/security.ts:55`, `packages/daemon/src/config.ts:42`

Scenario: a Windows remote task selects `C:\Users\Ana\.ssh`; the credential-directory guard accepts it because it only recognizes `/`. With an explicit allowlist of `C:/work`, `C:/work/..\Users\Ana\.ssh` also passes the prefix check, but Windows resolves it outside the allowed workspace. Additionally, the configured list splits at `:`, including the drive-letter colon, so a normal `C:\work` allowlist rejects its legitimate descendants. The traversal and credential examples were reproduced in a temporary test. This finding concerns the final project pass and the remote-task guard, rather than the browser-only MCP tool list.

Suggested fix: canonicalize Windows drives, separators, and traversal before credential/allowlist comparisons, and use a Windows-safe representation for configured path lists. Cover both legitimate drive paths and mixed-separator escapes.

### Verified

Reviewed the commits in their actual chronological order: `a3cc95ee4717b2e4b4823c418f085912e564a207` (HUD fixes), then `75639d6b5e446dfac634fbddaa3aa97b350878eb` (W4), plus the Windows browser/agent paths present at that final commit. Findings and tests use an isolated archive of `75639d6` at `/private/tmp/rh-w4-review-9khfs8af`. Concurrent working-tree edits to Windows files were excluded.

The W3 fixes present in source are: a job created and closed per listener attempt; piped listener stdin and helper exit on EOF; `--once` skipping daemon input and exiting after submission; removal of `AttachThreadInput`; listener `AllowSetForegroundWindow(-1)` before the hotkey event followed by prompt activation/Alt fallback; normal PID/tasklist-scoped stopping; Node/CLI settings in `hud.json`; registration output in `hud-status.json`; a short supervisor-only Run command; and restoration of `.old` after a failed publication rename with the stamp written only after publication. Assignment failure, legacy migration, same-image PID reuse, and readiness gaps are reported above.

The installer checksum is compared before extraction. No additional concrete defect was established in the reviewed `$Matches`, scalar/array, null-property, checksum, or UNC-only paths. The script was not executed under PowerShell 5.1; no claim of antivirus/SmartScreen or redirected-folder runtime verification is made.

Commands run in the isolated archive:

```sh
npx vitest run packages/daemon/src/desktop/windows-hud.test.ts packages/daemon/src/desktop/hud-service.test.ts packages/daemon/src/desktop/spotlight-hud.test.ts packages/cli/src/commands/hud.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/setup-windows.test.ts packages/cli/src/system/agy.test.ts packages/cli/src/install-windows-script.test.ts packages/daemon/src/system/windows.test.ts packages/daemon/src/chrome-manager.test.ts packages/daemon/src/agy-runner.test.ts packages/daemon/src/agy-runner.kill.test.ts packages/daemon/src/warm-agy-session.test.ts packages/cli/src/commands/mcp.test.ts packages/daemon/src/browser-driver.test.ts packages/daemon/src/guidance/hud-coordinator.test.ts packages/daemon/src/guidance/hud-feed.test.ts packages/daemon/src/hud-models.test.ts
```

Result: 18 files passed, 308 tests passed.

```sh
npx vitest run --project=@remote-hands/daemon packages/daemon/src/browser/cdp-transport.test.ts packages/daemon/src/browser/default-cdp.test.ts packages/daemon/src/computer/session.test.ts packages/daemon/src/computer/prompt.test.ts packages/daemon/src/computer/tools.test.ts
```

Result: 5 files passed, 119 tests passed.

```sh
npx vitest run --project=remote-hands-cli packages/cli/src/commands/windows-w4-setup-characterization.test.ts packages/cli/src/commands/windows-w4-browser-characterization.test.ts
npx vitest run --project=remote-hands-cli packages/cli/src/commands/windows-w4-mac-sequence.test.ts
npx vitest run --project=@remote-hands/shared packages/shared/src/security.test.ts packages/shared/src/windows-w4-security-characterization.test.ts
```

Results: 9, 3, and 6 tests passed respectively. Characterization files and the copied baseline setup module exist only in the isolated archive. The three Mac tests compared exact mock-runner command/argument/options sequences against `c1610c4` for already-installed agy, installing missing agy, and interactive sign-in. All three sequences matched. The first unscoped characterization run failed during unrelated Cloudflare Vite initialization with `listen EPERM ... 0.0.0.0:9229`; the project-scoped rerun passed.

```sh
node packages/daemon/scripts/check-windows-hud.mjs
NuGetAudit=false node packages/daemon/scripts/check-windows-hud.mjs
```

The initial C# check failed with NU1900 because NuGet vulnerability data could not be fetched. With that network audit disabled, C# 5/net48 compilation passed with 0 warnings and 0 errors; 108 logic checks passed. The successful check also emitted a macOS `CSSM_ModuleLoad` diagnostic.

No Windows runtime execution was available. WinForms activation, registration, job/process termination, registry login startup, executable replacement, PowerShell native-output decoding, and actual antivirus behavior remain statically reviewed. Only this review file was written in the repository; no fixes or commits were made.
