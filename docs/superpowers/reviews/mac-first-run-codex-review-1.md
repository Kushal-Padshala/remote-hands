Found **11 defects**. Review and reproductions were read-only; no files were modified.

1. **P1 — Undo and revocation records can fail silently.**  
   [agy-permissions.ts:444](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:444), [agy-permissions.ts:282](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:282)

   **Scenario:** Gemini settings are writable, but writing `agy-undo.json` fails with `EACCES`. Settings become permissive and `ensureAgyPermissions()` returns `true`. After the filesystem problem is fixed, revert finds no manifest, reports nothing to restore, and leaves `defaultAction: "allow"`. Separately, a read-only `agy-consent.json` containing `"granted"` makes revert report success while failing to record revocation; the next background caller reapplies blanket permissions. Both reproduced in memory.

   **Fix:** Require durable undo metadata before changing settings. Treat consent-write failures as errors, preserve recovery records, and return nonzero instead of promising successful restoration.

2. **P1 — A concurrent background caller can undo a successful revert.**  
   [agy-permissions.ts:366](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:366)

   **Scenario:** A HUD/daemon startup reads `"granted"` and pauses before reading the manifest. `rh permissions revert` then restores restrictive settings and writes `"revoked"`. The startup resumes and reapplies blanket permissions without checking consent again. The resulting state is **consent revoked, settings allow**. Reproduced in memory.

   **Fix:** Serialize consent checks, settings changes, and manifest updates across processes with a shared lock. Revert must revoke and restore under that same lock.

3. **P1 — Existing installed HUD copies bypass the new revocation mechanism.**  
   [agy-permissions.ts:348](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:348)

   **Scenario:** An existing user upgrades the npm CLI but retains the old LaunchAgent and copied CLI. With restrictive settings in place, the new CLI runs `rh permissions fix`, then successfully reverts. At next login, the old copied CLI runs its old `ensureAgyPermissions()`, which ignores `agy-consent.json` and re-enables blanket permissions. Reproduced using the implementation from `main`.

   **Fix:** Revert must detect and stop or migrate an older installed HUD before promising that background callers will respect revocation.

4. **P1 — Setup mistakes an existing read permission for consent to blanket access.**  
   [setup.ts:214](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.ts:214)

   **Scenario:** Existing CLI settings contain `{"permissions":{"defaultAction":"ask","allow":["read_file"]}}`, with no granted consent—or with explicitly revoked consent. `checkAgyPermissions()` returns true merely because `read_file` exists. Interactive `rh setup --hud` therefore skips disclosure and confirmation, then explicitly grants blanket access and records `"granted"`.

   **Fix:** Require recorded consent for this change. A minimal permission check must not substitute for consent, and `"revoked"` must force disclosure and confirmation.

5. **P1 — The installer does not provide its installed programs on the runtime PATH.**  
   [install-mac.sh:70](/Users/kushal/Desktop/project/remote-hands/scripts/install-mac.sh:70), [install-mac.sh:86](/Users/kushal/Desktop/project/remote-hands/scripts/install-mac.sh:86), [hud-service.ts:64](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/hud-service.ts:64)

   **Scenario:** A fresh Mac has only the standard system PATH. The private Node directory is added only for the npm invocation; writing shell startup files does not update the current installer process. Setup cannot find a newly installed `~/.local/bin/agy`. The first LaunchAgent also captures that original PATH, and its launcher omits `~/.remote-hands/bin`, so agent commands such as `rh approve` cannot be found. Even a new Terminal exposes the `rh` wrappers without exposing private `npx`, breaking `rh setup --remote`.

   **Fix:** Export the required PATH before setup, preserve it in launchers, and include the Remote Hands bin directory in the HUD environment.

6. **P1 — A full Xcode installation is incorrectly treated as missing developer tools.**  
   [xcode-tools.ts:35](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/xcode-tools.ts:35)

   **Scenario:** `xcode-select -p` returns `/Applications/Xcode.app/Contents/Developer`. Swift exists at `Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc`, but this check looks under `Developer/usr/bin/swiftc`. Setup starts an unnecessary installation and waits up to 30 minutes before failing. Installing CLT does not resolve this while full Xcode remains selected. Verified against this Mac’s actual directory layout.

   **Fix:** Resolve Swift through the active toolchain, or handle both CLT and full Xcode layouts. Add a full-Xcode test fixture.

7. **P2 — Node fallback can select an unsupported executable ahead of a supported one.**  
   [hud-service.ts:55](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/hud-service.ts:55)

   **Scenario:** The remembered nvm Node 22 path has been removed. `/opt/homebrew/bin/node` is executable but is Node 20, while another supported Node 22 exists under nvm. The launcher selects Node 20 and never reaches nvm; the CLI’s `node:sqlite` dependency cannot load.

   **Fix:** Check supported Node versions for every candidate and continue searching when a candidate is incompatible.

8. **P2 — The generated `rh-browser` launcher breaks alias dispatch.**  
   [install-mac.sh:149](/Users/kushal/Desktop/project/remote-hands/scripts/install-mac.sh:149)

   **Scenario:** After installation, `rh-browser tabs` invokes Node with `dist/index.js` as `process.argv[1]`. Alias dispatch in `index.ts` therefore sees `index.js`, not `rh-browser`, and treats `tabs` as a top-level command, returning “Unknown command: tabs.”

   **Fix:** Generate a dedicated wrapper that passes `browser` before the user’s arguments.

9. **P2 — Missing Screen Recording reports still produce “Desktop HUD is ready.”**  
   [setup.ts:758](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.ts:758)

   **Scenario:** The shortcut reports ready, but `hud-mac-status.json` is unwritable or never produces a final report. Verification returns `"unknown"`, which sets no readiness blocker. Setup prints both “has not reported its permissions yet” and “Desktop HUD is ready,” exiting zero. Reproduced in memory.

   The test named “does not claim ready when the service never reports” at [setup.test.ts:795](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.test.ts:795) only checks for the warning; it never checks that the ready message is absent.

   **Fix:** Carry `"unknown"` through the final readiness decision and add the missing negative assertion.

10. **P2 — Missing Screen Recording overrides a failed or unconfirmed shortcut with a success claim.**  
    [setup.ts:794](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.ts:794)

    **Scenario:** The background HUD reports `screenRecording: false`, and the helper reports `hotkey-failed`—or never confirms its shortcut. The `screenMissing` branch runs before the shortcut branches and prints “Shift + Cmd + Space works.” Reproduced with a failed shortcut.

    **Fix:** Construct the final message from both results; claim that the shortcut works only after a ready report.

11. **P2 — Full Disk Access becomes optional for remote setup too.**  
    [setup.ts:240](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.ts:240)

    **Scenario:** Run `rh setup --remote` or `rh setup --local` with Screen Recording and Accessibility granted but Full Disk Access denied. Both use `setupAgentAndPermissions()`, which now unconditionally passes `fullDiskAccessOptional: true`. Setup stops requesting the permission needed to avoid access prompts during unattended remote work.

    **Fix:** Pass the selected setup mode into this function and make Full Disk Access optional only for HUD setup. Test the actual remote setup path.

No additional defects found in the Swift event changes/generated-source synchronization, README/docs, or Homebrew formula. No additional Windows-specific regressions found; the shared consent and undo defects also affect Windows.