### [P0] Drive-relative Windows paths pass an allowlist for a different directory

`packages/shared/src/security.ts:43`, `packages/shared/src/security.ts:48`, `packages/daemon/src/daemon.ts:60`, `packages/daemon/src/agy-runner.ts:642`

Scenario: the daemon starts in `C:\Users\Ana\Documents`, the configured allowlist is `C:\work`, and a cleanup task supplies workspace `C:work`. The new drive regex accepts a drive without a following separator and inserts `/`, so the guard compares this as `c:/work` and allows it. The runner passes the original string to `spawn` as `cwd`. Windows resolves it to `C:\Users\Ana\Documents\work`, where the task can delete or modify the person's documents outside the allowed workspace. The parent commit rejected this allowlist combination. The temporary characterization verifies the changed acceptance and the different `path.win32.resolve` result. Windows distinguishes these two path forms explicitly in its [path-format documentation](https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats).

Suggested fix: reject drive-relative Windows workspaces and allowlist entries, or resolve them on the executing machine before checking and pass that same resolved absolute path to the runner. Do not turn `C:work` into `C:\work` by string normalization. Keep the Unix branch unchanged.

### [P1] Removing the job lets the listener survive supervisor death and block replacement

`packages/daemon/src/desktop/windows-hud/Hud.cs:907`, `packages/daemon/src/desktop/windows-hud/Hud.cs:925`, `packages/daemon/src/computer/mcp-server.ts:104`

Scenario: the C# supervisor crashes or the person ends that process alone in Task Manager's Details view, then reruns `rh hud install`. The Node listener has no supervisor pipe/watchdog and keeps running while idle; it still owns the hotkey helper and any current agent session. The saved supervisor PID is dead, so install cannot find or stop that old listener. The new supervisor obtains the released mutex and starts another listener, which reports hotkey failure because the orphan listener still owns the shortcut. Uninstall then stops only the new supervisor tree, leaving the original listener active. The removed C# job used to close this supervisor-to-listener lifetime gap. MCP EOF handling does nothing here: its agy client and the owning Node listener are still alive. Windows [does not terminate children when their parent terminates](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process).

Suggested fix: give Node a supervisor-lifetime pipe/watchdog and stop its listener/agent operations when that owner disappears, or restore a supervisor-owned job with an external browser broker. Track and verify the exact listener identity so reinstall can recover an orphan. Verify supervisor-only termination followed by install/uninstall. This is a source/Windows-semantics finding, not a native Windows reproduction.

### [P1] The percent/exclamation fallback puts Chrome back in the cancelled agent tree

`packages/daemon/src/system/windows.ts:123`, `packages/daemon/src/chrome-manager.ts:423`, `packages/daemon/src/chrome-manager.ts:425`

