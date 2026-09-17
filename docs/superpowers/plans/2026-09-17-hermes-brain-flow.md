# Hermes Brain Cognitive Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a lightweight, zero-external-dependency Hermes Brain cognitive memory layer inside the Remote Hands daemon to eliminate agent amnesia, auto-resolve workspace directories, dynamically tune reasoning effort, and continuously learn across tasks.

**Architecture:** A native TypeScript `HermesBrain` module operates within `packages/daemon`, maintaining persistent machine memory at `~/.remote-hands/memory/MEMORY.md`. It resolves project workspace paths from natural language prompts before `agy` spawns, sets intent-based reasoning effort, and records completed task metadata asynchronously.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Zod, existing Remote Hands daemon package.

**Spec:** `docs/superpowers/specs/2026-09-17-hermes-brain-flow-design.md`

## Global Constraints
- Write clean code with no comments.
- Do not create walkthrough files.
- Zero external dependencies (no Python, no heavy local LLMs, no native SQLite binaries).
- Ensure no API calls or contracts are broken.
- Commit and push on each stage.

---

### Task 1: HermesBrain Memory Storage and Initializer

**Files:**
- Create: `packages/daemon/src/hermes-brain.ts`
- Test: `packages/daemon/src/hermes-brain.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface HermesProjectEntry {
    name: string;
    path: string;
    aliases: string[];
  }

  export interface HermesContext {
    resolvedWorkspacePath?: string;
    recommendedEffort: 'low' | 'medium' | 'high';
    augmentedPrompt: string;
  }

  export class HermesBrain {
    constructor(memoryDir?: string);
    getMemoryPath(): string;
    ensureInitialized(defaultProject?: HermesProjectEntry): Promise<string>;
    loadMemory(): Promise<string>;
    listProjects(): Promise<HermesProjectEntry[]>;
    recordTaskCompletion(params: { prompt: string; summary: string; workspacePath?: string; conversationId?: string | null }): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests for HermesBrain memory operations**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HermesBrain } from './hermes-brain.js';

describe('HermesBrain Memory Operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-brain-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes MEMORY.md with default structure and detects projects', async () => {
    const brain = new HermesBrain(tmpDir);
    const content = await brain.ensureInitialized({
      name: 'remote-hands',
      path: '/mock/path/remote-hands',
      aliases: ['remote hands', 'rh'],
    });

    expect(content).toContain('# Known Projects');
    expect(content).toContain('/mock/path/remote-hands');

    const projects = await brain.listProjects();
    expect(projects.length).toBeGreaterThan(0);
    expect(projects[0]?.name).toBe('remote-hands');
  });

  it('records task completion into MEMORY.md history', async () => {
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized();
    await brain.recordTaskCompletion({
      prompt: 'make header sticky',
      summary: 'Updated LiveTaskScreen.tsx with sticky styling',
      workspacePath: '/mock/path/remote-hands',
      conversationId: 'conv-123',
    });

    const content = await brain.loadMemory();
    expect(content).toContain('make header sticky');
    expect(content).toContain('conv-123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/hermes-brain.test.ts`
Expected: FAIL with module not found or class not implemented.

- [ ] **Step 3: Implement HermesBrain core storage and initialization**

Write `packages/daemon/src/hermes-brain.ts` without comments:
- Manage `memoryDir` (defaults to `~/.remote-hands/memory`).
- `ensureInitialized()` creates `MEMORY.md` with default machine info and project entry if missing.
- `listProjects()` parses Markdown sections for known projects and paths.
- `recordTaskCompletion()` appends recent activity entries cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/hermes-brain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit and push**

Run:
```bash
git add packages/daemon/src/hermes-brain.ts packages/daemon/src/hermes-brain.test.ts
git commit -m "feat(daemon): implement hermes brain persistent memory storage"
git push origin main
```

---

### Task 2: Workspace Resolution and Dynamic Effort Tuning

**Files:**
- Modify: `packages/daemon/src/hermes-brain.ts`
- Test: `packages/daemon/src/hermes-brain.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export class HermesBrain {
    // ... Task 1 methods
    resolveWorkspace(prompt: string): Promise<string | undefined>;
    determineEffort(prompt: string, currentEffort?: string | null): 'low' | 'medium' | 'high';
    prepareTaskContext(task: { prompt: string; workspace_path?: string | null; effort?: string | null }): Promise<HermesContext>;
  }
  ```

- [ ] **Step 1: Write the failing tests for workspace resolution and effort tuning**

