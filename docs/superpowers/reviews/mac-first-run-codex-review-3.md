Code-checked review-2 findings:

| # | Status | Reason |
|---|---|---|
| 1 | **FIXED** | `status` and `check` no longer call the grant function. |
| 2 | **PARTLY** | Live locks still expire after ten minutes; checking the token before renaming is not atomic. |
| 3 | **PARTLY** | MCP rule edits are locked, but the external `agy mcp add/remove` settings writes remain outside the lock. |
| 4 | **PARTLY** | Nonempty damaged records fail closed; empty consent and undo files still count as absent. |
| 5 | **PARTLY** | macOS shutdown is checked, but uninstall can succeed with its plist retained; Windows shutdown remains unchecked. |
| 6 | **FIXED** | Failed takeover exits, and immediate takeover retries are bounded. |
| 7 | **PARTLY** | Setup handles reported failures, but successful writes to other settings files can conceal failure of the CLI settings write. |
| 8 | **FIXED** | Grant persistence must succeed before settings writes begin. |
| 9 | **FIXED** | `--local` now requires FDA. |
| 10 | **FIXED** | Bash uses its first existing login profile, or creates `.bash_profile` when necessary. |

Additional defects, most severe first:

1. **P1 — An older HUD can overwrite restoration before being stopped.** [permissions.ts:64](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/permissions.ts:64)  
   With an old copied CLI running and valid undo metadata, revert restores restrictive settings and clears the manifest. Before uninstall at line 80, the old HUD finishes its unprotected settings write. Revert exits zero with permissive settings and no undo record. **Fix:** Stop and verify the older HUD before restoring settings.

2. **P1 — Non-setup grants can race past revocation.** [hud.ts:52](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/hud.ts:52), [permissions.ts:92](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/permissions.ts:92)  
   An install/fix reads `granted`; revert then completes before that command acquires the lock. Its `{ explicit: true }` call bypasses the revoked check, re-grants permissions, and can reinstall the HUD. **Fix:** Check revocation inside the lock; reserve overriding revocation for setup after confirmation.

3. **P1 — Uninstall can succeed while preserving automatic startup.** [hud-service.ts:367](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/hud-service.ts:367)  
   With an older HUD installed, `unload -w` fails, plist deletion throws `EACCES`, and `launchctl remove` succeeds. `uninstall()` returns true although the plist remains; next login starts the old CLI and re-grants permissions. **Fix:** Require both startup-file removal and job shutdown before returning success.

4. **P2 — Commands ignore failed permission configuration.** [permissions.ts:97](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/permissions.ts:97), [hud.ts:58](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/hud.ts:58)  
   An upgraded user has no consent file, legacy permissive settings, and all OS permissions. If lock acquisition times out, `permissions fix` still reports readiness and exits zero; `hud install` likewise continues and can exit zero. **Fix:** Check `ensureAgyPermissions()` and propagate failure.

5. **P2 — An ancillary settings write masks failure of the required CLI write.** [agy-permissions.ts:656](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:656)  
   CLI settings remain `defaultAction: "ask"` because their write fails, while writable `~/.gemini/settings.json` succeeds. `anySucceeded` returns true, allowing setup to claim readiness. **Fix:** Require the CLI settings write to succeed and report other failed targets.

6. **P2 — Failed consent persistence leaves undo entries for changes never made.** [agy-permissions.ts:627](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/system/agy-permissions.ts:627)  
   Starting from `defaultAction: "ask"` and no undo record, consent replacement fails—for example, an immutable consent file. Settings remain untouched, but the new undo manifest survives. The user subsequently sets `deny`; after repairing consent storage, revert changes it back to `ask`. **Fix:** Restore the previous manifest when grant persistence fails.

7. **P2 — Failed MCP registration still permits Mac setup readiness.** [setup.ts:711](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/setup.ts:711)  
   On macOS, `agy mcp add` fails and `rh-computer` remains unregistered. Successful HUD permission and shortcut reports still produce “Desktop HUD is ready” and exit zero because only Windows receives the blocker. **Fix:** Block readiness on MCP registration failure on macOS too.