Scenario: the Windows profile is `C:\Users\Ana!Lee` or `C:\Users\Ana%USERNAME%`. A browser tool in the agy-owned MCP process starts the dedicated browser. The new fallback correctly preserves the literal folder but starts Chrome directly from MCP. After the person begins filling a form, cancelling the task invokes `taskkill /T /F` on agy and kills MCP and Chrome, losing the open form. Reinstalling the HUD also kills that direct descendant. `detached: true` permits survival of a normal parent exit; it does not remove the creator/descendant relationship used by [taskkill `/T`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill). See also [Node's detached-process contract](https://nodejs.org/api/child_process.html#optionsdetached). The committed test verifies literal arguments, but never exercises tree termination.

Suggested fix: use a launch broker that receives the executable and arguments as data and creates Chrome outside the service/agent tree for every valid path spelling. Verify cancellation, idle timeout, and service replacement with a form open under `%` and `!` profiles. This conclusion is based on the spawn and cancellation paths; Windows was unavailable.

### [P2] agy setup still expands percent-containing executable paths

`packages/daemon/src/system/windows.ts:65`, `packages/cli/src/commands/setup.ts:164`, `packages/cli/src/cloudflare/wrangler.ts:19`

Scenario: agy is installed at `C:\Users\Ana%USERNAME%\AppData\Local\agy\bin\agy.exe`. Setup still constructs a quoted command string and runs it with `shell: true`. cmd expands `%USERNAME%` inside the path and attempts to start a different executable path, so authentication/setup fails although agy is installed. The browser-specific null fallback does not change this caller. This part of the W4b finding is unchanged. [cmd documents percent substitution](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd#substituting-environment-variable-values).

Suggested fix: invoke the located native agy executable with separate arguments and `shell: false` for authentication and sign-in, retaining shell use only where a shell command is actually required. Verify literal `%USERNAME%`, `!`, ampersand, and non-ASCII paths with native argument capture.

### [P2] Private Node replacement still deletes an in-use runtime

`scripts/install-windows.ps1:89`, `scripts/install-windows.ps1:145`, `packages/daemon/src/desktop/hud-service.ts:167`

Scenario: upgrade a legacy private Node 22.12 installation whose running HUD uses `NODE_OPTIONS=--experimental-sqlite`. The installer rejects its version and recursively deletes `$NodeDir` before reaching guided setup, which is where the existing HUD would be stopped. Windows refuses deletion of the mapped `node.exe`; other unlocked runtime files may already have been deleted. With terminating errors, installation aborts before moving in the replacement, leaving the launchers bound to an incomplete runtime. Repeating the advertised installer command encounters the same running executable. This W4b finding is unchanged; ordinary reruns with compatible Node do not enter this branch. [Windows documents deletion failure for mapped/open files](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew).

Suggested fix: stage complete versioned runtimes, validate the replacement, switch settings/launchers, and retire the old runtime after its users exit. Alternatively stop and verify the exact service before replacement, with rollback. Test an actual running listener using the replaced runtime.

### [P2] The W3 supervisor remains undiscoverable without its PID file

`packages/daemon/src/desktop/hud-service.ts:116`, `packages/daemon/src/desktop/hud-service.ts:176`

Scenario: upgrade a still-running `c1610c4` supervisor, which never wrote `hud-supervisor.pid`. The early return prevents any process discovery, so install does not stop it. The replacement supervisor exits because the old process owns `Local\RemoteHandsHudSupervisor`; the person retains the old listener despite completing the upgrade. Uninstall likewise removes startup registration while leaving that service running. The temporary characterization confirms that uninstall never queries processes or calls taskkill when the PID is missing. This W4b finding is unchanged.

Suggested fix: add narrowly scoped legacy discovery using canonical executable identity, the actual supervisor role, and process creation identity. Stop and verify that instance before publishing/starting its replacement, without killing independent prompt windows.

### [P2] Lexical home-path comparison rejects the same registered executable through an alias

`packages/daemon/src/desktop/hud-service.ts:127`, `packages/daemon/src/desktop/hud-service.ts:140`

Scenario: the supervisor was registered/launched through `C:\Users\Ana Lee\.remote-hands\bin\rh-hud.exe`, then the CLI runs with the equivalent short-name home spelling, or a profile migration leaves that original home as a junction to the current home. The PID file is reachable through both spellings, but the command-line path differs from the string reconstructed from the current home. `isRunning()` returns false; uninstall skips taskkill and deletes the only PID file. Reinstall starts a supervisor that loses the existing mutex. The temporary test uses two filesystem aliases of the same fixture executable and reproduces this rejection and missing kill. Case differences and forward/backward slashes do match; long/short names and junction aliases do not.

Suggested fix: compare canonical executable/file identity against the previously registered installation, using the process's actual executable path and a verified creation identity. Capture the old registration before overwriting it. Canonicalize aliases rather than weakening the check to an image-name substring.

### [P2] Launcher-shadow detection misses executable and alternate-command conflicts

`scripts/install-windows.ps1:116`, `scripts/install-windows.ps1:120`, `scripts/install-windows.ps1:174`

Scenario: an earlier machine-PATH directory contains `rh.exe` or `rh.bat`, or contains only an older `remote-hands.cmd`. `Test-LauncherShadow` checks only `rh.cmd`, finds no conflict, and says both short commands are ready. A new PowerShell resolves the earlier executable/script instead of the private launcher, so the advertised command runs another program or the old installation. [PowerShell resolves external commands using executable extensions](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence?view=powershell-5.1#run-external-executables). Even for the detected `rh.cmd` case, the final success/failure instructions unconditionally revert to the shadowed `rh doctor`/`rh setup --hud` spelling.

Suggested fix: check actual fresh-environment resolution for every advertised launcher and all applicable executable extensions. Carry the conflict result into the final instructions and consistently print an escaped absolute private-launcher invocation when a short command is shadowed. The existing installer test checks string presence, not command resolution.

### [P2] The engine range still advertises Node 23.0–23.3 as supported

`packages/cli/package.json:52`, `package.json:22`, `packages/daemon/package.json:15`

Scenario: a person installs the CLI directly with Node 23.3.0. It satisfies the new `>=22.13.0` engine range, but SQLite still requires `--experimental-sqlite` on that version. The bundled CLI imports `local-task-store.ts` and its `node:sqlite` import before dispatching commands, so ordinary setup/doctor invocations fail before the new doctor check can explain the requirement. The installer and doctor correctly exclude 23.0–23.3; the package range does not. Semver acceptance was checked locally; [Node's SQLite history](https://nodejs.org/api/sqlite.html) identifies 23.4.0 and 22.13.0 as the flag-removal releases. No Node 23 runtime was executed here.

Suggested fix: use the same supported set everywhere, such as `>=22.13.0 <23.0.0 || >=23.4.0`, and synchronize package-lock engine metadata and prerequisite text. An early bootstrap version check can also provide a readable error before importing SQLite.

### Verified

Reviewed the single requested commit, `fcb8540f90c9fc038f4397c7292401bc65c8e669`, against its parent and every finding in `windows-w4b-codex-review.md`. Tests and characterizations ran in the isolated archive `/private/tmp/rh-w4c-review-xzrf1ict`. The later `1984a16` commit that appeared in the checkout during review is excluded. File/line references above refer to `fcb8540`.

| W4b finding | Disposition at fcb8540 |
| --- | --- |
| Browser inherits the HUD kill-on-close job | That job is removed. Supervisor crash cleanup and the direct browser fallback are reported above. |
| Percent paths reach cmd | Browser arguments containing `%`/`!` now bypass cmd. agy setup still uses the shell, as reported above. |
| In-use private Node replacement | Unchanged; reported above. |
| Earlier machine-PATH launcher | A warning/private invocation is added for `rh.cmd`. Other executable spellings and final instructions remain defective above. |
| Role substring kills a prompt | Parsed first-role matching excludes the reported `prompt --app=supervise` case. Case and slash spellings match. Canonical executable aliases remain defective above. |
| W3 supervisor lacks PID | Unchanged; reported above. |
| Failed job assignment leaves descendants | The C# job/assignment is removed. Node's own immediate-child jobs and MCP EOF handle some lifetimes; the unowned supervisor-to-listener link is reported above. |
| Hotkey failure erased before polling | `failed` survives helper exit; ready alone is cleared. Status no longer says listening for a failed shortcut. |
| Abrupt Node death leaves ready | Supervisor calls `ForgetReadyStatus` before and after a configured Node attempt, including start failure. It removes ready and retains failed. |
| UNC traversal and slash-form UNC | Share root is preserved and traversal clamped; both separator spellings are checked with the Windows option. |
| Mac semicolon allowlist boundary | Delimiter is selected by execution platform. The literal Mac semicolon case is covered. |
| Drive-shaped relative Unix names | Windows rules require explicit opt-in. Serialized Unix results matched the pre-Windows `75639d6` implementation across 13,689 combinations of absolute/relative paths and allowlists. |

For stale failure specifically, install calls `clearHudStatus(this.home)` after stopping the old supervisor and before starting the new one. A characterization starts with an old failed record, verifies its removal inside the launch callback, writes the new ready record, and verifies that `waitForHotkey` returns the new ready. Closing the conflicting program and rerunning a normal install therefore does not read that previous install's failure first. While a retry is pending, retained failed is the last observation; ready overwrites it. No additional false reinstall failure was established from retaining failed alone.

The only production callers of `isSafeWorkspacePath` are daemon task validation and agy trusted-workspace handling; both now pass `{ windows: process.platform === 'win32' }`. Unix reasons and normalized-path text matched byte for byte in the characterization. Three Mac `setup --hud` flows (agy already installed, installing agy, and interactive sign-in) also matched the pre-Windows baseline's command/argument/options sequences, return codes, stdout, and stderr.

The new EOF hooks belong to `serveComputerMcp`, not `createComputerMcpServer`; the existing in-memory MCP tests do not install them. A native Node subprocess using the actual stdio server and harmless session stub completed initialize, tools/list, and a tool call, remained alive between requests, and exited with code 0 on input EOF despite a live interval modeling an open CDP handle. It did not touch the browser or desktop. A stdio server cannot receive more client messages after EOF; no premature exit was established with an MCP client keeping its input pipe open. The Mac AX helper also has its own input-EOF exit loop.

[Node 22.13's libuv implementation](https://github.com/nodejs/node/blob/v22.13.0/deps/uv/src/win/process.c) assigns immediate non-detached children to its own kill-on-close job, with silent breakaway for their descendants. Both agy runners use non-detached Windows spawns. Consequently, removing the C# job does not by itself prove that the immediate agy process survives Node death. That protection does not cover the C# supervisor's Node child, and is distinct from a job owning every arbitrary descendant. No additional concrete orphan scenario depending on agy's undocumented shell-child cleanup was asserted.

Root, CLI, daemon, shared, and control-plane engine declarations change to 22.13. CI requests the Node 22 release line, without pinning an older minor. Cloudflare/supabase manifests and package-lock still contain 22.0 declarations; no additional runtime failure was established for those workers/test packages from that metadata alone. Published CLI/runtime support for early Node 23 remains the defect above.

Commands run in the archive, with a temporary Vitest config aliasing workspace packages to the archive's source so prebuilt checkout `dist` files were not tested:

```sh
npx vitest run packages/daemon/src/system/windows.test.ts packages/daemon/src/chrome-manager.test.ts packages/daemon/src/chrome-manager.windows.test.ts packages/daemon/src/desktop/hud-service.test.ts packages/daemon/src/desktop/spotlight-hud.test.ts packages/daemon/src/desktop/windows-hud.test.ts packages/daemon/src/config.test.ts packages/shared/src/security.test.ts packages/cli/src/install-windows-script.test.ts packages/cli/src/system/agy.test.ts packages/cli/src/commands/hud.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/setup-windows.test.ts packages/cli/src/commands/browser.test.ts packages/daemon/src/agy-runner.kill.test.ts packages/daemon/src/warm-agy-session.test.ts packages/daemon/src/browser/default-cdp.test.ts packages/daemon/src/computer/mcp-server.test.ts packages/cli/src/commands/mcp.test.ts

npx vitest run packages/shared/src/windows-w4c-characterization.test.ts packages/daemon/src/desktop/windows-w4c-characterization.test.ts packages/cli/src/commands/windows-w4c-mac-characterization.test.ts

npx esbuild review-mcp-fixture.ts --bundle --platform=node --format=esm --packages=external --outfile=review-mcp-fixture.mjs
npx vitest run packages/daemon/src/computer/windows-w4c-stdio-characterization.test.ts

npx vitest run packages/daemon/src/desktop/windows-w4c-characterization.test.ts packages/shared/src/windows-w4c-characterization.test.ts packages/cli/src/commands/windows-w4c-mac-characterization.test.ts packages/daemon/src/computer/windows-w4c-stdio-characterization.test.ts
```

Results: committed tests, 19 files / 268 passed; initial characterizations, 3 files / 10 passed; native stdio, 1 file / 1 passed; final characterizations after strengthening the executable-alias fixture, 4 files / 11 passed. Characterizations assert observed defects or preservation; they are not fixes. The final distinct selection covers 23 files / 279 tests.

No Windows runtime, PowerShell, native registry/mutex/process-tree termination, cmd argument capture, or in-use executable replacement was available. Those findings are source/documentation conclusions, distinguished from tests above. Only this review file was written in the repository; no fixes or commits were made.
