# At-Mention Context Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-level `@-mention` context tagging system across the macOS Spotlight HUD overlay (`Shift + Cmd + Space`) and Web/Mobile PWA to attach specific browser tabs (Chrome, Arc, Brave, Safari, Edge), profiles, app windows, and local files directly to agent tasks with zero discovery latency.

**Architecture:** A centralized `ContextService` in daemon queries running apps, browser tabs (CDP + AppleScript/JXA), and local files. Surfaced via CLI `rh context list --json` and daemon HTTP route. Frontend popovers (Swift AppKit and React) provide 3-level drill-down menus (Apps -> Profiles -> Tabs) with multi-select checkboxes and interactive removable chips. Attachments are injected into task prompts as high-priority execution targets.

**Tech Stack:** TypeScript, Node.js, Swift (AppKit), React, Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-at-mention-context-tagging-design.md`

## Global Constraints
- Clean code with NO comments in any source files.
- All tests must pass cleanly with `pnpm test`.
- No broken API calls or regressions in existing tests.

---

### Task 1: Shared Domain Models & Types

**Files:**
- Create: `packages/shared/src/context-attachment.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/context-attachment.test.ts`

**Interfaces:**
- Produces: `ContextAttachment`, `BrowserTabAttachment`, `AppWindowAttachment`, `LocalFileAttachment`, `ContextHierarchy`, `ContextBrowserTarget`, `ContextAppTarget`, `ContextFileTarget`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import type {
  BrowserTabAttachment,
  ContextAttachment,
  ContextHierarchy,
  Task,
} from './index.js';

describe('Context Attachment Types', () => {
  it('validates attachment interfaces and task attachment property', () => {
    const tab: BrowserTabAttachment = {
      type: 'browser_tab',
      id: 'tab-1',
      browser: 'chrome',
      profile: 'Personal',
      title: 'Property Details',
      url: 'https://example.com/prop/101',
      tabIndex: 2,
    };

    const task: Task = {
      id: 'task-test-1',
      prompt: 'Check property details',
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      attachments: [tab],
    };

    const hierarchy: ContextHierarchy = {
      browsers: [
        {
          id: 'chrome',
          name: 'Google Chrome',
          profiles: [
            {
              id: 'Default',
              name: 'Personal',
              tabs: [{ id: 'tab-1', title: 'Property Details', url: 'https://example.com/prop/101' }],
            },
          ],
        },
      ],
      apps: [],
      files: [],
    };

    expect(task.attachments?.length).toBe(1);
    expect(task.attachments?.[0].type).toBe('browser_tab');
    expect(hierarchy.browsers[0].profiles[0].tabs.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/context-attachment.test.ts`
Expected: FAIL with missing exports.

- [ ] **Step 3: Implement minimal code**

In `packages/shared/src/context-attachment.ts`:
```typescript
export type ContextAttachmentType = 'browser_tab' | 'app_window' | 'local_file';

export interface BrowserTabAttachment {
  type: 'browser_tab';
  id: string;
  browser: string;
  profile?: string | undefined;
  title: string;
  url: string;
  tabIndex?: number | undefined;
}

export interface AppWindowAttachment {
  type: 'app_window';
  id: string;
  app: string;
  title?: string | undefined;
  windowId?: number | string | undefined;
}

export interface LocalFileAttachment {
  type: 'local_file';
  id: string;
  path: string;
  name: string;
  sizeBytes?: number | undefined;
  isDir?: boolean | undefined;
}

export type ContextAttachment = BrowserTabAttachment | AppWindowAttachment | LocalFileAttachment;

export interface ContextBrowserProfile {
  id: string;
  name: string;
  tabs: Array<{
    id: string;
    title: string;
    url: string;
    tabIndex?: number | undefined;
  }>;
}

export interface ContextBrowserTarget {
  id: string;
  name: string;
  profiles: ContextBrowserProfile[];
}

export interface ContextAppTarget {
  id: string;
  name: string;
  windows: Array<{
    id: string;
    title: string;
  }>;
}

export interface ContextFileTarget {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
}

export interface ContextHierarchy {
  browsers: ContextBrowserTarget[];
  apps: ContextAppTarget[];
  files: ContextFileTarget[];
}
```

