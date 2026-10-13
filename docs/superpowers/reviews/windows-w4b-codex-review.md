### [P1] The browser still belongs to the HUD's kill-on-close job

`packages/daemon/src/chrome-manager.ts:424`, `packages/daemon/src/system/windows.ts:117`, `packages/daemon/src/desktop/windows-hud/Hud.cs:951`

Scenario: a browser task launched from the installed HUD opens Chrome, and the person begins editing a form. The Node listener crashes, or the person reruns setup to update the service. `cmd /c start` starts the executable from a descendant of the listener; exiting cmd removes the live intermediate parent but does not remove inherited job membership. The supervisor's job has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, with neither breakaway limit enabled. Closing that job on listener exit or supervisor termination therefore closes the browser and its tabs too. The new launch fixes the ordinary agy `taskkill /T` path after cmd has exited, but does not provide the claimed independent browser ownership. This conclusion follows from the source and [Microsoft's job inheritance rules](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects); it was not exercised on Windows.

Suggested fix: launch through a broker outside the listener's job, or implement explicit, permitted job breakaway for the browser. Verify task cancellation, agent idle timeout, listener crash/restart, and service reinstall while a browser form remains open. The mocked spawn assertion does not verify any of those lifetimes.

### [P2] Quoting percent-containing paths still lets cmd expand them

`packages/daemon/src/system/windows.ts:65`, `packages/daemon/src/system/windows.ts:106`, `packages/daemon/src/system/windows.ts:121`

Scenario: the Windows profile directory is `C:\Users\Ana%USERNAME%`. Browser launch now sends `"--user-data-dir=C:\Users\Ana%USERNAME%\.remote-hands\chrome-profile"` through cmd. Double quotes protect the ampersand in `Ana&Lee`, but do not protect `%USERNAME%`: cmd substitutes its value, so Chrome receives a different profile directory. A per-user Chrome executable under that profile can instead become an executable-not-found failure. The agy setup path has the same problem: `shellQuote` now adds quotes for `%`, but `defaultRunner` still uses a shell, which expands the path before starting agy. [Microsoft documents percent substitution and its nonrecursive behavior](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd). The temporary characterization confirms the literal expansion expression reaches cmd unchanged.

Suggested fix: start the native agy executable with separate arguments and no shell. Use a browser launch broker that accepts data separately from shell syntax; if cmd remains, preserve literal percent signs and explicitly disable delayed expansion for `!`. Add native argument-capture cases for `%USERNAME%`, `&`, `!`, and a non-ASCII profile.

### [P2] Private Node replacement deletes a runtime still used by the HUD

`scripts/install-windows.ps1:89`, `scripts/install-windows.ps1:125`, `packages/daemon/src/desktop/hud-service.ts:162`

Scenario: upgrade a legacy installation whose private `node.exe` is 22.12 and whose HUD was started with `NODE_OPTIONS=--experimental-sqlite`. The previous major-only check accepted that runtime; the new check rejects it and enters `Install-Node`. The running listener still maps that private executable because `hud.json` records `process.execPath`. Recursive removal can delete unlocked files before failing on the in-use executable, and `$ErrorActionPreference='Stop'` aborts before publishing the downloaded replacement. Existing launchers still point at the partly removed directory. The same command repeats the failure until the service is stopped; stopping it currently occurs only inside the later guided setup. The lock conclusion is static, supported by [Windows file deletion rules](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew).

Suggested fix: stage complete versioned Node directories, validate the new runtime, and switch launchers/settings only after publication; retire the previous directory after its users exit. Alternatively stop and verify the exact service before replacing its runtime, retaining rollback. Test replacement with a listener actually running from the old directory.

### [P2] An existing machine-PATH launcher can still select the old installation

`scripts/install-windows.ps1:41`, `scripts/install-windows.ps1:140`

