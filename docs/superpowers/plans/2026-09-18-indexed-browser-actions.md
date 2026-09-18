# Indexed Ultrafast Browser Actions for agy Terminal Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `agy` high-speed, DOM-indexed browser action capabilities (`snapshot`, `click`, `type`, `select`) over local Chrome CDP via the terminal, enabling cross-domain workflows (code editing + git deployment + production browser verification) at zero API cost.

**Architecture:**
1. A lightweight in-page DOM script extracts visible, interactive elements (`button`, `input`, `a`, `select`, `[role]`) and assigns transient integer indices `[1]`, `[2]`, `[3]` cached on `window.__rhFast`.
2. A `BrowserDriver` connects to Chrome CDP (`http://127.0.0.1:9222`) to execute single-pass snapshots and dispatch native clicks and keystrokes directly to indexed elements in milliseconds.
3. `rh browser` CLI commands (`rh browser snapshot`, `rh browser click <index>`, `rh browser type <index> <text>`, `rh browser open <url>`) expose these actions directly to `agy`'s terminal bash tool.
4. `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT` and `DEFAULT_REMOTE_HANDS_REMINDER` in `packages/daemon/src/agy-runner.ts` guide `agy` to use indexed browser commands during multi-step browser phases.

**Tech Stack:**
- TypeScript, Node.js (Chrome DevTools Protocol over WebSocket/HTTP fetch)
- Chrome DevTools Protocol (`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Input.insertText`, `Target.*`)
- Vitest for unit & integration testing
- Esbuild for CLI bundling

**Spec:** Open-source indexed browser automation loop inspired by `browser-use/jev-ultrafast`, running locally without external classifier models or paid APIs.

## Global Constraints
- Write clean code with NO comments.
- Do NOT create walkthrough files or documentation.
- Maintain documentation integrity: preserve existing comments and docstrings in untouched code.
- Ensure all tests pass and no API calls are broken.

---

### Task 1: Fast DOM Snapshot Engine & Indexer

**Files:**
- Create: `packages/daemon/src/browser-snapshot.ts`
- Test: `packages/daemon/src/browser-snapshot.test.ts`
- Export: `packages/daemon/src/index.ts`

**Interfaces:**
- `export interface IndexedElement { index: number; id: number; role: string; label: string; tag: string; type?: string | undefined; value?: string | undefined; checked?: boolean | undefined; disabled?: boolean | undefined; }`
- `export interface SnapshotResult { url: string; title: string; elements: IndexedElement[]; formattedTable: string; }`
- `export const DOM_SNAPSHOT_SCRIPT: string`
- `export function formatIndexedElements(elements: IndexedElement[]): string`
- `export function parseSnapshotOutput(raw: unknown): SnapshotResult`

- [ ] **Step 1: Write failing tests for snapshot script and parser**

In `packages/daemon/src/browser-snapshot.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  formatIndexedElements,
  parseSnapshotOutput,
  DOM_SNAPSHOT_SCRIPT,
  type IndexedElement,
} from './browser-snapshot.js';

describe('DOM Snapshot Engine', () => {
  it('contains valid executable JavaScript script', () => {
    expect(typeof DOM_SNAPSHOT_SCRIPT).toBe('string');
    expect(DOM_SNAPSHOT_SCRIPT).toContain('window.__rhFast');
    expect(DOM_SNAPSHOT_SCRIPT).toContain('checkVisibility');
  });

  it('formats indexed elements into a compact terminal table', () => {
    const elements: IndexedElement[] = [
      { index: 1, id: 101, role: 'button', label: 'Deploy Preview', tag: 'BUTTON' },
      { index: 2, id: 102, role: 'textbox', label: 'API Key', tag: 'INPUT', value: '' },
      { index: 3, id: 103, role: 'link', label: 'Documentation', tag: 'A' },
    ];
    const table = formatIndexedElements(elements);
    expect(table).toContain('[1] button   Deploy Preview');
    expect(table).toContain('[2] textbox  API Key');
    expect(table).toContain('[3] link     Documentation');
  });

  it('parses raw snapshot output safely', () => {
    const raw = {
      url: 'https://example.com',
      title: 'Example Domain',
      elements: [
        { index: 1, id: 1, role: 'link', label: 'More information...', tag: 'A' },
      ],
    };
    const parsed = parseSnapshotOutput(raw);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.title).toBe('Example Domain');
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.formattedTable).toContain('[1] link     More information...');
  });

  it('handles empty or malformed raw output gracefully', () => {
    const parsed = parseSnapshotOutput(null);
    expect(parsed.url).toBe('');
    expect(parsed.title).toBe('');
    expect(parsed.elements).toHaveLength(0);
    expect(parsed.formattedTable).toBe('No interactive elements found.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/browser-snapshot.test.ts`
