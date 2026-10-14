# Second review: `feat/mac-first-run`

Reviewed through `cf4e73b`, including `git log --oneline main..HEAD` and `git diff main...HEAD`. No files were modified. Failure scenarios below were verified against the implementation, with reproductions performed in memory.

## Verification of the original 11 findings

| # | Status | One-line reason |
|---|---|---|
| 1 | **PARTLY** | Undo-write and revocation-write failures are handled, but unreadable recovery records and failed grant persistence still fail silently. |
| 2 | **PARTLY** | Grant/revert share a lock, but stale takeover breaks ownership, and MCP settings edits bypass it. |
| 3 | **PARTLY** | Revert attempts HUD removal, but ignores removal failures and can falsely promise lasting revocation. |
| 4 | **FIXED** | Setup checks recorded consent; an existing `read_file` permission no longer skips confirmation. |
| 5 | **FIXED** | Guided setup receives the required PATH; wrappers expose private Node/npx, and the HUD includes the Remote Hands bin directory. |
| 6 | **FIXED** | Developer-tools detection checks both CLT and full-Xcode Swift locations. |
| 7 | **FIXED** | Every launcher candidate is version-checked, including candidates found through nvm. |
| 8 | **FIXED** | The `rh-browser` wrapper explicitly supplies the `browser` subcommand. |
| 9 | **FIXED** | An unknown service-permission result now blocks the final ready message. |
| 10 | **FIXED** | Missing Screen Recording and failed/unconfirmed shortcuts are represented independently, without claiming the shortcut works. |
| 11 | **PARTLY** | `--remote` requires Full Disk Access again, but `--local` still makes it optional—even with `--no-hud`. |

## Remaining and newly found defects

### 1. P1 — `rh permissions status` silently reverses revocation

**Location:** [permissions.ts:45](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/permissions.ts:45), [permissions.ts:85](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/permissions.ts:85)

**Scenario:** After a successful revert, consent is `"revoked"` and settings are restrictive. Run `rh permissions status`. Because `status` satisfies the default `isFix` expression, the command calls `ensureAgyPermissions(..., { explicit: true })`, restores blanket access, and records `"granted"`. This reproduces on Windows as well.

**Suggested fix:** Classify subcommands explicitly. `status` and `check` must never grant permissions or rewrite consent.

### 2. P1 — Stale takeover can steal a live lock and remove another owner’s lock

**Location:** [agy-permissions.ts:337](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:337), [agy-permissions.ts:353](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:353)

**Scenario:** A background grant acquires the lock, reads granted consent, then stalls or is suspended for over 30 seconds before writing settings. Revert treats its lock as abandoned, removes it, and restores restrictive settings. The original grant resumes and writes permissive settings without rechecking consent. Its unconditional `finally` removal can also delete a replacement owner’s lock.

Two contenders inspecting the same abandoned directory can likewise delete a newly acquired lock using an earlier stale observation.

**Suggested fix:** Use an ownership-aware lock with owner identity, liveness/heartbeat handling, safe takeover, and release restricted to the acquiring owner. Age alone must not establish abandonment.

### 3. P1 — MCP permission edits can undo a completed revert

**Location:** [agy-permissions.ts:192](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:192), [agy-permissions.ts:218](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:218)

**Scenario:** Settings contain blanket access and `mcp(rh-computer/*)`. The permission-removal phase of `rh mcp remove` reads those settings and pauses. Revert restores restrictive settings, records `"revoked"`, and clears the undo manifest. MCP removal resumes and writes its old snapshot with only the MCP rule removed.

Reproduced result: **consent revoked, `defaultAction: "allow"`, wildcard allowance present, empty undo manifest**.

**Suggested fix:** Serialize all settings writers with the same lock, including MCP rule edits and the settings mutations performed by `agy mcp add/remove`.

### 4. P1 — Unreadable state records are treated as absent, defeating revocation and destroying recovery data

**Location:** [agy-permissions.ts:274](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:274), [agy-permissions.ts:305](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:305)

**Scenario A:** A valid `"revoked"` consent file becomes unreadable while the settings and undo paths remain writable. `readAgyConsent()` returns `"none"`, so background startup reapplies blanket permissions.

**Scenario B:** Settings are permissive and a valid undo file is writable but unreadable—for example, mode `0200`. Revert treats the manifest as empty, restores nothing, overwrites the recoverable manifest with `{ files: {} }`, and returns no error. Invalid JSON from an interrupted manifest write has the same handling.