Scenario: an older machine-wide Remote Hands installation has `C:\Program Files\nodejs\rh.cmd` on the machine PATH, alongside Node 20. This installer creates its private launchers and prepends their directory to the user PATH. Setup works in the current PowerShell because the process PATH is also prepended. A newly opened terminal still searches the machine entry first, selects the old `rh.cmd`, and loads the CLI with Node 20. Thus the advertised `rh doctor` follow-up can fail even though the new private launcher itself is correct. The fix binds the runtime only after that launcher has been selected. [npm documents this Windows PATH precedence problem](https://docs.npmjs.com/try-the-latest-stable-version-of-npm/).

Suggested fix: detect earlier conflicting `rh`/`remote-hands` launchers, verify command resolution from a fresh environment, and provide a working private-launcher invocation or a controlled migration of the old launcher before advertising the short commands as ready.

### [P2] Command-line substring matching can still kill an independent prompt

`packages/daemon/src/desktop/hud-service.ts:123`, `packages/daemon/src/desktop/hud-service.ts:133`

Scenario: a crashed supervisor leaves PID 4242, which Windows reuses for `"C:\Users\supervise\.remote-hands\bin\rh-hud.exe" prompt --app=Chrome`. The image-name substring and `\bsupervise\b` both match, although the role is `prompt`. Reinstall/uninstall then runs `taskkill /PID 4242 /T /F`, discarding that independent prompt or stopping its task. A temporary test reproduces both the false `isRunning()` result and the kill. Executable path and process creation identity also remain unchecked.

Suggested fix: verify `ExecutablePath`, parse and compare the actual role argument, and associate the PID with a process creation identity or supervisor instance token. Include role words inside path components and prompt arguments in stale-PID tests.

### [P2] The W3 supervisor still cannot be migrated without its PID file

`packages/daemon/src/desktop/hud-service.ts:115`, `packages/daemon/src/desktop/hud-service.ts:171`

Scenario: upgrade a still-running `c1610c4` installation. That supervisor did not write `hud-supervisor.pid`; the new command-line check returns before querying processes, so setup never stops it. The replacement supervisor exits because the old process holds `Local\RemoteHandsHudSupervisor`. The previous listener remains active without the new readiness/lifecycle fixes. Uninstall likewise removes the registry entry without stopping the legacy process. This previous review finding is unchanged.

Suggested fix: add a narrowly scoped legacy discovery/migration path using the expected executable path and real supervisor role, stop that specific instance, and verify it exited before starting the replacement.

### [P2] Failed job assignment still permits unmanaged agent descendants

`packages/daemon/src/desktop/windows-hud/Hud.cs:951`, `packages/daemon/src/desktop/windows-hud/Hud.cs:952`

Scenario: the HUD is launched inside an enclosing job that rejects the nested assignment. The listener continues after assignment failure, now with a log message. An agent starts a long-running PowerShell operation; the listener subsequently dies. Closing the unassigned job cannot terminate that operation, and the supervisor starts another listener while the operation is still running. The HUD helper's stdin EOF watcher only covers that helper, not arbitrary agent subprocesses. Logging does not fix the previous cleanup finding. [Microsoft documents assignment failure conditions](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

Suggested fix: require successful job creation and assignment before the listener is allowed to start children, or implement and verify explicit descendant cleanup for the fallback. Create the listener suspended if necessary to avoid the assignment race.

### [P2] Hotkey failure status is erased before setup can observe it

`packages/daemon/src/desktop/spotlight-hud.ts:385`, `packages/daemon/src/desktop/spotlight-hud.ts:395`, `packages/cli/src/commands/hud.ts:101`

Scenario: another application owns both Windows shortcuts. The helper emits `hotkey-failed` and immediately exits with code 3 (`Hud.cs:1001`). The new exit handler deletes the just-written failure status, then retries a second later. If the service's 300 ms poll runs after that exit, it sees no failure; repeated quick failures can all fall between polls. Setup/hud install return the unconfirmed path instead of reporting the shortcut conflict, and doctor usually reports starting/blocked. A temporary test reproduces writing the failure, deleting it on exit, and `waitForHotkey()` returning null. If `rh hud status` does catch the brief failure file, line 101 still prints `Active (listening for Ctrl+Shift+Space)` immediately before saying the hotkey is unavailable.

Suggested fix: invalidate ready status on exit but retain an attempt-tagged terminal failure until the next attempt changes state. Have status print listening only for `state === 'ready'`. Test the real failure-then-exit sequence, rather than a waiter mocked to return a persistent failure.

### [P2] A listener Node crash can still leave permanent stale readiness

`packages/daemon/src/desktop/spotlight-hud.ts:395`, `packages/daemon/src/desktop/windows-hud.ts:183`, `packages/cli/src/commands/doctor.ts:106`

Scenario: the listener registers its shortcut and writes ready, then its owning Node process is forcibly terminated. Its JavaScript exit callback never runs. The supervisor closes the job and keeps running, but subsequent Node launches are blocked by security software or fail before `startListener()` executes. The old ready file remains; doctor sees the live supervisor and that file and tells the person to press a shortcut that nobody holds. The timestamp has no freshness or process-instance check. A temporary test confirms even a ready record with `at: 1` is accepted by the waiter.

Suggested fix: have the supervisor invalidate readiness at the start and end of each Node attempt, and bind readiness to the current listener identity. Keep failure diagnostics separate from current shortcut ownership. Test abrupt owner termination followed by unsuccessful restart.

### [P2] UNC normalization pops the share root and misses slash-form UNC paths

`packages/shared/src/security.ts:15`, `packages/shared/src/security.ts:39`, `packages/shared/src/security.ts:47`

Scenario: a task uses `\\server\share\..\project` with allowlist `\\server\share`. Windows clamps `..` at the share root; `path.win32.normalize` returns `\\server\share\project`. This implementation pops `share`, obtains `//server/project`, and rejects the legitimate workspace. Repeated traversal can also pop the server component. Separately, the equivalent forward-slash form `//server/share/project` is treated as Unix and fails that same allowlist; `//server/share/project/.SSH` also avoids the Windows case-insensitive credential check. Temporary tests reproduce all three results.

Suggested fix: parse and preserve the UNC server/share root before collapsing components, clamp traversal at that root, and normalize both separator spellings under an explicit Windows path flavor. Preserve Unix handling when selecting the flavor.

### [P2] Semicolon autodetection changes an existing Mac allowlist boundary

`packages/daemon/src/config.ts:43`

Scenario: a Mac has `REMOTE_HANDS_WORKSPACE_ALLOWLIST=/Users/Ana/project;archive`, meaning the one literal directory `project;archive` under the previous colon-delimited contract. The new `value.includes(';')` condition splits it into `/Users/Ana/project` and `archive`. Tasks in the intended directory are rejected; `/Users/Ana/project/private`, outside that configured directory, is now accepted. The temporary characterization reproduces the changed entries and newly allowed path. This is a Mac behavior change, even though the new syntax was intended for Windows.

Suggested fix: select the delimiter by platform, or introduce an explicitly selected/escaped list format. Preserve the existing colon format on macOS, including literal semicolons in directory names.

### [P2] Drive-shaped relative Unix paths become case-insensitive

`packages/shared/src/security.ts:15`, `packages/shared/src/security.ts:48`

Scenario: on a case-sensitive Unix filesystem, a workspace has a literal directory named `C:` with separate `work` and `Work` children. The configured relative allowlist is `C:/work`; the task selects `C:/Work/private`. The previous guard rejects it. The new syntax-only Windows detection folds both paths to lowercase and allows the distinct directory. Likewise, the valid relative Unix directory `C:/Windows` is now rejected as a Windows system directory. These shared functions have no platform parameter, so the Windows rules apply on Unix too. A temporary baseline comparison reproduces both behavior changes.

Suggested fix: select the path flavor explicitly from the execution platform before normalization and comparison, retaining the prior Unix behavior for relative names as well as absolute paths. Add baseline cases with drive-shaped Unix relative names on a case-sensitive filesystem.

### Verified

Reviewed actual history oldest first: `9adcb29b49ade017ea5c3e837f6de38e07d5952b`, then its child `afe1346d0555eac47709f7492f7a4799410449ab`. The order in the request was reversed. Findings refer to `afe1346`. Tests and temporary characterization files used an isolated archive at `/private/tmp/rh-w4b-review-_mwruld5`. A concurrent `e76a5e1` commit and pre-existing working-tree changes were excluded.

Disposition of every finding in `windows-w4-codex-review.md`:

| Previous finding | Verification |
| --- | --- |
| Installed Node loses PATH precedence | Private launchers use absolute private Node; machine-launcher shadowing remains above. |
| Agent cancellation closes the browser | After cmd exits, the live agy tree loses that intermediate parent; inherited HUD job ownership remains above. No native cancellation test was available. |
| W3 lacks the supervisor PID file | Unchanged; reported above. |
| Same-image PID reuse kills a prompt | Typical `prompt`/`listen` lines are excluded; substring false positives remain above. |
| Failed job assignment leaves descendants | Added logging only; reported above. |
| Missing/stale status claims readiness | Missing status no longer prints the usable shortcut in setup/install/doctor; failure handling and abrupt-owner stale status remain above. |
| Required setup step fails but returns success | Windows MCP registration, missing browser, and HUD install failure now enter blockers and return 1; committed tests exercise each. |
| Early Node 22 accepted | Installer checks 22.13+, 23.4+, or 24+. Doctor's major-only check and package engine declarations remain at 22.0.0; they do not enforce the new minimum. |
| Captured npm prefix corrupts non-ASCII paths | Prefix output capture is removed; the prefix is built directly and launchers are ASCII with `%LOCALAPPDATA%`. Native PowerShell encoding was not exercised. |
| Local npm config redirects prefix lookup | Lookup is removed; installation explicitly passes `--prefix`. |
| Huge PATH breaks guided setup | Guided setup invokes private Node and the CLI directly; launchers invoke the same executable directly. |
| agy path shell characters | Ampersands and parentheses now trigger quoting; percent expansion remains above. |
| Ordinary Chrome blocks browser CLI | Windows skips the refusal and reaches the dedicated manager; temporary test verifies it. Mac refusal remains in place. |
| Windows workspace guard and colon parsing | Ordinary drive paths, case, mixed separators, credential folders, and semicolon-separated drive lists are covered; UNC and Mac delimiter defects remain above. |

Compatible private Node is reused on ordinary reruns, so those reruns do not enter the locked deletion path. They also do not upgrade that compatible Node. An existing compatible Node with missing `node_modules\npm\bin\npm-cli.js` is rejected at installer line 132 rather than repaired. The locked replacement finding specifically concerns the replacement branch.

The empty `start` title, outer `/s /c` quote wrapper, and `windowsVerbatimArguments` preserve the intended inner quotes for ordinary space/ampersand paths. No concrete non-ASCII-only browser-command defect was established. Percent expansion is a separate cmd parsing layer. `isRunning()` now synchronously starts PowerShell/CIM; the Windows callers are status and doctor, not a repeating HUD UI poll. No additional cost-related defect was established.

Mac `setup --hud` command/argument/options sequences, return codes, stdout, and stderr matched the `75639d6` baseline for already-installed agy, installing missing agy, and interactive sign-in. A further temporary test compared serialized workspace-guard results against the baseline for 972 absolute Unix path/allowlist combinations; all matched. Drive-shaped relative Unix names fail baseline preservation, as reported above; the config delimiter regression is also separate.

Commands run in the archive (the temporary config aliases workspace packages to this archive's source, avoiding shared prebuilt `dist` modules):

```sh
npx vitest run --project=@remote-hands/daemon --project=remote-hands-cli --project=@remote-hands/shared packages/daemon/src/system/windows.test.ts packages/daemon/src/chrome-manager.test.ts packages/daemon/src/chrome-manager.windows.test.ts packages/daemon/src/desktop/hud-service.test.ts packages/daemon/src/desktop/spotlight-hud.test.ts packages/daemon/src/desktop/windows-hud.test.ts packages/daemon/src/config.test.ts packages/shared/src/security.test.ts packages/cli/src/install-windows-script.test.ts packages/cli/src/system/agy.test.ts packages/cli/src/commands/hud.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/setup-windows.test.ts packages/cli/src/commands/doctor.test.ts packages/cli/src/commands/browser.test.ts
```

Initial result: 14 files, 191 tests passed. There is no `doctor.test.ts`; that filter added no tests.

```sh
npx vitest run --config review-vitest.config.mts packages/daemon/src/system/windows.test.ts packages/daemon/src/chrome-manager.test.ts packages/daemon/src/chrome-manager.windows.test.ts packages/daemon/src/desktop/hud-service.test.ts packages/daemon/src/desktop/spotlight-hud.test.ts packages/daemon/src/desktop/windows-hud.test.ts packages/daemon/src/config.test.ts packages/shared/src/security.test.ts packages/cli/src/install-windows-script.test.ts packages/cli/src/system/agy.test.ts packages/cli/src/commands/hud.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/setup-windows.test.ts packages/cli/src/commands/browser.test.ts packages/daemon/src/agy-runner.kill.test.ts packages/daemon/src/warm-agy-session.test.ts packages/daemon/src/browser/default-cdp.test.ts
npx vitest run --config review-vitest.config.mts packages/daemon/src/windows-w4b-characterization.test.ts
npx vitest run --config review-vitest.config.mts packages/cli/src/commands/windows-w4b-mac-characterization.test.ts packages/shared/src/windows-w4b-unix-characterization.test.ts
```

Results respectively: 17 files / 237 tests passed; 1 file / 7 tests passed; 2 files / 6 tests passed. The three characterization files were subsequently rerun together: 3 files / 13 tests passed, then 3 files / 14 tests passed after adding the relative Unix case. The final combined command was:

```sh
npx vitest run --config review-vitest.config.mts packages/daemon/src/windows-w4b-characterization.test.ts packages/cli/src/commands/windows-w4b-mac-characterization.test.ts packages/shared/src/windows-w4b-unix-characterization.test.ts
```

 Characterizations assert observed defective behavior, the Windows refusal fix, and baseline preservation; they are not fixes or Windows integration tests.

No Windows runtime, PowerShell 5.1, registry, real process-tree/job termination, in-use Node replacement, or native cmd argument-capture execution was available. Windows-only conclusions above distinguish source/documentation reasoning from mock reproductions. Only this review file was written in the repository; no fixes or commits were made.
