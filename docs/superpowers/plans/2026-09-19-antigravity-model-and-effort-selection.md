# Antigravity Model & Reasoning Effort Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seamless UI support in Remote Hands for choosing the Antigravity AI model and reasoning effort (High, Medium, Low) on both web and mobile, preserving choices across sessions, ensuring daemon compatibility without broken CLI flags, publishing the updated CLI package to npm, and deploying the web frontend to Cloudflare.

**Architecture:**
- **Shared & Daemon:** In `@remote-hands/daemon` (`packages/daemon/src/agy-runner.ts`), enhance argument construction so `--effort` is only passed when valid (e.g. not passed for models that disallow `--effort` such as Claude Sonnet / Opus, and formatted appropriately).
- **Web Frontend:** In `apps/web/src/screens/NewTaskScreen.tsx`, introduce model selection (Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B) and an effort segmented control (`high`, `medium`, `low`). In `apps/web/src/screens/LiveTaskScreen.tsx`, introduce a quick model and effort switcher in the composer toolbar for follow-up turns, replacing hardcoded strings. Persist preferences in `localStorage` (`rh_model`, `rh_effort`).
- **Styling:** In `apps/web/src/styles.css`, implement polished UI components matching the existing dark minimalist theme, with responsive mobile-friendly touch targets (min 44px) and clear active states.
- **Publish & Deploy:** Bump `remote-hands-cli` version in `packages/cli/package.json`, build and publish to npm, and deploy `remote-hands-web` to Cloudflare with `wrangler deploy`.

**Global Constraints:**
- Clean code: NO code comments (no `//` and no `/* */`).
- All existing features, tests, and API contracts must continue working. No broken API calls.
- Don't create walkthrough.
- Target zero regression on all workspace tests.

---

### Task 1: Daemon Agy Runner Model and Effort Flag Handling

**Files:**
- Modify: `packages/daemon/src/agy-runner.ts`
- Modify: `packages/daemon/src/agy-runner.test.ts`

**Interfaces:**
- Consumes: `Task.model`, `Task.effort`
- Produces: `buildAgyArgs(task: Task, config: AgyArgConfig): readonly string[]`

- [ ] **Step 1: Write failing unit test for agy-runner model and effort handling**

Update `packages/daemon/src/agy-runner.test.ts` to verify:
1. When `task.model` is `'claude-sonnet-4-6'` and `task.effort` is `'low'` or `'high'`, `--effort` is NOT passed to `agy` because Claude models reject `--effort`.
2. When `task.model` is `'gemini-3.8-flash'` and `task.effort` is `'medium'`, `--model gemini-3.8-flash --effort medium` are passed.
3. When `task.model` is `null`, it falls back to `'gemini-3.8-flash-high'`.
4. When `task.effort` is `null` on a model that supports effort, it defaults to `'low'`.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`

- [ ] **Step 3: Implement smart model and effort handling in buildAgyArgs**

In `packages/daemon/src/agy-runner.ts`, update `buildAgyArgs` to check whether the model supports effort (models containing `claude` do not support `--effort`) and omit `--effort` when unsupported. Ensure NO comments are added.

- [ ] **Step 4: Verify test passes**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`

---

### Task 2: Web UI Model and Effort Selection (NewTaskScreen, LiveTaskScreen, App.tsx, styles.css)

**Files:**
- Modify: `apps/web/src/screens/NewTaskScreen.tsx`
- Modify: `apps/web/src/screens/LiveTaskScreen.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- `NewTaskScreenProps.onCreateTask: (prompt: string, kind: TaskKind, mode: TaskMode, model?: string, effort?: string) => Promise<void>`
- `apiClient.createTask: (payload: CreateTaskRequest) => Promise<TaskRow>`
- Supported models constant list with labels, provider icons/tags, and effort compatibility.

- [ ] **Step 1: Write tests for Model and Effort Selection in App.test.tsx**

Add test cases in `apps/web/src/App.test.tsx`:
1. Verifies that `NewTaskScreen` renders the Model selector and High / Medium / Low effort controls.
2. Verifies selecting a model and effort level passes the selected values to `createTask`.
3. Verifies localStorage persists user selection.
4. Verifies `LiveTaskScreen` provides model/effort controls for subsequent turns.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run apps/web/src/App.test.tsx`

- [ ] **Step 3: Implement Model and Effort Selection in NewTaskScreen, LiveTaskScreen, and App.tsx**

1. In `NewTaskScreen.tsx`:
   - Add model options: Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B.
   - Add High / Medium / Low effort segmented buttons (conditionally visible/active when model supports effort).
   - Load initial state from `localStorage` (`rh_model`, `rh_effort`), defaulting to `'gemini-3.8-flash-high'` and `'high'`.
   - Pass `model` and `effort` to `onCreateTask`.
2. In `App.tsx`:
   - Update `handleCreateTask` to accept `model` and `effort` parameters and forward to `apiClient.createTask`.
3. In `LiveTaskScreen.tsx`:
   - Add a model and effort pill/popover in the composer actions or header showing the current model and effort.
   - Allow switching model and effort on the fly.
   - Use the selected model and effort when dispatching `apiClient.createTask` for subsequent messages.
4. In `styles.css`:
   - Add styles for the model selector dropdown/pills, effort segmented controls, and composer model badge.
   - Ensure responsive design on mobile and desktop without layout breaks. Ensure touch targets >= 44px.
   - NO comments in any code or CSS.

- [ ] **Step 4: Run tests to verify all tests pass**

Run: `npx vitest run apps/web/src/App.test.tsx`

---

### Task 3: Full Workspace Verification, CLI Version Bump, NPM Publish, and Cloudflare Deploy

**Files:**
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Run full test suite and typecheck**

Run:
`npm run typecheck`
`npm test`

- [ ] **Step 2: Bump CLI package version**

Bump `packages/cli/package.json` from `0.1.3` to `0.1.4`.

- [ ] **Step 3: Build CLI and publish to npm**

Run:
`npm --prefix packages/cli run build`
`npm --prefix packages/cli run prepack`
`npm publish --workspace=packages/cli --access public`

- [ ] **Step 4: Build web app and deploy to Cloudflare**

Run:
`npm --prefix apps/web run deploy`

- [ ] **Step 5: Verify live deployment**

Confirm deployment URL and verify endpoint response.