**Suggested fix:** Distinguish missing files from read/parse failures. Fail closed on unreadable consent; preserve and report unreadable/invalid undo records. Write recovery metadata atomically.

### 5. P1 — Revert reports the HUD stopped without establishing that removal succeeded

**Location:** [permissions.ts:76](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/permissions.ts:76), [hud-service.ts:357](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/hud-service.ts:357)

**Scenario:** An older Windows HUD remains registered under a readable but write-protected HKCU Run key. Registry deletion fails and `uninstall()` returns `false`; revert ignores that result, reports the HUD stopped, and exits zero. At the next login, the old copied CLI reapplies blanket settings.

On macOS, `uninstall()` also ignores a failed `launchctl unload`, so deleting the plist does not establish that an already loaded job stopped.

**Suggested fix:** Check removal results and verify both startup removal and process shutdown. Propagate failure and avoid promising lasting revocation until the older service is stopped.

### 6. P1 — An unwritable stale lock causes an infinite synchronous retry loop

**Location:** [agy-permissions.ts:341](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:341)

**Scenario:** `~/.remote-hands` contains an `agy-settings.lock` older than 30 seconds, but directory permissions or an ACL prevent deleting it. Creation returns `EEXIST`; stale removal throws `EACCES`. The catch immediately continues, bypassing both the deadline and the asynchronous delay.

Reproduced with a zero-millisecond deadline: thousands of synchronous retries continued until the VM execution timeout. Setup, HUD startup, and daemon startup share this path.

**Suggested fix:** Retry immediately only for a confirmed disappearance such as `ENOENT`. Return an error for permission failures, and enforce the deadline on every retry path.

### 7. P2 — Setup can claim readiness after permission configuration or Mac service installation fails

**Location:** [setup.ts:235](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.ts:235), [setup.ts:792](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.ts:792)

**Scenario A:** Settings remain restrictive, `agy-undo.json` is unwritable, and the HUD files are writable. Permission configuration returns `false`, but setup continues. With successful service reports, it prints “Desktop HUD is ready” and exits zero despite missing blanket permissions. The ignored permission failure affects Windows too.

**Scenario B:** On macOS, helper preparation succeeds but `hudService.install()` returns failure—for example, copying the CLI fails with `EACCES`. Only Windows adds an installation blocker, so Mac setup still prints “Desktop HUD is ready” and exits zero.

**Suggested fix:** Stop setup on failed required permission configuration, and make failed service installation a readiness blocker on both platforms.

### 8. P2 — Accepted consent can remain revoked while configuration reports success

**Location:** [agy-permissions.ts:552](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:552)

**Scenario:** Consent contains `"revoked"` and is read-only; settings and undo metadata are writable. The user accepts setup’s disclosure. Settings become permissive, but persisting `"granted"` fails. Its boolean result is ignored, so configuration returns `true` while consent remains revoked.

Subsequent `rh hud install` refuses, directing the user back to setup, which repeats the same silent failure.

**Suggested fix:** Require successful grant persistence and report failure. Preserve recovery information and roll back settings if the accepted grant cannot be recorded.

### 9. P2 — Accountless remote setup still skips required Full Disk Access

**Location:** [setup.ts:293](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.ts:293)

**Scenario:** Run `rh setup --local --no-hud` with Screen Recording and Accessibility granted but Full Disk Access denied. The accountless phone/tunnel flow passes `fullDiskAccessOptional: true`, so it does not request FDA despite preparing unattended remote use.

**Suggested fix:** Make FDA optional only for `--hud`; the `--local` remote flow must use the required setting.

### 10. P2 — Bash users without an existing `.bash_profile` never receive the installed commands on PATH

**Location:** [install-mac.sh:172](/Users/kushal/Desktop/project/remote-hands/scripts/install-mac.sh:172)

**Scenario:** A supported Mac uses `/bin/bash` as its login shell and has no `.bash_profile`. Installation writes `.zprofile` and `.zshrc`, but skips Bash configuration because its profile does not exist. New Terminal windows cannot find `rh`, despite the installer saying the commands are ready.

**Suggested fix:** Update the active shell’s startup configuration, including Bash when its profile is absent, while preserving any existing `.profile` fallback behavior.