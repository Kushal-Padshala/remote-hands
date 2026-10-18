# HUD `/history` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `/history` in the HUD (Mac and Windows) lists past chats; picking one shows its earlier messages and the next message continues that exact agent conversation.

**Architecture:** The daemon builds a chat list from `local.db` tasks grouped by `conversation_id` (pure module `guidance/chat-history.ts`), exposes `historyList()` / `resumeChat(id)` on `HudCoordinator`, and `SpotlightHudRunner.openInteractivePrompt` carries two new JSON-line events (`history`, `resume`) and two replies (`history-list`, `resumed`). The Mac HUD reuses its existing `@`-attach popover panel for a `/` menu; the Windows HUD gets a small owner-drawn popover form. Resuming only sets `currentConversationId`; the existing `WarmAgySession` already restarts `agy --conversation <id>`.

**Tech Stack:** TypeScript (vitest), Swift/AppKit single file `spotlight-hud.swift`, C# 5 WinForms (`Hud.cs`, `HudLogic.cs`, built on the user's PC by csc.exe: no `?.`, `$""`, `nameof`, expression bodies, auto-property initializers; ASCII only).

**Spec:** `docs/superpowers/specs/2026-10-18-hud-history-design.md`

## Global Constraints

- C# files must be plain ASCII (`embed-swift.mjs` rejects anything else; use `\uXXXX`) and valid C# 5 / .NET Framework 4.
- Wire names are exactly: HUD to daemon `{"event":"history"}` and `{"event":"resume","id":"<conversation id>"}`; daemon to HUD `{"event":"history-list","items":[{"id","title","when","count"}]}` and `{"event":"resumed","id","title","turns":[{"goal","answer"}]}`.
- Limits: at most 30 chats, at most 20 turns per chat, title at most 80 characters; the daemon reads at most 400 tasks.
- Only tasks with a `conversation_id` and status `done`, `failed` or `cancelled` are listed.
- Cloud (phone) store: no `listTasks`, so the list is empty and the HUD shows "No chats yet".
- A message starting with `/` that matches no command is an ordinary message (Enter sends it).
- Commit and push (`git push origin HEAD:main` and `HEAD:feat/browser-speed`) after each task. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never edit `*.generated.ts`; run `npm run build -w @remote-hands/daemon` to regenerate.

## Review Focus

- A prompt that is not in the `Goal: ... Active Environment Context:` shape (phone/cloud tasks): the title is the first 80 chars of its first line, never the whole wrapped prompt. Pinned in Task 1.
- A chat whose last turn failed or was stopped: it still lists and resumes; that turn shows "Stopped." / "The task failed." Pinned in Task 1.
- Resuming while a task is running: the task is stopped first and the next task carries the resumed id. Pinned in Task 2.
- An unknown or stale id on `resume`: nothing switches and the HUD gets an empty list instead of hanging. Pinned in Task 2 and Task 3.
- A message like `/usr/bin question` or `/history` typed without a match must still send as an ordinary message. Pinned in Task 5 (`Slash.Rows` is empty) and Task 4 (Swift guard).

---

### Task 1: Chat list from stored tasks

**Files:**
- Create: `packages/daemon/src/guidance/chat-history.ts`
- Test: `packages/daemon/src/guidance/chat-history.test.ts`

**Interfaces:**
- Produces:
  - `interface HistoryTask { prompt: string; status: string; conversation_id: string | null; result_summary?: string | null; created_at: string; finished_at?: string | null }`
  - `interface ChatTurn { goal: string; answer: string }`
  - `interface ChatSummary { id: string; title: string; updatedAt: number; turns: ChatTurn[] }`
  - `interface HudHistoryItem { id: string; title: string; when: string; count: number }`
  - `goalOfPrompt(prompt: string): string`
  - `relativeTime(thenMs: number, nowMs: number): string`
  - `buildChatHistory(tasks: HistoryTask[]): ChatSummary[]` (newest chat first)
  - `toHistoryItems(chats: ChatSummary[], nowMs: number): HudHistoryItem[]`

