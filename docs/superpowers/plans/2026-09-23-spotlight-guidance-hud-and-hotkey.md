# Spotlight Guidance HUD & Global Hotkey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native macOS Spotlight-style floating prompt HUD triggered via `Shift + Cmd + Space` or CLI that inspects the active app (e.g., Photoshop, Chrome, Finder), resolves how to accomplish the user's goal, and projects step-by-step visual arrows and badges directly over the target buttons.

**Architecture:** A compiled native Swift/AppKit frosted-glass floating HUD panel with global hotkey support (`rh-spotlight`), coupled with an AST/AX element intent resolver (`intent-resolver.ts`) that maps queries to UI menu and button paths (falling back to AGY/Hermes when complex), orchestrated by `hud-coordinator.ts` and surfaced via `rh guide prompt` and `rh guide listen`.

**Tech Stack:** Swift 6 / AppKit / CoreAnimation, TypeScript, Node.js child_process, Vitest.

**Spec:** docs/superpowers/specs/2026-09-23-unified-hybrid-guidance-and-annotation-overlay-design.md

## Global Constraints
- Target macOS Darwin (ARM64/x64)
- Clean code, NO comments in source code, strict TypeScript, no broken APIs
- Hotkey: `Shift + Command + Space`
- High-performance, zero-latency floating panel (<50ms display time)

---

### Task 1: Native macOS Spotlight HUD Swift Executable & Runner

**Files:**
- Create: `packages/daemon/src/desktop/spotlight-hud.swift`
- Create: `packages/daemon/src/desktop/spotlight-hud.ts`
- Test: `packages/daemon/src/desktop/spotlight-hud.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SpotlightPromptResult {
    query: string;
    app: string;
  }
  export class SpotlightHudRunner {
    constructor(execFunc?: ExecFunction);
    openPrompt(activeApp?: string): Promise<SpotlightPromptResult | null>;
    startListener(onTrigger: (app: string) => void): { stop: () => void };
  }
  ```

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write minimal implementation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit and push**

---

### Task 2: Desktop Guidance Intent Resolver

**Files:**
- Create: `packages/daemon/src/guidance/intent-resolver.ts`
- Test: `packages/daemon/src/guidance/intent-resolver.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface IntentResolutionResult {
    steps: GuideStep[];
    confidence: number;
    source: 'exact_menu' | 'ax_element' | 'heuristic' | 'agent';
  }
  export class IntentResolver {
    constructor(axWalker?: AxWalker);
    resolve(query: string, activeApp: string): Promise<IntentResolutionResult>;
  }
  ```

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write minimal implementation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit and push**

---

### Task 3: Guidance HUD Coordinator

**Files:**
- Create: `packages/daemon/src/guidance/hud-coordinator.ts`
- Test: `packages/daemon/src/guidance/hud-coordinator.test.ts`

**Interfaces:**
- Consumes: `SpotlightHudRunner`, `IntentResolver`, `GuidanceManager`
- Produces:
  ```ts
  export class HudCoordinator {
    constructor(
      hudRunner?: SpotlightHudRunner,
      intentResolver?: IntentResolver,
      guidanceManager?: GuidanceManager
    );
    triggerPrompt(appOverride?: string): Promise<boolean>;
    startListening(): { stop: () => void };
  }
  ```

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write minimal implementation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit and push**

---

### Task 4: CLI Command Suite (`rh guide prompt` & `rh guide listen`)

**Files:**
- Modify: `packages/cli/src/commands/guide.ts`
- Modify: `packages/cli/src/commands/guide.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- CLI additions:
  - `rh guide prompt [--app="<app>"]`
  - `rh guide listen`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write minimal implementation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit and push**