Expected: FAIL due to missing `browser-snapshot.ts` module.

- [ ] **Step 3: Implement `browser-snapshot.ts`**

Create `packages/daemon/src/browser-snapshot.ts`:
```typescript
export interface IndexedElement {
  index: number;
  id: number;
  role: string;
  label: string;
  tag: string;
  type?: string | undefined;
  value?: string | undefined;
  checked?: boolean | undefined;
  disabled?: boolean | undefined;
}

export interface SnapshotResult {
  url: string;
  title: string;
  elements: IndexedElement[];
  formattedTable: string;
}

export const DOM_SNAPSHOT_SCRIPT = `
(() => {
  if (!document.body) return { url: location.href, title: document.title, elements: [] };
  const cache = (window.__rhFast = window.__rhFast || { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identify = (el) => {
    if (!cache.ids.has(el)) cache.ids.set(el, cache.next++);
    const id = cache.ids.get(el);
    cache.nodes.set(id, el);
    return id;
  };
  for (const [id, node] of cache.nodes) {
    if (!node.isConnected) cache.nodes.delete(id);
  }

  const isVisible = (el) => {
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const getAccessibleName = (el, seen = new Set()) => {
    if (!el || seen.has(el)) return '';
    seen.add(el);
    const labelledby = (el.getAttribute('aria-labelledby') || '').trim();
    if (labelledby) {
      const names = labelledby.split(/\\s+/).map(id => {
        const ref = document.getElementById(id);
        return ref ? getAccessibleName(ref, seen) : '';
      }).filter(Boolean);
      if (names.length) return names.join(' ');
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    if (el.labels && el.labels.length > 0) {
      const labelText = Array.from(el.labels).map(l => getAccessibleName(l, seen)).filter(Boolean).join(' ');
      if (labelText) return labelText;
    }
    if (['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value.trim();
    if (el.alt) return el.alt.trim();
    if (el.title) return el.title.trim();
    if (el.placeholder) return el.placeholder.trim();
    if (el.tagName !== 'INPUT') {
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) return text.slice(0, 100);
    }
    return '';
  };

  const interactiveRoles = [
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
    'combobox', 'textbox', 'searchbox', 'spinbutton', 'option'
  ];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    interactiveRoles.map(r => '[role="' + r + '"]').join(',');

  const determineRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit && interactiveRoles.includes(explicit)) return explicit;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A') return 'link';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(type)) return type;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return 'element';
  };

  const elements = [];
  let indexCounter = 1;
  const nodes = Array.from(document.querySelectorAll(selector));

  for (const node of nodes) {
    if (node.type === 'hidden' || node.type === 'password' && node.disabled) continue;
    if (!isVisible(node)) continue;
    const id = identify(node);
    const role = determineRole(node);
    const label = getAccessibleName(node);
    const value = node.value !== undefined ? String(node.value) : undefined;
    const item = {
      index: indexCounter++,
      id,
      role,
      label,
      tag: node.tagName,
      type: node.type || undefined,
      value: value && value.length > 50 ? value.slice(0, 47) + '...' : value,
      checked: node.checked !== undefined ? Boolean(node.checked) : undefined,
      disabled: Boolean(node.disabled),
    };
    elements.push(item);
  }

  return {
    url: location.href,
    title: document.title,
    elements,
  };
})()
`;

export function formatIndexedElements(elements: IndexedElement[]): string {
  if (!elements || elements.length === 0) {
    return 'No interactive elements found.';
  }
  const rows: string[] = [];
  for (const el of elements) {
    const indexStr = `[${el.index}]`.padEnd(5, ' ');
    const roleStr = el.role.padEnd(10, ' ');
    const labelStr = el.label || '(unlabeled)';
    let extra = '';
    if (el.value !== undefined && el.value !== '') {
      extra += ` · value="${el.value}"`;
    }
    if (el.checked !== undefined) {
      extra += el.checked ? ' [checked]' : ' [unchecked]';
    }
    if (el.disabled) {
      extra += ' [disabled]';
    }
    rows.push(`${indexStr} ${roleStr} ${labelStr}${extra}`);
  }
  return rows.join('\n');
}

export function parseSnapshotOutput(raw: unknown): SnapshotResult {
  if (!raw || typeof raw !== 'object') {
    return {
      url: '',
      title: '',
      elements: [],
      formattedTable: 'No interactive elements found.',
    };
  }

  const obj = raw as Record<string, unknown>;
  const url = typeof obj.url === 'string' ? obj.url : '';
  const title = typeof obj.title === 'string' ? obj.title : '';
  const elementsRaw = Array.isArray(obj.elements) ? obj.elements : [];

  const elements: IndexedElement[] = elementsRaw.map((e, idx) => {
    const item = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    return {
      index: typeof item.index === 'number' ? item.index : idx + 1,
      id: typeof item.id === 'number' ? item.id : idx + 1,
      role: typeof item.role === 'string' ? item.role : 'element',
      label: typeof item.label === 'string' ? item.label : '',
      tag: typeof item.tag === 'string' ? item.tag : '',
      type: typeof item.type === 'string' ? item.type : undefined,
      value: typeof item.value === 'string' ? item.value : undefined,
      checked: typeof item.checked === 'boolean' ? item.checked : undefined,
      disabled: typeof item.disabled === 'boolean' ? item.disabled : undefined,
    };
  });

  return {
    url,
    title,
    elements,
    formattedTable: formatIndexedElements(elements),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/src/browser-snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: Export from `packages/daemon/src/index.ts` and commit**

Export `IndexedElement`, `SnapshotResult`, `DOM_SNAPSHOT_SCRIPT`, `formatIndexedElements`, and `parseSnapshotOutput`.
Run:
```bash
git add packages/daemon/src/browser-snapshot.ts packages/daemon/src/browser-snapshot.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): add fast dom snapshot engine and indexer"
```

---

### Task 2: CDP Node Action Dispatcher

**Files:**
- Create: `packages/daemon/src/browser-driver.ts`
- Test: `packages/daemon/src/browser-driver.test.ts`
- Export: `packages/daemon/src/index.ts`

**Interfaces:**
- `export interface BrowserDriverOptions { cdpUrl?: string | undefined; }`
- `export class BrowserDriver`
  - `snapshot(): Promise<SnapshotResult>`
  - `clickIndex(index: number): Promise<{ success: boolean; label: string }>`
  - `typeIndex(index: number, text: string): Promise<{ success: boolean; label: string }>`
  - `openUrl(url: string): Promise<{ success: boolean; url: string }>`
  - `listTabs(): Promise<Array<{ id: string; title: string; url: string }>>`

- [ ] **Step 1: Write failing tests for BrowserDriver**

In `packages/daemon/src/browser-driver.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserDriver } from './browser-driver.js';

describe('BrowserDriver', () => {
  let driver: BrowserDriver;
  const mockTabs = [
    { id: 'tab-1', type: 'page', title: 'Home', url: 'https://example.com', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1' },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('discovers tabs from CDP HTTP endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTabs,
    }));
    driver = new BrowserDriver({ cdpUrl: 'http://127.0.0.1:9222' });
    const tabs = await driver.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.title).toBe('Home');
  });

  it('rejects invalid action indices with descriptive error', async () => {
    driver = new BrowserDriver({ cdpUrl: 'http://127.0.0.1:9222' });
    vi.spyOn(driver as any, 'executeScript').mockResolvedValue({
      url: 'https://example.com',
      title: 'Home',
      elements: [{ index: 1, id: 1, role: 'button', label: 'Submit', tag: 'BUTTON' }],
    });
    await expect(driver.clickIndex(99)).rejects.toThrow(/Index 99 not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/browser-driver.test.ts`
Expected: FAIL due to missing `browser-driver.ts`.

- [ ] **Step 3: Implement `browser-driver.ts`**

Create `packages/daemon/src/browser-driver.ts`:
```typescript
import { DOM_SNAPSHOT_SCRIPT, parseSnapshotOutput, type SnapshotResult, type IndexedElement } from './browser-snapshot.js';

export interface BrowserDriverOptions {
  cdpUrl?: string | undefined;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string | undefined;
}

export class BrowserDriver {
  private cdpUrl: string;

  constructor(options?: BrowserDriverOptions) {
    this.cdpUrl = (options?.cdpUrl || 'http://127.0.0.1:9222').replace(/\/+$/, '');
  }

  async listTabs(): Promise<BrowserTab[]> {
    const res = await fetch(`${this.cdpUrl}/json`);
    if (!res.ok) {
      throw new Error(`Failed to list CDP targets: ${res.statusText}`);
    }
    const data = (await res.json()) as Array<Record<string, unknown>>;
    return data
      .filter((t) => t.type === 'page')
      .map((t) => ({
        id: String(t.id || ''),
        title: String(t.title || ''),
        url: String(t.url || ''),
        webSocketDebuggerUrl: typeof t.webSocketDebuggerUrl === 'string' ? t.webSocketDebuggerUrl : undefined,
      }));
  }

  async getActiveTab(): Promise<BrowserTab> {
    const tabs = await this.listTabs();
    if (tabs.length === 0) {
      throw new Error('No open Chrome tabs found on CDP port');
    }
    return tabs[0]!;
  }

  private async executeScript<T>(script: string): Promise<T> {
    const tab = await this.getActiveTab();
    const wsUrl = tab.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error('Active tab does not provide webSocketDebuggerUrl');
    }

    const { WebSocket } = await import('ws');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const id = 1;
      const timeout = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP execution timed out after 5000ms'));
      }, 5000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
              expression: script,
              returnByValue: true,
              awaitPromise: true,
            },
          }),
        );
      });

      ws.on('message', (data: Buffer) => {
        clearTimeout(timeout);
        try {
          const res = JSON.parse(data.toString());
          if (res.id === id) {
            ws.close();
            if (res.error) {
              reject(new Error(res.error.message || 'CDP execution failed'));
            } else if (res.result?.exceptionDetails) {
              reject(new Error(res.result.exceptionDetails.text || 'JavaScript exception during execution'));
            } else {
              resolve(res.result?.result?.value as T);
            }
          }
        } catch (err) {
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async snapshot(): Promise<SnapshotResult> {
    const raw = await this.executeScript<unknown>(DOM_SNAPSHOT_SCRIPT);
    return parseSnapshotOutput(raw);
  }

  async clickIndex(index: number): Promise<{ success: boolean; label: string }> {
    const snap = await this.snapshot();
    const target = snap.elements.find((e) => e.index === index);
    if (!target) {
      throw new Error(`Index ${index} not found. Run snapshot to view current indexed elements.`);
    }

    const clickScript = `
      (() => {
        const node = window.__rhFast?.nodes.get(${target.id});
        if (!node) throw new Error('Target node no longer connected');
        node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        node.focus();
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        node.click();
        return true;
      })()
    `;
    await this.executeScript<boolean>(clickScript);
    return { success: true, label: target.label || target.role };
  }

  async typeIndex(index: number, text: string): Promise<{ success: boolean; label: string }> {
    const snap = await this.snapshot();
    const target = snap.elements.find((e) => e.index === index);
    if (!target) {
      throw new Error(`Index ${index} not found. Run snapshot to view current indexed elements.`);
    }

    const escaped = JSON.stringify(text);
    const typeScript = `
      (() => {
        const node = window.__rhFast?.nodes.get(${target.id});
        if (!node) throw new Error('Target node no longer connected');
        node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        node.focus();
        if (typeof node.select === 'function') node.select();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${escaped});
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `;
    await this.executeScript<boolean>(typeScript);
    return { success: true, label: target.label || target.role };
  }

  async openUrl(url: string): Promise<{ success: boolean; url: string }> {
    const tab = await this.getActiveTab();
    const wsUrl = tab.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('No WebSocket URL for active tab');

    const { WebSocket } = await import('ws');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const id = 2;
      const timeout = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('Navigation timed out after 10000ms'));
      }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ id, method: 'Page.navigate', params: { url } }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const res = JSON.parse(data.toString());
          if (res.id === id) {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true, url });
          }
        } catch {}
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/src/browser-driver.test.ts`
Expected: PASS

- [ ] **Step 5: Export from `packages/daemon/src/index.ts` and commit**

Run:
```bash
git add packages/daemon/src/browser-driver.ts packages/daemon/src/browser-driver.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): add cdp node action dispatcher"
```

---

### Task 3: CLI Subcommand Integration for `rh browser`

**Files:**
- Modify: `packages/cli/src/commands/browser.ts`
- Test: `packages/cli/src/commands/browser.test.ts`

**Interfaces:**
- `rh browser snapshot`: outputs indexed element table
- `rh browser click <index>`: clicks indexed element
- `rh browser type <index> <text>`: enters text into indexed element
- `rh browser open <url>`: opens URL in current tab
- `rh browser tabs`: lists open tabs

- [ ] **Step 1: Write failing CLI tests for browser subcommands**

In `packages/cli/src/commands/browser.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { browserCommand } from './browser.js';