- [ ] **Step 1: Write the failing test** (`chat-history.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { buildChatHistory, goalOfPrompt, relativeTime, toHistoryItems, type HistoryTask } from './chat-history.js';

const wrap = (goal: string) => `Goal: ${goal}\n\nActive Environment Context:\n- Frontmost Application: Notes\n\nExecution Mandate:\n1. x`;
const task = (over: Partial<HistoryTask>): HistoryTask => ({
  prompt: wrap('hello'),
  status: 'done',
  conversation_id: 'c1',
  result_summary: 'Hi there',
  created_at: '2026-10-16T10:00:00.000Z',
  finished_at: '2026-10-16T10:01:00.000Z',
  ...over,
});

describe('goalOfPrompt', () => {
  it('takes the words after Goal: up to the context block, multi-line included', () => {
    expect(goalOfPrompt(wrap('add more\nhigh converting'))).toBe('add more\nhigh converting');
  });
  it('falls back to the first line of a prompt in another shape, capped', () => {
    expect(goalOfPrompt('just do the thing\nsecond line')).toBe('just do the thing');
    expect(goalOfPrompt('x'.repeat(500)).length).toBe(300);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  it.each([
    [now - 5_000, 'just now'],
    [now - 5 * 60_000, '5m ago'],
    [now - 3 * 3_600_000, '3h ago'],
    [now - 2 * 86_400_000, '2d ago'],
    [now - 15 * 86_400_000, '2w ago'],
  ])('%s', (then, text) => expect(relativeTime(then, now)).toBe(text));
});

describe('buildChatHistory', () => {
  it('groups turns by conversation, oldest turn first, newest chat first', () => {
    const chats = buildChatHistory([
      task({ conversation_id: 'a', prompt: wrap('first'), result_summary: 'one', created_at: '2026-10-16T10:00:00.000Z', finished_at: '2026-10-16T10:01:00.000Z' }),
      task({ conversation_id: 'b', prompt: wrap('other chat'), result_summary: 'x', created_at: '2026-10-17T10:00:00.000Z', finished_at: '2026-10-17T10:01:00.000Z' }),
      task({ conversation_id: 'a', prompt: wrap('second'), result_summary: 'two', created_at: '2026-10-16T10:05:00.000Z', finished_at: '2026-10-16T10:06:00.000Z' }),
    ]);
    expect(chats.map((c) => c.id)).toEqual(['b', 'a']);
    expect(chats[1]!.title).toBe('first');
    expect(chats[1]!.turns).toEqual([{ goal: 'first', answer: 'one' }, { goal: 'second', answer: 'two' }]);
    expect(chats[1]!.updatedAt).toBe(Date.parse('2026-10-16T10:06:00.000Z'));
  });
  it('skips tasks with no conversation id and tasks still running', () => {
    expect(buildChatHistory([task({ conversation_id: null }), task({ status: 'running' }), task({ status: 'queued' })])).toEqual([]);
  });
  it('keeps a failed or stopped turn with a plain answer', () => {
    const [chat] = buildChatHistory([task({ status: 'failed', result_summary: null }), task({ status: 'cancelled', result_summary: null, created_at: '2026-10-16T11:00:00.000Z', finished_at: null })]);
    expect(chat!.turns.map((t) => t.answer)).toEqual(['The task failed.', 'Stopped.']);
  });
  it('turns the agent markdown into plain text like the HUD shows it', () => {
    const [chat] = buildChatHistory([task({ result_summary: '**Done** with `x`' })]);
    expect(chat!.turns[0]!.answer).toBe('Done with x');
  });
  it('caps titles at 80 characters on one line and keeps 30 chats of 20 turns', () => {
    const [long] = buildChatHistory([task({ prompt: wrap(`${'word '.repeat(40)}\nmore`) })]);
    expect(long!.title.length).toBeLessThanOrEqual(80);
    expect(long!.title).not.toContain('\n');
    const many = Array.from({ length: 35 }, (_, i) => task({ conversation_id: `c${i}`, created_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`, finished_at: null }));
    expect(buildChatHistory(many).length).toBe(30);
    const turns = Array.from({ length: 25 }, (_, i) => task({ prompt: wrap(`t${i}`), created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`, finished_at: null }));
    const [deep] = buildChatHistory(turns);
    expect(deep!.turns.length).toBe(20);
    expect(deep!.turns.at(-1)!.goal).toBe('t24');
  });
});

describe('toHistoryItems', () => {
  it('gives the HUD id, title, short time and message count', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const items = toHistoryItems(buildChatHistory([task({})]), now);
    expect(items).toEqual([{ id: 'c1', title: 'hello', when: '1h ago', count: 1 }]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd /Users/kushal/Desktop/project/remote-hands && npx vitest run packages/daemon/src/guidance/chat-history.test.ts` — Expected: cannot resolve `./chat-history.js`.

- [ ] **Step 3: Implement** (`chat-history.ts`)

```ts
import { plainSummary } from './hud-feed.js';

/** The part of a stored task the chat list needs (a LocalTask has all of it). */
export interface HistoryTask {
  prompt: string;
  status: string;
  conversation_id: string | null;
  result_summary?: string | null;
  created_at: string;
  finished_at?: string | null;
}

export interface ChatTurn {
  goal: string;
  answer: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  turns: ChatTurn[];
}

/** What the HUD lists. `when` is made here so both HUDs say the same words. */
export interface HudHistoryItem {
  id: string;
  title: string;
  when: string;
  count: number;
}

export const HISTORY_MAX_CHATS = 30;
export const HISTORY_MAX_TURNS = 20;
export const HISTORY_TITLE_MAX = 80;
const FALLBACK_GOAL_MAX = 300;
const FINISHED = new Set(['done', 'failed', 'cancelled']);

/** The person's own words: the stored prompt is `Goal: <words>` followed by a block of environment notes. */
export function goalOfPrompt(prompt: string): string {
  const text = prompt.replace(/\r\n?/g, '\n');
  const match = /^Goal: ([\s\S]*?)(?:\n\nActive Environment Context:|$)/.exec(text);
  if (match) return match[1]!.trim();
  return (text.split('\n')[0] ?? '').trim().slice(0, FALLBACK_GOAL_MAX);
}

export function relativeTime(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function titleOf(goal: string): string {
  const oneLine = goal.replace(/\s+/g, ' ').trim();
  return oneLine.length > HISTORY_TITLE_MAX ? `${oneLine.slice(0, HISTORY_TITLE_MAX - 1).trimEnd()}…` : oneLine;
}

function answerOf(task: HistoryTask): string {
  if (task.status === 'cancelled') return 'Stopped.';
  if (task.status === 'failed') return 'The task failed.';
  return plainSummary(task.result_summary ?? '') || 'Done.';
}

/** Chats the agent can continue (they have a conversation id), newest first, each with its turns oldest first. */
export function buildChatHistory(tasks: HistoryTask[]): ChatSummary[] {
  const finished = tasks
    .filter((t) => t.conversation_id && FINISHED.has(t.status))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const chats = new Map<string, ChatSummary>();
  for (const t of finished) {
    const id = t.conversation_id!;
    const goal = goalOfPrompt(t.prompt);
    const when = Date.parse(t.finished_at ?? '') || Date.parse(t.created_at) || 0;
    let chat = chats.get(id);
    if (!chat) {
      chat = { id, title: titleOf(goal), updatedAt: when, turns: [] };
      chats.set(id, chat);
    }
    chat.turns.push({ goal, answer: answerOf(t) });
    chat.updatedAt = Math.max(chat.updatedAt, when);
  }
  return [...chats.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, HISTORY_MAX_CHATS)
    .map((c) => ({ ...c, turns: c.turns.slice(-HISTORY_MAX_TURNS) }));
}

export function toHistoryItems(chats: ChatSummary[], nowMs: number): HudHistoryItem[] {
  return chats.map((c) => ({ id: c.id, title: c.title, when: relativeTime(c.updatedAt, nowMs), count: c.turns.length }));
}
```

- [ ] **Step 4: Run, expect PASS** — same command. If the "30 chats" assertion fails because two fixtures share `updatedAt`, that is fine (sort is stable); the length must still be 30.

- [ ] **Step 5: Commit and push**

```bash
cd /Users/kushal/Desktop/project/remote-hands && git add packages/daemon/src/guidance/chat-history.ts packages/daemon/src/guidance/chat-history.test.ts && git commit -m "feat(hud): build the chat list for /history from stored tasks" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git push origin HEAD:main && git push origin HEAD:feat/browser-speed
```

---

### Task 2: Coordinator lists chats and resumes one

**Files:**
- Modify: `packages/daemon/src/guidance/hud-coordinator.ts` (imports at top; new methods after `cancelActiveTask`, ~line 360; `startListening` and `triggerPrompt` pass `this.historyMenu()`)
- Test: `packages/daemon/src/guidance/hud-coordinator.test.ts` (append a `describe('history')` block inside the file's top-level `describe('HudCoordinator')` before its closing `});`)

**Interfaces:**
- Consumes: Task 1 (`buildChatHistory`, `toHistoryItems`, `HudHistoryItem`, `ChatTurn`).
- Produces:
  - `export interface HudResumed { id: string; title: string; turns: ChatTurn[] }`
  - `export interface HudHistory { list: () => Promise<HudHistoryItem[]>; resume: (id: string) => Promise<HudResumed | null> }` (exported from `hud-coordinator.ts`; Task 3 imports the type from there)
  - `HudCoordinator.historyList(nowMs?: number): Promise<HudHistoryItem[]>`
  - `HudCoordinator.resumeChat(id: string): Promise<HudResumed | null>`
  - `HudCoordinator.historyMenu(): HudHistory` (private)

- [ ] **Step 1: Write the failing tests**

```ts
  describe('history', () => {
    const wrap = (goal: string) => `Goal: ${goal}\n\nActive Environment Context:\n- Frontmost Application: Notes`;
    const row = (id: string | null, goal: string, summary: string, at: string, status = 'done') => ({
      prompt: wrap(goal), status, conversation_id: id, result_summary: summary, created_at: at, finished_at: at,
    });

    it('lists the chats that can be continued, newest first', async () => {
      const store = { listTasks: vi.fn().mockResolvedValue([
        row('a', 'old chat', 'x', '2026-10-10T10:00:00.000Z'),
        row('b', 'new chat', 'y', '2026-10-17T10:00:00.000Z'),
        row(null, 'fast one', 'z', '2026-10-17T11:00:00.000Z'),
      ]) };
      const c = new HudCoordinator({ hudRunner: mockHudRunner, intentResolver: mockIntentResolver, guidanceManager: mockGuidanceManager, macosDriver: mockMacOsDriver, store: store as any });
      const items = await c.historyList(Date.parse('2026-10-18T10:00:00.000Z'));
      expect(items.map((i) => i.id)).toEqual(['b', 'a']);
      expect(items[0]).toMatchObject({ title: 'new chat', count: 1 });
    });

    it('answers with an empty list when the store cannot list tasks', async () => {
      const c = new HudCoordinator({ hudRunner: mockHudRunner, intentResolver: mockIntentResolver, guidanceManager: mockGuidanceManager, macosDriver: mockMacOsDriver, store: {} as any });
      expect(await c.historyList()).toEqual([]);
    });

    it('resumes a chat: returns its turns and the next task carries its conversation id', async () => {
      let submit: any;
      mockHudRunner.openInteractivePrompt = vi.fn().mockImplementation((_a: any, onSubmit: any) => { submit = onSubmit; return { close: vi.fn() }; });
      const created: any[] = [];
      const store = {
        listTasks: vi.fn().mockResolvedValue([row('conv-old', 'rename the campaign', 'Renamed', '2026-10-16T10:00:00.000Z')]),
        createTask: vi.fn().mockImplementation(async (input: any) => { const t = { id: `t${created.length + 1}`, ...input }; created.push(t); return t; }),
        markTaskRunning: vi.fn().mockImplementation(async (id: string) => ({ id, status: 'running' })),
        appendEvent: vi.fn().mockResolvedValue(undefined),
        completeTask: vi.fn().mockResolvedValue(undefined),
      };
      const runner = { run: vi.fn().mockResolvedValue({ status: 'done', summary: 'ok', conversationId: 'conv-old' }) };
      const c = new HudCoordinator({ hudRunner: mockHudRunner, intentResolver: mockIntentResolver, guidanceManager: mockGuidanceManager, macosDriver: mockMacOsDriver, store: store as any, runner: runner as any, autoExecute: true });
      c.startListening();
      await mockHudRunner.startListener.mock.calls[0]![0]({ event: 'hotkey', app: 'Notes' });
      const resumed = await c.resumeChat('conv-old');
      expect(resumed).toEqual({ id: 'conv-old', title: 'rename the campaign', turns: [{ goal: 'rename the campaign', answer: 'Renamed' }] });
      await submit({ query: 'now make it shorter', app: 'Notes' }, () => {});
      await new Promise((r) => setTimeout(r, 20));
      expect(created[0].conversation_id).toBe('conv-old');
    });

    it('does nothing for an id that is not in the list', async () => {
      const store = { listTasks: vi.fn().mockResolvedValue([row('a', 'x', 'y', '2026-10-10T10:00:00.000Z')]) };
      const c = new HudCoordinator({ hudRunner: mockHudRunner, intentResolver: mockIntentResolver, guidanceManager: mockGuidanceManager, macosDriver: mockMacOsDriver, store: store as any });
      const stop = vi.spyOn(c, 'stopActiveTask');
      expect(await c.resumeChat('nope')).toBeNull();
      expect(stop).not.toHaveBeenCalled();
    });

    it('stops a running task before it switches chats', async () => {
      const store = { listTasks: vi.fn().mockResolvedValue([row('a', 'x', 'y', '2026-10-10T10:00:00.000Z')]) };
      const c = new HudCoordinator({ hudRunner: mockHudRunner, intentResolver: mockIntentResolver, guidanceManager: mockGuidanceManager, macosDriver: mockMacOsDriver, store: store as any });
      vi.spyOn(c, 'hasActiveTask').mockReturnValue(true);
      const stop = vi.spyOn(c, 'stopActiveTask').mockResolvedValue();
      await c.resumeChat('a');
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run packages/daemon/src/guidance/hud-coordinator.test.ts -t history` — Expected: `historyList is not a function`.

- [ ] **Step 3: Implement.** Add to the imports of `hud-coordinator.ts`:

```ts
import { buildChatHistory, toHistoryItems, type ChatTurn, type HudHistoryItem } from './chat-history.js';
```

Add (exported, above `HudCoordinatorOptions`):

```ts
export interface HudResumed {
  id: string;
  title: string;
  turns: ChatTurn[];
}

/** What the prompt window can ask for with /history: the list of chats and the choice of one. */
export interface HudHistory {
  list: () => Promise<HudHistoryItem[]>;
  resume: (id: string) => Promise<HudResumed | null>;
}
```

Add methods to the class (after `cancelActiveTask`):

```ts
  private async loadChats(): Promise<ReturnType<typeof buildChatHistory>> {
    const store = this.getStore() as { listTasks?: (o: { limit: number }) => Promise<any[]> } | null;
    if (!store || typeof store.listTasks !== 'function') return [];
    const tasks = await store.listTasks({ limit: 400 }).catch(() => [] as any[]);
    return buildChatHistory(tasks);
  }

  /** The chats /history shows. */
  async historyList(nowMs: number = Date.now()): Promise<HudHistoryItem[]> {
    return toHistoryItems(await this.loadChats(), nowMs);
  }

  /** Makes the next task continue that chat. A running task is stopped first. Null (nothing changes) for an unknown id. */
  async resumeChat(id: string): Promise<HudResumed | null> {
    const chat = (await this.loadChats()).find((c) => c.id === id);
    if (!chat) return null;
    if (this.hasActiveTask()) await this.stopActiveTask('Switched to another chat');
    this.currentConversationId = chat.id;
    this.lastTaskDigest = undefined;
    this.lastDigestFromFastLane = false;
    return { id: chat.id, title: chat.title, turns: chat.turns };
  }

  private historyMenu(): HudHistory {
    return { list: () => this.historyList(), resume: (id) => this.resumeChat(id) };
  }
```

In `triggerPrompt`, change the `openInteractivePrompt(` call to pass the history as the 7th argument (after `this.modelMenu()`): the existing call is `(appOverride, onSubmit, onCancel, onStop, undefined, this.modelMenu())` so append `, this.historyMenu()`. In `startListening`, change `promptArgs.push(event.windowTitle || undefined, this.modelMenu());` to `promptArgs.push(event.windowTitle || undefined, this.modelMenu(), this.historyMenu());`.

NOTE for the engineer: the runner signature gets its 7th parameter in Task 3. Do both edits before running the full suite; the test above only needs the methods.

- [ ] **Step 4: Run, expect PASS** — same command, then `npx vitest run packages/daemon/src/guidance` (all green).

- [ ] **Step 5: Commit and push** (message `feat(hud): coordinator lists chats and resumes one`, same push lines as Task 1, `git add packages/daemon/src/guidance/hud-coordinator.ts packages/daemon/src/guidance/hud-coordinator.test.ts`).

---

### Task 3: Prompt-window protocol (`history`, `resume`)

**Files:**
- Modify: `packages/daemon/src/desktop/spotlight-hud.ts` (`openInteractivePrompt` signature ~line 229, stdout handler ~line 305)
- Test: `packages/daemon/src/desktop/spotlight-hud.test.ts`

**Interfaces:**
- Consumes: `HudHistory`, `HudResumed` from `../guidance/hud-coordinator.js` (type-only import to avoid a runtime cycle: `import type { HudHistory } from '../guidance/hud-coordinator.js'`).
- Produces: `openInteractivePrompt(activeApp, onSubmit, onCancel?, onStop?, windowTitle?, modelMenu?, history?: HudHistory)` and the two replies on the child's stdin.

- [ ] **Step 1: Write the failing tests** (append inside `describe('SpotlightHudRunner')`)

```ts
  it('answers /history and /resume lines from the prompt window', async () => {
    let onData: ((chunk: Buffer) => void) | undefined;
    const written: string[] = [];
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { onData = cb; } },
      stdin: { writable: true, write: (s: string) => { written.push(s); return true; } }, killed: false, kill: vi.fn(), unref: vi.fn(),
    })) as never);
    const history = {
      list: vi.fn().mockResolvedValue([{ id: 'c1', title: 'hello', when: '1h ago', count: 2 }]),
      resume: vi.fn().mockImplementation(async (id: string) => (id === 'c1' ? { id: 'c1', title: 'hello', turns: [{ goal: 'g', answer: 'a' }] } : null)),
    };
    runner.openInteractivePrompt('Notes', () => {}, undefined, undefined, undefined, undefined, history);
    onData!(Buffer.from('{"event":"history"}\n{"event":"resume","id":"c1"}\n{"event":"resume","id":"gone"}\n'));
    await new Promise((r) => setTimeout(r, 10));
    const lines = written.filter((w) => w.includes('"event"')).map((w) => JSON.parse(w));
    expect(lines).toContainEqual({ event: 'history-list', items: [{ id: 'c1', title: 'hello', when: '1h ago', count: 2 }] });
    expect(lines).toContainEqual({ event: 'resumed', id: 'c1', title: 'hello', turns: [{ goal: 'g', answer: 'a' }] });
    // an id that is gone: the window gets an empty list instead of waiting forever
    expect(lines.filter((l) => l.event === 'history-list').at(-1)).toEqual({ event: 'history-list', items: [] });
  });

  it('answers /history with an empty list when no history is offered', async () => {
    let onData: ((chunk: Buffer) => void) | undefined;
    const written: string[] = [];
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { onData = cb; } },
      stdin: { writable: true, write: (s: string) => { written.push(s); return true; } }, killed: false, kill: vi.fn(), unref: vi.fn(),
    })) as never);
    runner.openInteractivePrompt('Notes', () => {});
    onData!(Buffer.from('{"event":"history"}\n'));
    await new Promise((r) => setTimeout(r, 5));
    expect(written.map((w) => JSON.parse(w))).toContainEqual({ event: 'history-list', items: [] });
  });
```

(`written` also receives the `context` write in some runs; the tests filter by `toContainEqual` so that is fine. The context write is async and may arrive; it is JSON too.)

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run packages/daemon/src/desktop/spotlight-hud.test.ts -t "history"`.

- [ ] **Step 3: Implement.** Add `import type { HudHistory } from '../guidance/hud-coordinator.js';` to the imports. Add a parameter `history?: HudHistory | undefined` after `modelMenu`. Next to `sendUpdate`, add:

```ts
    const sendEvent = (payload: Record<string, unknown>) => {
      if (!child.killed && child.stdin && child.stdin.writable) {
        try {
          child.stdin.write(JSON.stringify(payload) + '\n');
        } catch {}
      }
    };
```

In the parsed-event chain, before `else if (parsed.event === 'cancel')`, add:

```ts
          } else if (parsed.event === 'history') {
            const list = history ? history.list() : Promise.resolve([]);
            list
              .then((items) => sendEvent({ event: 'history-list', items }))
              .catch(() => sendEvent({ event: 'history-list', items: [] }));
          } else if (parsed.event === 'resume' && typeof parsed.id === 'string') {
            const resume = history ? history.resume(parsed.id) : Promise.resolve(null);
            resume
              .then((chat) => sendEvent(chat ? { event: 'resumed', ...chat } : { event: 'history-list', items: [] }))
              .catch(() => sendEvent({ event: 'history-list', items: [] }));
```

- [ ] **Step 4: Run, expect PASS** — then the whole desktop + guidance folders: `npx vitest run packages/daemon/src/desktop packages/daemon/src/guidance`; then `npm run build -w @remote-hands/daemon` (typecheck).

- [ ] **Step 5: Commit and push** (`feat(hud): prompt window protocol for /history and resume`).

---

### Task 4: Mac HUD (`spotlight-hud.swift`)

**Files:**
- Modify: `packages/daemon/src/desktop/spotlight-hud.swift`

**Interfaces:**
- Consumes: Task 3 wire format.
- Produces: `/` menu in the pill; resumed chat view.

Existing pieces this reuses (verified): `showContextPanel(query:)` builds rows into `filteredContextItems` then shows `contextPanel`; `attachItem(_:)` handles a picked row; `control(_:textView:doCommandBy:)` already handles Enter/Tab/Up/Down/Esc while `contextPanel?.isVisible == true`; `cancelOperation` in `SpotlightPanel` hides it; cells read `label`, `subtitle`, `icon`, `badge`.

- [ ] **Step 1: Pull the panel-building code out of `showContextPanel`.** Cut everything from `if filteredContextItems.isEmpty {` (just before `let rowCount = min(7, ...`) to the end of the function and make it a new method; leave a call in its place:

```swift
        presentPanelRows()
    }

    /// Shows `filteredContextItems` in the popover under the pill (the @ attach list and the / menu share it).
    func presentPanelRows() {
        if filteredContextItems.isEmpty {
            hideContextPanel()
            return
        }
        // ... the moved code, unchanged ...
    }
```

- [ ] **Step 2: Add the slash menu state and rows.** Add near `var filteredContextItems`:

```swift
    /// The chats /history listed (nil until the daemon answers).
    var historyItems: [[String: Any]]?
    var historyRequested = false
```

Add methods next to `showContextPanel`:

```swift
    /// The / menu: one command now (/history), then the chats once /history is picked ("/history " + words filters them).
    func showSlashPanel(_ text: String) {
        let lower = text.lowercased()
        if lower.hasPrefix("/history ") {
            let query = String(lower.dropFirst("/history ".count)).trimmingCharacters(in: .whitespaces)
            var rows: [[String: Any]] = []
            if let chats = historyItems {
                for chat in chats {
                    let title = chat["title"] as? String ?? ""
                    if !query.isEmpty && !title.lowercased().contains(query) { continue }
                    let count = chat["count"] as? Int ?? 1
                    rows.append(["type": "chat", "id": chat["id"] as? String ?? "", "label": title,
                                 "subtitle": count == 1 ? "1 message" : "\(count) messages", "icon": "💬", "badge": chat["when"] as? String ?? ""])
                }
                if rows.isEmpty {
                    rows = [["type": "info", "id": "", "label": chats.isEmpty ? "No chats yet" : "No chats match", "subtitle": "", "icon": "🕘", "badge": ""]]
                }
            } else {
                rows = [["type": "info", "id": "", "label": "Loading chats…", "subtitle": "", "icon": "🕘", "badge": ""]]
            }
            filteredContextItems = rows
        } else {
            let query = String(lower.dropFirst())
            if !query.isEmpty && !"history".hasPrefix(query) {
                hideContextPanel()   // not a command: it is an ordinary message
                return
            }
            filteredContextItems = [["type": "slash", "id": "/history", "label": "/history", "subtitle": "Continue a previous chat", "icon": "🕘", "badge": ""]]
        }
        presentPanelRows()
    }

    /// A row of the / menu was picked.
    func pickSlashRow(_ item: [String: Any]) {
        switch item["type"] as? String ?? "" {
        case "slash":
            textField.stringValue = "/history "
            textField.currentEditor()?.selectedRange = NSRange(location: textField.stringValue.count, length: 0)
            if historyItems == nil && !historyRequested {
                historyRequested = true
                print("{\"event\":\"history\"}")
                fflush(stdout)
            }
            showSlashPanel(textField.stringValue)
        case "chat":
            guard let id = item["id"] as? String, !id.isEmpty else { return }
            textField.stringValue = ""
            hideContextPanel()
            fitPromptHeight()
            updateSendButton()
            if let data = try? JSONSerialization.data(withJSONObject: ["event": "resume", "id": id]),
               let json = String(data: data, encoding: .utf8) {
                print(json)
                fflush(stdout)
            }
        default:
            break   // "Loading…" / "No chats yet": nothing to pick
        }
    }
```

At the top of `attachItem(_:)` add:

```swift
        if let kind = item["type"] as? String, kind == "slash" || kind == "chat" || kind == "info" {
            pickSlashRow(item)
            return
        }
```

- [ ] **Step 3: Hook typing.** In `controlTextDidChange`, replace the `let current = ...` through the closing `}` of the `@` branch with:

```swift
        let current = textField.stringValue
        if current.hasPrefix("/") && !current.contains("@") && !current.contains("\n") {
            showSlashPanel(current)
        } else if let atIndex = current.lastIndex(of: "@") {
            let afterAt = String(current[current.index(after: atIndex)...])
            showContextPanel(query: afterAt)
        } else {
            hideContextPanel()
        }
```

The existing Enter handling in `control(_:textView:doCommandBy:)` only takes the panel branch when rows exist (`sel >= 0 && sel < filteredContextItems.count`) and the panel is visible; an unmatched `/foo` hides the panel, so Enter falls through to `submitPrompt()` (ordinary message). A selected `info` row swallows Enter via `attachItem` (no-op), which is right.

- [ ] **Step 4: Reply handling.** In `handleUpdate`, directly after the `context` branch add:

```swift
        if dict["event"] as? String == "history-list" {
            historyItems = dict["items"] as? [[String: Any]] ?? []
            historyRequested = false
            let current = textField?.stringValue ?? ""
            if current.lowercased().hasPrefix("/history ") { showSlashPanel(current) }
            return
        }
        if dict["event"] as? String == "resumed" {
            showResumed(dict)
            return
        }
```

- [ ] **Step 5: Show the resumed chat.** Change `func transitionToProgress(query: String)` to `query: String?`; its first lines become `isExpanded = true; isWorking = query != nil`, and the line `appendEntry(.goal, query)` becomes `if let first = query { appendEntry(.goal, first) }`. (Existing call site passes a `String`, which still compiles.) Add to `ActivityFeed`:

```swift
    /// Starts over with no cards (a different chat was picked).
    func reset() {
        for card in cards { card.removeFromSuperview() }
        cards.removeAll()
        activeStep = nil
        doc.frame = NSRect(x: 0, y: 0, width: cardWidth + ActivityCard.room * 2, height: 0)
        scroll.contentView.setBoundsOrigin(.zero)
        onChange?()
        updateMask()
    }
```

Add to `AppDelegate`:

```swift
    /// A past chat was picked: show its messages as cards and wait for the next one, which continues it.
    func showResumed(_ dict: [String: Any]) {
        let turns = dict["turns"] as? [[String: Any]] ?? []
        if isExpanded {
            isWorking = false
            feed.reset()
            requestCard = nil
            answerCard = nil
            answerText = ""
        } else {
            transitionToProgress(query: nil)
        }
        for turn in turns {
            appendEntry(.goal, turn["goal"] as? String ?? "")
            isWorking = false
            setStatus("Done", color: Theme.success)
            let answer = (turn["answer"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !answer.isEmpty { appendEntry(.answer, answer) }
        }
        mascot?.mood = .happy
        setFollowUp(visible: true)
        feed.scrollToEnd()
    }
```

(`appendEntry(.goal)` uses `isWorking` for the new request's live state; keeping `isWorking = false` after each call, before `setStatus`, leaves every replayed request on "Done". `requestCard`/`answerCard` are the existing optional properties; if either is declared non-optional, reset them to the nearest equivalent the file already uses.)

- [ ] **Step 6: Typecheck and snapshot-verify.**
  - `cd packages/daemon/src/desktop && swiftc -typecheck spotlight-hud.swift 2>&1 | grep error` — expect no output.
  - Snapshot check: build with `swiftc -D RH_UI_SNAPSHOT -o /tmp/rh-snap spotlight-hud.swift` (same way earlier snapshot builds ran), write a script file with lines: `{"type":"/hi"}` then `{"snap":"slash"}`; `{"event":"history-list","items":[{"id":"a","title":"rename the campaign","when":"2d ago","count":3},{"id":"b","title":"write headlines","when":"5h ago","count":1}]}`, `{"type":"/history "}`, `{"snap":"chats"}`; then `{"event":"resumed","id":"a","title":"rename","turns":[{"goal":"rename the campaign","answer":"Renamed it to Rental leads."},{"goal":"shorter","answer":"Done: Rental leads."}]}`, `{"snap":"resumed"}`. Read the PNGs with the Read tool and confirm: the `/history` row shows under the pill; the chats list shows titles with "2d ago"; the resumed view shows two request cards and two answer cards with the pill visible. Keep stdin open (`sleep 20 | /tmp/rh-snap ...`). If the `type` script op does not call `controlTextDidChange`, add that call in the snapshot runner's `type` branch.
  - Fix anything that looks wrong before moving on.

- [ ] **Step 7: Install and restart the live HUD** (so the user can try it):
  `npm run build -w @remote-hands/daemon && (cd packages/cli && npm run build) && cp packages/cli/dist/index.js ~/.remote-hands/cli/index.js && launchctl kickstart -k gui/$(id -u)/com.remote-hands.hud`.

- [ ] **Step 8: Run `npx vitest run packages/daemon/src/desktop`, commit and push** (`feat(hud-mac): /history menu and resumed chats`).

---

### Task 5: Windows logic (pure, tested)

**Files:**
- Modify: `packages/daemon/src/desktop/windows-hud/HudLogic.cs` (append before the final `}`), `packages/daemon/src/desktop/windows-hud/check/Tests.cs`

**Interfaces:**
- Produces (all `public`, namespace `RemoteHands`):
  - `sealed class ChatItem { string Id, Title, When; int Count; }`
  - `sealed class ChatTurn { string Goal, Answer; }`
  - `sealed class SlashRow { string Kind /* "command" | "chat" | "info" */; string Id, Title, Subtitle, Badge; }`
  - `static class Slash { const string History = "/history"; static bool IsMenuText(string text); static List<SlashRow> Rows(string text, List<ChatItem> chats); static List<ChatItem> ParseChats(object items); static List<ChatTurn> ParseTurns(object turns); }`
  - `HudState.Resumed(string lastAnswer)`
  - `Messages.History()` returns `{"event":"history"}`, `Messages.Resume(string id)` returns `{"event":"resume","id":...}`.

`chats == null` means "not loaded yet".

- [ ] **Step 1: Write the failing tests** (add `SlashTests();` to `Main` after `CardTests();` and this method):

```csharp
    static void SlashTests()
    {
        True(Slash.IsMenuText("/"), "slash alone opens the menu");
        True(Slash.IsMenuText("/hist"), "prefix opens the menu");
        True(!Slash.IsMenuText("hello"), "ordinary text does not");
        True(!Slash.IsMenuText("/usr/bin question"), "a path-like message does not");
        True(!Slash.IsMenuText("/history\nmore"), "multi-line text does not");
        True(!Slash.IsMenuText("/a@b"), "an @ means attach, not a command");

        List<SlashRow> rows = Slash.Rows("/hi", null);
        Eq(1, rows.Count, "one command row");
        Eq("command", rows[0].Kind, "command kind");
        Eq("/history", rows[0].Title, "command title");
        Eq(0, Slash.Rows("/zzz", null).Count, "no match: no rows");

        Eq("info", Slash.Rows("/history ", null)[0].Kind, "not loaded: loading row");
        var chats = new List<ChatItem>();
        chats.Add(new ChatItem { Id = "a", Title = "Rename the campaign", When = "2d ago", Count = 3 });
        chats.Add(new ChatItem { Id = "b", Title = "Write headlines", When = "5h ago", Count = 1 });
        Eq(2, Slash.Rows("/history ", chats).Count, "all chats");
        List<SlashRow> filtered = Slash.Rows("/history  HEAD", chats);
        Eq(1, filtered.Count, "filter by words, ignoring case");
        Eq("b", filtered[0].Id, "filtered chat");
        Eq("1 message", filtered[0].Subtitle, "singular");
        Eq("3 messages", Slash.Rows("/history ", chats)[0].Subtitle, "plural");
        Eq("5h ago", filtered[0].Badge, "time badge");
        Eq("No chats yet", Slash.Rows("/history ", new List<ChatItem>())[0].Title, "empty list");
        Eq("No chats match", Slash.Rows("/history zzz", chats)[0].Title, "no match");

        var parsed = Json.Parse("{\"items\":[{\"id\":\"a\",\"title\":\"T\",\"when\":\"1h ago\",\"count\":2},{\"bad\":1}]}") as Dictionary<string, object>;
        List<ChatItem> items = Slash.ParseChats(parsed["items"]);
        Eq(1, items.Count, "bad rows are skipped");
        Eq(2, items[0].Count, "count parsed");
        var resumed = Json.Parse("{\"turns\":[{\"goal\":\"g\",\"answer\":\"a\"},{\"goal\":\"\",\"answer\":\"x\"}]}") as Dictionary<string, object>;
        List<ChatTurn> turns = Slash.ParseTurns(resumed["turns"]);
        Eq(2, turns.Count, "turns parsed");
        Eq("a", turns[0].Answer, "answer");

        Eq("{\"event\":\"history\"}", Messages.History(), "history line");
        Eq("{\"event\":\"resume\",\"id\":\"c\\\"1\"}", Messages.Resume("c\"1"), "resume line escapes the id");

        var state = new HudState();
        state.Resumed("last answer");
        True(state.IsExpanded && !state.IsWorking, "resumed: shown, not working");
        Eq("Done", state.StatusWord, "resumed: done");
        Eq("last answer", state.AnswerText, "resumed: answer kept for copy");
        True(state.CopyVisible, "resumed: copy available");
    }
```

- [ ] **Step 2: Run, expect compile FAIL** — `cd packages/daemon && node scripts/check-windows-hud.mjs`.

- [ ] **Step 3: Implement.** First read how `Messages` builds lines (`HudLogic.cs` ~line 235: it uses `Json.Quote`-style helpers) and follow the same helper for `History()`/`Resume()`; if the helper is named differently, use it. Add:

```csharp
    // ---- /history -----------------------------------------------------------------------------

    public sealed class ChatItem
    {
        public string Id = "";
        public string Title = "";
        public string When = "";
        public int Count;
    }

    public sealed class ChatTurn
    {
        public string Goal = "";
        public string Answer = "";
    }

    /// <summary>One line of the menu above the prompt: a command, a past chat, or a note ("Loading...").</summary>
    public sealed class SlashRow
    {
        public string Kind = "info";
        public string Id = "";
        public string Title = "";
        public string Subtitle = "";
        public string Badge = "";
    }

    public static class Slash
    {
        public const string History = "/history";

        /// <summary>A line that starts with / and could still become a command; anything else is an ordinary message.</summary>
        public static bool IsMenuText(string text)
        {
            if (text == null || text.Length == 0 || text[0] != '/') return false;
            if (text.IndexOf('\n') >= 0 || text.IndexOf('@') >= 0) return false;
            string lower = text.ToLowerInvariant();
            if (lower.StartsWith(History + " ")) return true;
            string rest = lower.Substring(1);
            return rest.Length == 0 || "history".StartsWith(rest);
        }

        /// <summary>The rows to show for what is typed. `chats` is null until the daemon has answered.</summary>
        public static List<SlashRow> Rows(string text, List<ChatItem> chats)
        {
            var rows = new List<SlashRow>();
            if (!IsMenuText(text)) return rows;
            string lower = text.ToLowerInvariant();
            if (lower.StartsWith(History + " "))
            {
                string query = lower.Substring(History.Length + 1).Trim();
                if (chats == null)
                {
                    rows.Add(Info("Loading chats..."));
                    return rows;
                }
                foreach (ChatItem chat in chats)
                {
                    if (query.Length > 0 && chat.Title.ToLowerInvariant().IndexOf(query, StringComparison.Ordinal) < 0) continue;
                    var row = new SlashRow();
                    row.Kind = "chat";
                    row.Id = chat.Id;
                    row.Title = chat.Title;
                    row.Subtitle = chat.Count == 1 ? "1 message" : chat.Count + " messages";
                    row.Badge = chat.When;
                    rows.Add(row);
                }
                if (rows.Count == 0) rows.Add(Info(chats.Count == 0 ? "No chats yet" : "No chats match"));
                return rows;
            }
            var command = new SlashRow();
            command.Kind = "command";
            command.Id = History;
            command.Title = History;
            command.Subtitle = "Continue a previous chat";
            rows.Add(command);
            return rows;
        }

        static SlashRow Info(string title)
        {
            var row = new SlashRow();
            row.Title = title;
            return row;
        }

        public static List<ChatItem> ParseChats(object items)
        {
            var result = new List<ChatItem>();
            var list = items as List<object>;
            if (list == null) return result;
            foreach (object entry in list)
            {
                var d = entry as Dictionary<string, object>;
                if (d == null) continue;
                string id = Json.GetString(d, "id");
                string title = Json.GetString(d, "title");
                if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(title)) continue;
                var chat = new ChatItem();
                chat.Id = id;
                chat.Title = title;
                chat.When = Json.GetString(d, "when") ?? "";
                object count;
                chat.Count = d.TryGetValue("count", out count) && count is double ? (int)(double)count : 1;
                result.Add(chat);
            }
            return result;
        }

        public static List<ChatTurn> ParseTurns(object turns)
        {
            var result = new List<ChatTurn>();
            var list = turns as List<object>;
            if (list == null) return result;
            foreach (object entry in list)
            {
                var d = entry as Dictionary<string, object>;
                if (d == null) continue;
                var turn = new ChatTurn();
                turn.Goal = Json.GetString(d, "goal") ?? "";
                turn.Answer = Json.GetString(d, "answer") ?? "";
                result.Add(turn);
            }
            return result;
        }
    }
```

In `HudState` add:

```csharp
        /// <summary>A past chat was picked: shown, nothing running, the last answer ready to copy.</summary>
        public void Resumed(string lastAnswer)
        {
            IsExpanded = true;
            IsWorking = false;
            StatusWord = "Done";
            StatusTone = Tone.Success;
            StopVisible = false;
            AnswerText = lastAnswer ?? "";
            CopyVisible = AnswerText.Length > 0;
        }
```

In `Messages` add `History()` and `Resume(string id)` using the same quoting helper the other messages use (check `Messages.Model` for the pattern). Verify `Json.GetString` returns null (not "") for a missing key and `Json.Parse` yields `List<object>` for arrays and `double` for numbers; if not, adapt `ParseChats` to what it returns (the tests above decide).

- [ ] **Step 4: Run, expect PASS** — `node scripts/check-windows-hud.mjs` (all checks, 0 failed).

- [ ] **Step 5: Commit and push** (`feat(hud-win): /history logic and tests`).

---

### Task 6: Windows UI (popover + resumed view)

**Files:**
- Modify: `packages/daemon/src/desktop/windows-hud/Hud.cs` (new class `SlashPopover` before `PromptForm`; `PromptForm` changes)

**Interfaces:**
- Consumes: Task 5 (`Slash`, `SlashRow`, `ChatItem`, `ChatTurn`, `Messages`, `HudState.Resumed`), existing `CardsForm.AddEntry/Reset/SetStatus/SetCopyReady`, `PromptForm.TransitionToProgress/ApplyChrome/AppendEntry/ArrangeColumn/Wire`.
- Produces: `SlashPopover` with `Show(Form owner, Rectangle pillScreenRect, List<SlashRow> rows)`, `HidePopover()`, `bool Visible`, `Move(int delta)`, `SlashRow Selected`, `event Action<SlashRow> Picked`.

- [ ] **Step 1: `SlashPopover` form.** Borderless, no-activate (`ShowWithoutActivation`, `WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW` = `0x08000000 | 0x80`), TopMost, `BackColor = Theme.Pill`, rows 38px (`Dpi.S(38)`), at most 7 rows, width = pill width (`Dpi.S(420)`), rounded region (radius 14) and a 1px `Theme.PillBorder` outline in `OnPaint`. `DoubleBuffered = true`. Row paint: selected row fills a rounded rect `Color.FromArgb(28,255,255,255)`; title `Segoe UI Semibold 10pt` in `Theme.Text` (or `Theme.Tertiary` for `info`); subtitle `Segoe UI 8.5pt` in `Theme.Secondary`; badge right-aligned `Segoe UI 8.5pt` in `Theme.Tertiary`; text uses `TextRenderer.DrawText` with `TextFormatFlags.EndEllipsis | NoPadding`. Mouse: `MouseMove` selects the hovered row; `MouseUp` (left) raises `Picked(row)` for non-info rows. Keep `rows`, `selected` private; `Move(delta)` clamps. Position: `Location = new Point(pill.Left, pill.Bottom + Dpi.S(6))`, clamped so its bottom stays inside the screen work area (if not, place it above the pill: `pill.Top - Height - Dpi.S(6)`).

- [ ] **Step 2: Wire `PromptForm`.**
  - Fields: `readonly SlashPopover popover = new SlashPopover(); List<ChatItem> chats; bool chatsRequested;`.
  - In the constructor: `popover.Picked += OnSlashPicked;` and `LocationChanged` already re-arranges; also call `UpdatePopover()` after `ArrangeColumn()` is not needed (the popover hides on move: add `if (popover.Visible) HideSlash();` to `OnMoved`).
  - `OnInputChanged`: after existing code add `UpdatePopover();`.

```csharp
        void UpdatePopover()
        {
            List<SlashRow> rows = Slash.Rows(input.Text, chats);
            if (rows.Count == 0)
            {
                popover.HidePopover();
                return;
            }
            Rectangle pill = RectangleToScreen(pillRect);
            popover.ShowRows(this, pill, rows);
        }

        void OnSlashPicked(SlashRow row)
        {
            if (row.Kind == "command")
            {
                input.Text = Slash.History + " ";
                input.SelectionStart = input.Text.Length;
                if (chats == null && !chatsRequested)
                {
                    chatsRequested = true;
                    Wire.Send(Messages.History());
                }
                UpdatePopover();
            }
            else if (row.Kind == "chat")
            {
                input.Text = "";
                popover.HidePopover();
                Wire.Send(Messages.Resume(row.Id));
                input.Focus();
            }
        }
```

  - `ProcessCmdKey`: at the very top, before the Escape branch:

```csharp
            if (popover.Visible)
            {
                if (keyData == Keys.Down) { popover.Move(1); return true; }
                if (keyData == Keys.Up) { popover.Move(-1); return true; }
                if (keyData == Keys.Enter || keyData == Keys.Tab)
                {
                    SlashRow chosen = popover.Selected;
                    if (chosen != null && chosen.Kind != "info") { OnSlashPicked(chosen); return true; }
                    if (keyData == Keys.Tab) return true;
                }
                if (keyData == Keys.Escape) { popover.HidePopover(); return true; }
            }
```

  An `Enter` with the popover visible but only an `info` row falls through to `OnInputKeyDown`, which would send "/history " as a message; guard `Submit()` with `if (Slash.IsMenuText(input.Text) && popover.Visible) return;`. Also, `Submit()` must call `popover.HidePopover()` after clearing the text.
  - `HandleLine`: before the `context` early return add:

```csharp
            string kind = Json.GetString(message, "event");
            if (kind == "history-list")
            {
                chats = Slash.ParseChats(message.ContainsKey("items") ? message["items"] : null);
                chatsRequested = false;
                if (Slash.IsMenuText(input.Text)) UpdatePopover();
                return;
            }
            if (kind == "resumed")
            {
                ShowResumed(Slash.ParseTurns(message.ContainsKey("turns") ? message["turns"] : null));
                return;
            }
```

  - `ShowResumed`:

```csharp
        void ShowResumed(List<ChatTurn> turns)
        {
            string last = "";
            foreach (ChatTurn turn in turns)
            {
                if (turn.Answer.Trim().Length > 0) last = turn.Answer.Trim();
            }
            bool first = !state.IsExpanded;
            state.Resumed(last);
            if (first) TransitionToProgress();
            else cards.Reset();
            foreach (ChatTurn turn in turns)
            {
                AppendEntry(EntryKind.Goal, turn.Goal);
                cards.SetStatus("Done", Theme.Success, false);
                AppendEntry(EntryKind.Answer, turn.Answer);
            }
            ApplyChrome();
            FocusPill();
        }
```

  (`cards.SetStatus(..., false)` before `AppendEntry(Answer)` makes each replayed request end as "Done"; `AppendEntry(Goal)` passes `state.IsWorking` which is false, so no pulsing.) `Reset()` exists on `CardsForm`; `TransitionToProgress` creates the `CardsForm`.
  - `Dispose`/exit: nothing else (Environment.Exit).

- [ ] **Step 3: Compile check** — `cd packages/daemon && node scripts/check-windows-hud.mjs` (0 warnings, 0 errors: `TreatWarningsAsErrors` is on; no unused variables).

- [ ] **Step 4: Rebuild the embedded sources and run the suites** — `npm run build -w @remote-hands/daemon && npx vitest run packages/daemon/src/desktop` (the Windows source tests check ASCII and the file list).

- [ ] **Step 5: Commit and push** (`feat(hud-win): /history popover and resumed chats`).

---

### Task 7: Finish

- [ ] **Step 1:** `npx vitest run` (whole repo) and `npm run typecheck` at the repo root; fix any failure.
- [ ] **Step 2: Real-data check on this Mac.** With the installed build running, in a Node REPL/script call the real functions against `~/.remote-hands/local.db`: `new LocalTaskStore({dbPath})` then `buildChatHistory(await store.listTasks({limit:400}))`; print titles and counts and confirm they look right (titles are the person's words, not the wrapped prompt). Use `node --input-type=module` against `packages/daemon/dist`.
- [ ] **Step 3: Live check.** Press Shift+Cmd+Space, type `/`, confirm the menu; pick `/history`, pick a chat, confirm its cards show; send "what did I ask first?" and confirm the answer refers to that chat.
- [ ] **Step 4:** Update the memory file `hud-mascot-status.md` (or add `hud-history-status.md` + an index line): what shipped, Windows unverified on a real PC, grouping caveat for old chats.
- [ ] **Step 5:** Commit, push, then one fresh-context review of the whole diff (`git diff 81b9a35..HEAD`) and fix real findings.