Update `packages/shared/src/api.ts` to include `attachments?: ContextAttachment[] | undefined;` in `Task`.
Update `packages/shared/src/index.ts` to export `* from './context-attachment.js';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/context-attachment.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): add context attachment domain models and task attachments"
```

---

### Task 2: Daemon Context Discovery Service

**Files:**
- Create: `packages/daemon/src/context/context-service.ts`
- Test: `packages/daemon/src/context/context-service.test.ts`

**Interfaces:**
- Consumes: `ContextHierarchy`, `BrowserTabAttachment`, `ContextBrowserTarget` from `@remote-hands/shared`
- Produces: `ContextService.prototype.getHierarchy()`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { ContextService } from './context-service.js';

describe('ContextService', () => {
  it('discovers running apps, browser tabs, and files with hierarchy', async () => {
    const service = new ContextService({
      chromeTabProvider: async () => [
        { id: 'c1', title: 'Google Search', url: 'https://google.com', profile: 'Personal', tabIndex: 0 },
      ],
      appleScriptRunner: async (script) => {
        if (script.includes('Arc')) {
          return 'Arc Tab 1|https://arc.net\nArc Tab 2|https://github.com';
        }
        return '';
      },
      runningAppProvider: async () => [
        { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
        { name: 'Arc', bundleId: 'company.thebrowser.Browser' },
        { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' },
      ],
      fileProvider: async () => [
        { name: 'banner.png', path: '/mock/banner.png', isDir: false },
      ],
    });

    const hierarchy = await service.getHierarchy();
    expect(hierarchy.browsers.length).toBeGreaterThanOrEqual(2);
    const chrome = hierarchy.browsers.find((b) => b.id === 'chrome');
    expect(chrome).toBeDefined();
    expect(chrome?.profiles[0].tabs[0].title).toBe('Google Search');

    const arc = hierarchy.browsers.find((b) => b.id === 'arc');
    expect(arc).toBeDefined();
    expect(arc?.profiles[0].tabs.length).toBe(2);

    expect(hierarchy.apps.some((a) => a.name === 'Visual Studio Code')).toBe(true);
    expect(hierarchy.files.some((f) => f.name === 'banner.png')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/context/context-service.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement ContextService**

In `packages/daemon/src/context/context-service.ts`:
Implement `ContextService` querying Chrome tabs via CDP or fallback mock provider, Arc/Brave/Safari tabs via `osascript`, running GUI apps, and local files in `~/Downloads`, `~/Desktop`, and current directory.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/context/context-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/context/
git commit -m "feat(daemon): implement context discovery service for browsers apps and files"
```

---

### Task 3: CLI Context Command & Daemon HTTP Route

**Files:**
- Create: `packages/cli/src/commands/context.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/daemon/src/daemon-server.ts` (or daemon API routes)
- Test: `packages/cli/src/commands/context.test.ts`

**Interfaces:**
- Produces: `rh context list [--json]`, `GET /api/context/targets`

- [ ] **Step 1: Write the failing test**

In `packages/cli/src/commands/context.test.ts`:
Verify `rh context list --json` outputs formatted JSON containing `browsers`, `apps`, and `files`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/commands/context.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement context command & route**

Wire `ContextService` into `packages/cli/src/commands/context.ts` and dispatch in `packages/cli/src/cli.ts`.
Expose `GET /api/context/targets` on the daemon server returning `ContextHierarchy`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/commands/context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/ packages/daemon/
git commit -m "feat(cli): add rh context list command and daemon context endpoint"
```

---

### Task 4: Prompt Context Injection in HudCoordinator & HermesBrain

**Files:**
- Modify: `packages/daemon/src/guidance/hud-coordinator.ts`
- Modify: `packages/daemon/src/hermes-brain.ts`
- Test: `packages/daemon/src/guidance/hud-coordinator.test.ts`
- Test: `packages/daemon/src/hermes-brain.test.ts`

**Interfaces:**
- Consumes: `task.attachments`
- Produces: Augmented prompt with `[Active User Attachments: ...]` and direct target instructions.

- [ ] **Step 1: Write the failing test**

In `packages/daemon/src/guidance/hud-coordinator.test.ts`:
Assert that `formatContextualTaskPrompt(query, context, attachments)` includes pre-attached browser tab URLs, titles, and local files in the prompt execution mandate.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/guidance/hud-coordinator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement prompt formatting**

Update `formatContextualTaskPrompt` and `HermesBrain.prepareTaskContext` to check `task.attachments` and inject the explicit targeting block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/guidance/hud-coordinator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/
git commit -m "feat(daemon): inject user context attachments into task prompt and hermes brain"
```

---

### Task 5: Web / Mobile PWA @-Mention Dropdown & Context Chips

**Files:**
- Create: `apps/web/src/components/AtMentionDropdown.tsx`
- Create: `apps/web/src/components/AttachmentChips.tsx`
- Modify: `apps/web/src/screens/NewTaskScreen.tsx`
- Modify: `apps/web/src/screens/LiveTaskScreen.tsx`
- Test: `apps/web/src/components/AtMentionDropdown.test.tsx`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces: Interactive `@` dropdown with 3-tier navigation (Category -> Profiles -> Tabs) and multi-select checkboxes.
- Produces: Removable attachment pill chips rendered above text input.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/AtMentionDropdown.test.tsx`:
Test that typing `@` renders the category list, selecting Chrome expands profiles and tabs, checking 2 tabs and clicking Done invokes `onSelectAttachments` with the tab objects.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/components/AtMentionDropdown.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement AtMentionDropdown & AttachmentChips**

Build React components in `apps/web/src/components/AtMentionDropdown.tsx` and `AttachmentChips.tsx`.
Wire into `NewTaskScreen.tsx` and `LiveTaskScreen.tsx`. Pass attachments to `createTask`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/src/components/AtMentionDropdown.test.tsx apps/web/src/App.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/
git commit -m "feat(web): add at-mention dropdown and context attachment chips in prompt bar"
```

---

### Task 6: Native macOS Spotlight HUD Swift Popover & Token Field

**Files:**
- Modify: `packages/daemon/src/desktop/spotlight-hud.swift`
- Test: `packages/daemon/src/desktop/spotlight-hud.test.ts`

**Interfaces:**
- Produces: Swift HUD popover menu on `@` keypress, multi-selection of tabs/apps, and outputting attachments JSON payload on submit.

- [ ] **Step 1: Write the test**

In `packages/daemon/src/desktop/spotlight-hud.test.ts`:
Verify that `rh-spotlight` accepts context hierarchy and emits `attachments` in the task JSON output.

- [ ] **Step 2: Update Swift implementation**

Add `NSTextFieldDelegate` / `@` detector in `spotlight-hud.swift`, populating an AppKit table popover with running tabs and apps, and appending token chips.

- [ ] **Step 3: Compile Swift binary and test**

Run: `swiftc -O packages/daemon/src/desktop/spotlight-hud.swift -o packages/daemon/bin/rh-spotlight`
Verify clean compilation.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/desktop/ packages/daemon/bin/
git commit -m "feat(hud): support at-mention context dropdown and attachment chips in native spotlight"
```

---

### Task 7: Full Monorepo Build & Verification

**Files:**
- All packages and apps

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: 100% pass across all test files.

- [ ] **Step 2: Run full build**

Run: `pnpm build`
Expected: Clean build without TypeScript or bundling errors.

- [ ] **Step 3: Push changes**

```bash
git push origin main
```
