# Multi Browser Profile Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to target any Google Chrome profile (by profile name, email, or folder ID) for browser automation via CLI flags and automatic discovery.

**Architecture:**
1. Extend `ChromeManager` in `packages/daemon/src/chrome-manager.ts` to inspect Chrome's `Local State` file (`~/Library/Application Support/Google/Chrome/Local State` on macOS, standard paths on Linux/Windows), parse the profile cache, and resolve human-friendly profile names (e.g. `kushal`, `FLCC`), Google emails, or profile folder IDs (e.g. `Profile 11`, `Default`).
2. When launching Chrome in `buildLaunchArgs`, automatically append `--profile-directory=<resolved-folder>` whenever a specific profile is configured.
3. Add a new `rh profiles` command to `packages/cli` that lists all detected Chrome profiles, their associated email accounts, folder IDs, and active debugging status.
4. Support `--browser-profile=<name|email|id|active|dedicated|none>` across `rh start`, `rh daemon`, and `rh doctor`.

**Tech Stack:**
- TypeScript, Node.js (`fs`, `path`, `os`, `child_process`)
- Vitest for testing
- Esbuild for CLI bundle

**Spec:** Multi-profile browser automation targeting specific Chrome profiles.

## Global Constraints
- Write clean code with NO comments.
- Do NOT create walkthrough files or documentation.
- Maintain documentation integrity: preserve existing comments and docstrings in untouched code.
- Ensure all tests pass and no API calls are broken.

---

### Task 1: Profile Discovery and Directory Resolution in ChromeManager

**Files:**
- Modify: `packages/daemon/src/chrome-manager.ts`
- Test: `packages/daemon/src/chrome-manager.test.ts`
- Export: `packages/daemon/src/index.ts`

**Interfaces:**
- `export interface ChromeProfileInfo { id: string; name: string; email?: string | undefined; directory: string; isDefault?: boolean | undefined; }`
- `ChromeManager.listProfiles(userDataDir?: string): ChromeProfileInfo[]`
- `ChromeManagerOptions.profile?: string | undefined`
- `ChromeStatus.profileName?: string | undefined; ChromeStatus.profileDirectory?: string | undefined;`
- `buildLaunchArgs(url?: string): string[]` includes `--profile-directory=<dir>` when resolved.

- [ ] **Step 1: Write failing unit tests for profile listing and resolution**

In `packages/daemon/src/chrome-manager.test.ts`, add test cases for:
1. `listProfiles()` reading simulated Chrome `Local State` JSON file and returning structured `ChromeProfileInfo` list.
2. Resolving profile by human-readable name (e.g. `"kushal"` -> folder `"Profile 4"`).
3. Resolving profile by email (e.g. `"kushalp5454@gmail.com"` -> folder `"Profile 4"`).
4. Resolving profile by folder name (e.g. `"Profile 11"` -> folder `"Profile 11"`).
5. `buildLaunchArgs()` appending `--profile-directory=Profile 4`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/chrome-manager.test.ts`
Expected: FAIL due to missing methods/options.

- [ ] **Step 3: Implement profile discovery and resolution in `chrome-manager.ts`**

Implement:
1. `ChromeProfileInfo` interface.
2. `ChromeManager.getDefaultUserDataDir(): string` supporting macOS, Linux, and Windows.
3. `ChromeManager.listProfiles(userDataDir?: string): ChromeProfileInfo[]` that safely reads `Local State` and parses `profile.info_cache`.
4. Profile resolution logic in `constructor` or helper method matching against `id`, `name` (case-insensitive), or `email` (case-insensitive).
5. Add `--profile-directory` to `buildLaunchArgs()`.
6. Populate `profileName` and `profileDirectory` in `checkDebuggerStatus()`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run packages/daemon/src/chrome-manager.test.ts`
Expected: PASS with 100% success.

- [ ] **Step 5: Commit changes**

```bash
git add packages/daemon/src/chrome-manager.ts packages/daemon/src/chrome-manager.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): add chrome profile discovery and directory resolution"
```

---

### Task 2: Multi-Profile CLI Integration and `rh profiles` Command

**Files:**
- Create: `packages/cli/src/commands/profiles.ts`
- Modify: `packages/cli/src/commands/daemon.ts`
- Modify: `packages/cli/src/commands/start.ts`
- Modify: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/cli.test.ts`

**Interfaces:**
- `export async function profilesCommand(args: string[], context?: CommandContext): Promise<number>`
- CLI `--browser-profile=<name|email|id|active|dedicated|none>` parsed and passed to `ChromeManager`.
- `rh profiles` registered in `main()` dispatcher and help text.

- [ ] **Step 1: Write failing CLI tests for `rh profiles` and custom profile flag**

In `packages/cli/src/cli.test.ts`:
1. Test that `rh profiles` outputs discovered profiles and exits with code 0.
2. Test that `rh start --browser-profile=FLCC` passes the profile to `ChromeManager`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/cli.test.ts`
Expected: FAIL because `profiles` command is not implemented.

- [ ] **Step 3: Create `packages/cli/src/commands/profiles.ts`**

Implement:
1. `profilesCommand`: instantiate `ChromeManager`, invoke `ChromeManager.listProfiles()`, check debugger status.
2. Format output cleanly showing detected profiles with their names, accounts, folder directories, and helpful commands to launch them.

- [ ] **Step 4: Update `packages/cli/src/commands/daemon.ts` and `start.ts`**

Update:
1. Parse `--browser-profile=<value>`.
2. If value is `'dedicated'`, `'none'`, or `'active'`, pass as `mode`.
3. If value is any other string, pass `mode: 'active'` and `profile: value`.
4. Pass configuration to `ChromeManager`.

- [ ] **Step 5: Update `packages/cli/src/commands/doctor.ts`**

Display detected Chrome profiles count and names in `doctorCommand`.

- [ ] **Step 6: Register `profiles` in `packages/cli/src/index.ts`**

Export `profilesCommand` and route `profiles` subcommand in `main()`.

- [ ] **Step 7: Run CLI tests and verify they pass**

Run: `npx vitest run packages/cli/src/cli.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit changes**

```bash
git add packages/cli/src/commands/profiles.ts packages/cli/src/commands/daemon.ts packages/cli/src/commands/start.ts packages/cli/src/commands/doctor.ts packages/cli/src/index.ts packages/cli/src/cli.test.ts
git commit -m "feat(cli): add rh profiles command and multi-profile flag support"
```

---

### Task 3: Build, Full Monorepo Test Suite, and Verification

**Files:**
- Test all packages
- Build all packages

- [ ] **Step 1: Rebuild daemon dist**

Run: `npm --prefix packages/daemon run build`

- [ ] **Step 2: Build full monorepo**

Run: `pnpm build`
Expected: Build succeeds with 0 errors.

- [ ] **Step 3: Run all monorepo tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Run manual sanity check using CLI**

Run: `node packages/cli/dist/index.js profiles`
Expected: Lists all 7 detected Chrome profiles with their names and emails.

- [ ] **Step 5: Commit any remaining build or alignment changes**

```bash
git commit --allow-empty -m "chore: verify multi-profile chrome automation build and tests"
git push origin main
```
