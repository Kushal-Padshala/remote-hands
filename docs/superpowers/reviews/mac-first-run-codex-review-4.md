| # | Status | Code-checked reason |
|---|---|---|
| 1 | FIXED | Revert stops the installed HUD before restoration; shutdown failure exits 1. |
| 2 | FIXED | Revocation is checked under the lock; only setup passes `overrideRevoked`. |
| 3 | FIXED | macOS uninstall requires both plist removal and job shutdown. |
| 4 | FIXED | `permissions fix` and `hud install` now exit 1 when configuration fails. |
| 5 | FIXED | Success requires the primary CLI settings write; its adapter creates missing directories. |
| 6 | PARTLY | Manifest rollback is attempted, but swallowed rollback failures still leave phantom undo entries. |
| 7 | FIXED | MCP registration failure now blocks macOS readiness and returns 1. |

One new regression: **P2 — `rh hud uninstall` misreports failed removal.** The new retained-plist failure returns `false` at [hud-service.ts:368](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/desktop/hud-service.ts:368), but [hud.ts:100](/Users/kushal/Desktop/project/remote-hands/packages/cli/src/commands/hud.ts:100) prints “No active Desktop Overlay service found to remove” and exits **0**. Reproduced in memory with plist deletion failing; automatic startup remains configured.