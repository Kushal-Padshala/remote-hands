# remote-hands — Hermes Brain Cognitive Flow Design

**Date:** 2026-09-17
**Status:** Approved for implementation
**Repository:** https://github.com/Kushal-Padshala/remote-hands

---

## 1. Summary

Remote Hands currently dispatches mobile tasks directly to the `agy` (Google Antigravity) CLI in non-interactive batch mode. Because incoming mobile tasks lack initial workspace paths and context, `agy` cold-starts with amnesia, spending multiple tool turns scanning disks and directories before writing code. Furthermore, `--effort high` is applied universally, causing significant reasoning latency on simple styling and bug fixes.

This specification introduces **Hermes Brain**: a native, zero-external-dependency cognitive layer in `packages/daemon`. Hermes Brain maintains persistent machine memory (`~/.remote-hands/memory/MEMORY.md`) mapping known repositories, directory paths, user habits, and accumulated skills. When a prompt arrives from mobile, Hermes Brain resolves the repository context, configures dynamic effort, and provides targeted cognitive guidance so `agy` executes immediately in the correct working directory without exploratory searching. After task execution, Hermes Brain updates its knowledge base asynchronously.

---

## 2. Goals & Non-Goals

### Goals
- **Eliminate Cold-Start Searches:** Instantly resolve project workspaces from natural language prompts using persistent memory.
- **Dynamic Effort Tuning:** Select appropriate reasoning effort (`low`, `medium`, or `high`) based on prompt intent rather than hardcoding `--effort high`.
- **Persistent Machine Memory:** Retain machine profiles, user preferences, known repositories, and reusable skill recipes in human-readable Markdown (`~/.remote-hands/memory/MEMORY.md`).
- **Zero Heavy Dependencies:** Implemented in pure TypeScript (Node 22) within `packages/daemon`. No Python, no heavy local LLMs, and no native SQLite binaries required.
- **Strict Backward Compatibility:** Preserves all existing `AgentRunner` interfaces, WebSocket streaming contracts, and cloud control-plane endpoints.

### Non-Goals
- Replacing `agy` as the execution engine (Hermes acts as the cognitive brain; `agy` acts as the execution hands).
- Running an external multi-gigabyte local neural network on the user's workstation.

---

## 3. Architecture & Data Flow

```
Mobile Phone (Remote Hands UI / Voice)
       │
       ▼ (Task dispatched via WebSocket)
Remote Hands Daemon (`packages/daemon/src/daemon.ts`)
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Hermes Brain (`packages/daemon/src/hermes-brain.ts`)       │
│  1. Reads `~/.remote-hands/memory/MEMORY.md`                │
│  2. Resolves target workspace path if omitted               │
│  3. Analyzes intent to tune reasoning effort                │
│  4. Synthesizes high-signal prompt with active context      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  agy Process Runner (`packages/daemon/src/agy-runner.ts`)   │
│  • Spawns directly in target workspace `cwd`                │
│  • Executes immediately with zero search overhead           │
│  • Streams events, frames, and approvals in real time       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ (Task completion)
┌─────────────────────────────────────────────────────────────┐
│  Hermes Memory Synthesizer                                  │
│  • Extracts touched projects, paths, and patterns           │
│  • Updates `MEMORY.md` asynchronously                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Component Design

### 4.1 Memory Storage (`~/.remote-hands/memory/`)

1. **`MEMORY.md`**:
   Structured Markdown containing:
   - **`# User & Machine Profile`**: OS, default shell, user preference flags (e.g. clean code, zero comments, decisive execution).
   - **`# Known Projects & Workspaces`**: Table or list mapping project names/aliases (e.g., `remote-hands`, `remote hands`) to absolute directory paths (e.g., `/Users/kushal/Desktop/project/remote-hands`), package layouts, and run commands.
   - **`# Recent Activity`**: Recently accessed paths and task summaries.

2. **Default Initialization**:
   If `~/.remote-hands/memory/MEMORY.md` does not exist, Hermes Brain automatically initializes it with detected system metadata and the current repository path.

### 4.2 HermesBrain Class (`packages/daemon/src/hermes-brain.ts`)

```typescript
export interface HermesContext {
  resolvedWorkspacePath?: string;
  recommendedEffort: 'low' | 'medium' | 'high';
  augmentedPrompt: string;
}

export interface HermesProjectEntry {
  name: string;
  path: string;
  aliases: string[];
}

export class HermesBrain {
  constructor(private memoryDir?: string);
  
  loadMemory(): Promise<string>;
  resolveWorkspace(prompt: string): Promise<string | undefined>;
  determineEffort(prompt: string, currentEffort?: string | null): 'low' | 'medium' | 'high';
  prepareTaskContext(task: Task): Promise<HermesContext>;
  recordTaskCompletion(task: Task, summary: string, conversationId?: string | null): Promise<void>;
}
```

### 4.3 Integration into `ProcessAgentRunner`

In `packages/daemon/src/agy-runner.ts`:
1. `ProcessAgentRunner.run(task, onEvent, signal)` invokes `hermesBrain.prepareTaskContext(task)` before building arguments.
2. If `task.workspace_path` was not provided, the resolved path from Hermes Brain is applied to `task.workspace_path` so the process spawns directly in the target directory.
3. The prompt is augmented with known project context and active user preferences.
4. If effort was not explicitly overridden by the caller, `recommendedEffort` is supplied to `buildAgyArgs`.
5. Upon task completion, `hermesBrain.recordTaskCompletion` updates `MEMORY.md` asynchronously.

---

## 5. Verification Plan

1. **Unit Testing (`packages/daemon/src/hermes-brain.test.ts`)**:
   - Memory initialization and schema parsing.
   - Project path resolution from varied natural language prompts (e.g., "go to remote hands directory", "in remote hands", etc.).
   - Dynamic effort classification (styling/header/fix -> `low`/`medium`, architectural redesign -> `high`).
   - Task completion record updates to `MEMORY.md`.
2. **Daemon Integration Testing (`packages/daemon/src/agy-runner.test.ts`)**:
   - Verify `ProcessAgentRunner` auto-resolves workspace paths and effort levels.
   - Verify existing event streaming and process abort signals remain fully functional.
3. **Full Workspace Build & Test**:
   - `npm run typecheck` across all workspace packages.
   - `npm test` verifying all test suites pass with zero failures.