describe('browserCommand subcommands', () => {
  let stdoutMessages: string[] = [];
  let stderrMessages: string[] = [];

  beforeEach(() => {
    stdoutMessages = [];
    stderrMessages = [];
  });

  const ctx = {
    stdout: (m: string) => stdoutMessages.push(m),
    stderr: (m: string) => stderrMessages.push(m),
  };

  it('prints indexed snapshot table when given snapshot subcommand', async () => {
    vi.mock('@remote-hands/daemon', () => ({
      BrowserDriver: class {
        snapshot = vi.fn().mockResolvedValue({
          url: 'https://test.local',
          title: 'Test',
          formattedTable: '[1] button   Deploy',
        });
      },
    }));

    const code = await browserCommand(['snapshot'], ctx);
    expect(code).toBe(0);
    expect(stdoutMessages.join('\n')).toContain('[1] button   Deploy');
  });

  it('requires index argument for click subcommand', async () => {
    const code = await browserCommand(['click'], ctx);
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Usage: rh browser click <index>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/commands/browser.test.ts`
Expected: FAIL due to missing subcommand routing.

- [ ] **Step 3: Implement subcommands in `packages/cli/src/commands/browser.ts`**

Update `browserCommand` in `packages/cli/src/commands/browser.ts` to handle:
- `snapshot`
- `click <index>`
- `type <index> <text>`
- `open <url>`
- `tabs`
- Default fallback to `browser-harness` when non-subcommand arguments are supplied.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/cli/src/commands/browser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add packages/cli/src/commands/browser.ts packages/cli/src/commands/browser.test.ts
git commit -m "feat(cli): add snapshot, click, type subcommands to rh browser"
```

---

### Task 4: System Prompt & Skill Enhancement for `agy`

**Files:**
- Modify: `packages/daemon/src/agy-runner.ts`
- Modify: `.agents/skills/browser-harness/SKILL.md`
- Test: `packages/daemon/src/agy-runner.test.ts`

**Interfaces:**
- `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT`: instruct `agy` to use `rh browser snapshot`, `rh browser click <index>`, `rh browser type <index> <text>`, and `rh browser open <url>` for web tasks.
- `DEFAULT_REMOTE_HANDS_REMINDER`: include indexed browser command shortcuts.
- `.agents/skills/browser-harness/SKILL.md`: add indexed commands reference.

- [ ] **Step 1: Write failing prompt tests**

In `packages/daemon/src/agy-runner.test.ts`:
Verify that `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT` contains `rh browser snapshot` and `rh browser click`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Expected: FAIL due to missing prompt references.

- [ ] **Step 3: Update `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT` and `.agents/skills/browser-harness/SKILL.md`**

Update section 2 ("Browser Automation") in `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT`:
```text
2. Browser Automation:
   - For web and browser tasks, inspect and act instantly using indexed commands:
     rh browser open "<url>"
     rh browser snapshot
     rh browser click <index>
     rh browser type <index> "<text>"
   - For custom scripts, use `browser-harness <<'PY' ... PY`.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add packages/daemon/src/agy-runner.ts packages/daemon/src/agy-runner.test.ts .agents/skills/browser-harness/SKILL.md
git commit -m "feat(daemon): update system prompt and skills for indexed browser actions"
```

---

### Task 5: End-to-End Test for Cross-Domain Task Execution

**Files:**
- Create: `tests/e2e/indexed-browser-actions.test.ts`
- Modify: `tests/package.json`

**Interfaces:**
- Full simulated flow: file modification -> simulated git/build -> CDP indexed snapshot -> click action.

- [ ] **Step 1: Write the end-to-end integration test**

Verify that `BrowserDriver` correctly snapshots an HTML fixture and clicks the element by index.

- [ ] **Step 2: Run the test suite**

Run: `npx vitest run tests/e2e/indexed-browser-actions.test.ts`
Expected: PASS

- [ ] **Step 3: Commit changes**

```bash
git add tests/e2e/indexed-browser-actions.test.ts
git commit -m "test(e2e): add test for indexed browser actions"
```