Add to `packages/daemon/src/hermes-brain.test.ts`:
```typescript
  it('resolves workspace path from prompt referencing project name or alias', async () => {
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized({
      name: 'remote-hands',
      path: '/mock/path/remote-hands',
      aliases: ['remote hands', 'rh'],
    });

    const resolved1 = await brain.resolveWorkspace('Can you go to remote hands and fix the header?');
    expect(resolved1).toBe('/mock/path/remote-hands');

    const resolved2 = await brain.resolveWorkspace('in remote-hands update styles');
    expect(resolved2).toBe('/mock/path/remote-hands');

    const resolvedNone = await brain.resolveWorkspace('tell me a joke');
    expect(resolvedNone).toBeUndefined();
  });

  it('determines appropriate effort level based on task complexity', () => {
    const brain = new HermesBrain(tmpDir);
    expect(brain.determineEffort('make the header sticky')).toBe('medium');
    expect(brain.determineEffort('fix css padding bug')).toBe('medium');
    expect(brain.determineEffort('rearchitect the entire database and redesign control plane')).toBe('high');
    expect(brain.determineEffort('check git status')).toBe('low');
  });

  it('prepares task context with auto-resolved path and tuned effort', async () => {
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized({
      name: 'remote-hands',
      path: '/mock/path/remote-hands',
      aliases: ['remote hands'],
    });

    const ctx = await brain.prepareTaskContext({
      prompt: 'in remote hands make header sticky',
      workspace_path: null,
      effort: null,
    });

    expect(ctx.resolvedWorkspacePath).toBe('/mock/path/remote-hands');
    expect(ctx.recommendedEffort).toBe('medium');
    expect(ctx.augmentedPrompt).toContain('in remote hands make header sticky');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/hermes-brain.test.ts`
Expected: FAIL with `resolveWorkspace` / `determineEffort` / `prepareTaskContext` not implemented.

- [ ] **Step 3: Implement workspace matching and effort heuristics**

In `packages/daemon/src/hermes-brain.ts`:
- Implement `resolveWorkspace(prompt)` using normalized regex matching against known project names and aliases.
- Implement `determineEffort(prompt, currentEffort)`:
  - Return explicit `currentEffort` if provided.
  - Return `low` for quick checks (`git status`, `list`, `version`, `which`).
  - Return `medium` for targeted fixes (`css`, `style`, `header`, `color`, `typo`, `button`, `padding`, `margin`).
  - Return `high` for deep architectural or redesign prompts (`architect`, `redesign`, `refactor`, `migration`, `rewrite`).
- Implement `prepareTaskContext(task)` assembling resolved path, effort, and augmented prompt with concise memory hints.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/hermes-brain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit and push**

Run:
```bash
git add packages/daemon/src/hermes-brain.ts packages/daemon/src/hermes-brain.test.ts
git commit -m "feat(daemon): add workspace resolution and dynamic effort heuristics to hermes brain"
git push origin main
```

---

### Task 3: Integrate Hermes Brain into ProcessAgentRunner

**Files:**
- Modify: `packages/daemon/src/agy-runner.ts`
- Modify: `packages/daemon/src/agy-runner.test.ts`

**Interfaces:**
- Consumes:
  - `HermesBrain` from `./hermes-brain.js`
- Modifies:
  - `ProcessAgentRunner.run(task, onEvent, signal)` to use `hermesBrain.prepareTaskContext(task)` and `hermesBrain.recordTaskCompletion(...)`.

- [ ] **Step 1: Write failing integration test for auto-resolved workspace and effort in ProcessAgentRunner**

Add to `packages/daemon/src/agy-runner.test.ts`:
```typescript
  it('uses hermes brain to resolve workspace path and effort when omitted', async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hermes-test-'));
    const brain = new HermesBrain(memoryDir);
    await brain.ensureInitialized({
      name: 'test-repo',
      path: '/mock/workspace/test-repo',
      aliases: ['test-repo'],
    });

    const runner = new ProcessAgentRunner('echo', undefined, brain);
    const task: Task = {
      id: 'task-1',
      owner_id: 'user-1',
      machine_id: 'mach-1',
      prompt: 'in test-repo fix header',
      kind: 'browser',
      workspace_path: null,
      model: null,
      effort: null,
      mode: 'default',
      status: 'running',
      conversation_id: null,
      parent_task_id: null,
      result_summary: null,
      error: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
    };

    const res = await runner.run(task);
    expect(task.workspace_path).toBe('/mock/workspace/test-repo');
    expect(task.effort).toBe('medium');
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update ProcessAgentRunner to incorporate HermesBrain**

In `packages/daemon/src/agy-runner.ts`:
- Instantiate default `HermesBrain` in `ProcessAgentRunner` if not passed in constructor.
- In `run(task, onEvent, signal)`:
  - Await `hermesBrain.prepareTaskContext(task)`.
  - Apply `resolvedWorkspacePath` to `task.workspace_path` if previously empty.
  - Apply `recommendedEffort` to `task.effort` if previously empty.
  - On task completion, asynchronously invoke `hermesBrain.recordTaskCompletion(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit and push**

Run:
```bash
git add packages/daemon/src/agy-runner.ts packages/daemon/src/agy-runner.test.ts
git commit -m "feat(daemon): wire hermes brain into agy process runner"
git push origin main
```

---

### Task 4: Full Workspace Verification and Export Alignment

**Files:**
- Modify: `packages/daemon/src/index.ts`
- Run typecheck and full test suites

- [ ] **Step 1: Export HermesBrain in `packages/daemon/src/index.ts`**

Export `HermesBrain`, `HermesContext`, and `HermesProjectEntry` from `packages/daemon/src/index.ts`.

- [ ] **Step 2: Run workspace typecheck and tests**

Run:
```bash
npm run typecheck
npm test
npm run build
```
Expected: All packages pass with zero errors.

- [ ] **Step 3: Final commit and push**

Run:
```bash
git add packages/daemon/src/index.ts
git commit -m "chore(daemon): export hermes brain types and finalize integration"
git push origin main
```
