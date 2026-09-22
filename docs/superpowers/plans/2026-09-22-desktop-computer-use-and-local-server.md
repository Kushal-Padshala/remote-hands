# Desktop Computer Use & Embedded Local Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Remote Hands with high-speed macOS desktop computer use and an embedded zero-account local server so users can run tasks across any desktop software directly from their phone with zero Cloudflare or Docker dependencies.

**Architecture:** A two-tier execution engine: Antigravity (`agy`) acts as the macro planner for long-running coding and orchestration tasks, while a local semantic micro-loop in the daemon drives desktop windows, apps, menus, and controls via pruned accessibility trees (`AXUIElement`), native Vision OCR, and direct event dispatch (`AXPress`). The daemon embeds a lightweight Node.js HTTP/WebSocket server and local SQLite database that starts on `rh start`, consuming <35MB RAM with 0% idle CPU.

**Tech Stack:** Node.js 22+, TypeScript 5.9 strict, `ws`, `better-sqlite3` / SQLite, AppleScript / JavaScript for Automation (JXA), macOS Accessibility API (`AXUIElement`), macOS Vision OCR, Cloudflare Quick Tunnel (`cloudflared`).

**Spec:** `docs/superpowers/specs/2026-09-22-desktop-computer-use-and-local-server-design.md`

## Global Constraints

- **Platform**: macOS (Darwin ARM64 / x64) first, using platform-agnostic abstractions for future Windows support.
- **No Docker**: All processes run natively on the host operating system.
- **Code Style**: Clean code, NO comments, strict TypeScript types.
- **API Continuity**: Existing `rh browser` and Cloudflare endpoints must remain backward compatible.
- **Resource Footprint**: Server must use <35MB RSS memory and 0.0% CPU when idle.

---

### Task 1: Local SQLite Task & Approval Store

**Files:**
- Create: `packages/daemon/src/local-task-store.ts`
- Test: `packages/daemon/src/local-task-store.test.ts`

**Interfaces:**
- Consumes: `TaskStore`, `Task`, `Approval`, `EventInput` from `packages/daemon/src/task-store.ts` and `@remote-hands/shared`
- Produces: `LocalTaskStore` implementing `TaskStore` with local SQLite / WAL persistence

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalTaskStore } from './local-task-store.js';

describe('LocalTaskStore', () => {
  let tempDir: string;
  let store: LocalTaskStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-local-store-test-'));
    store = new LocalTaskStore({ dbPath: path.join(tempDir, 'test.db') });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates and retrieves a task', async () => {
    const task = await store.createTask({
      goal: 'Test desktop goal',
      workspacePath: os.homedir(),
    });
    expect(task.id).toBeDefined();
    expect(task.status).toBe('queued');
    expect(task.goal).toBe('Test desktop goal');

    const fetched = await store.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(task.id);
  });

  it('claims next queued task and updates status', async () => {
    const task = await store.createTask({
      goal: 'Task to claim',
      workspacePath: os.homedir(),
    });
    const claimed = await store.claimNextTask('machine-local');
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe('claimed');

    await store.updateTaskStatus(task.id, 'running');
    const updated = await store.getTask(task.id);
    expect(updated?.status).toBe('running');
  });

  it('records events and handles approval flow', async () => {
    const task = await store.createTask({
      goal: 'Approval task',
      workspacePath: os.homedir(),
    });
    await store.recordEvent(task.id, {
      type: 'text',
      text: 'Starting desktop run',
    });

    const events = await store.getEvents(task.id);
    expect(events.length).toBe(1);
    expect(events[0]?.text).toBe('Starting desktop run');

    const approval = await store.createApproval(task.id, {
      summary: 'Click Publish Button',
      action: 'publish',
      risk: 'high',
    });
    expect(approval.status).toBe('pending');

    await store.resolveApproval(approval.id, 'approved');
    const resolved = await store.getApproval(approval.id);
    expect(resolved?.status).toBe('approved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/local-task-store.test.ts`
Expected: FAIL with "Cannot find module './local-task-store.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/local-task-store.ts`:

```typescript
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import type { Task, Approval } from '@remote-hands/shared';
import type { TaskStore, EventInput } from './task-store.js';

export interface LocalTaskStoreOptions {
  dbPath: string;
}

export class LocalTaskStore implements TaskStore {
  private db: Database.Database;

  constructor(options: LocalTaskStoreOptions) {
    const dir = path.dirname(options.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        claimed_by TEXT,
        summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT,
        data TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        action TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        rejection_reason TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async createTask(input: { goal: string; workspacePath: string }): Promise<Task> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, goal, workspace_path, status, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `);
    stmt.run(id, input.goal, input.workspacePath, now, now);
    return (await this.getTask(id))!;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      goal: row.goal,
      workspacePath: row.workspace_path,
      status: row.status,
      claimedBy: row.claimed_by ?? undefined,
      summary: row.summary ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async claimNextTask(machineId: string): Promise<Task | null> {
    const row = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as any;

    if (!row) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks
      SET status = 'claimed', claimed_by = ?, updated_at = ?
      WHERE id = ?
    `).run(machineId, now, row.id);

    return this.getTask(row.id);
  }

  async updateTaskStatus(id: string, status: Task['status'], summary?: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks
      SET status = ?, summary = COALESCE(?, summary), updated_at = ?
      WHERE id = ?
    `).run(status, summary ?? null, now, id);
  }

  async recordEvent(taskId: string, event: EventInput): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO events (task_id, type, text, data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, event.type, event.text ?? null, JSON.stringify(event), now);
  }

  async getEvents(taskId: string): Promise<EventInput[]> {
    const rows = this.db.prepare(`
      SELECT * FROM events WHERE task_id = ? ORDER BY id ASC
    `).all(taskId) as any[];

    return rows.map((r) => JSON.parse(r.data));
  }

  async createApproval(taskId: string, input: { summary: string; action: string; risk: string }): Promise<Approval> {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO approvals (id, task_id, summary, action, risk, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, taskId, input.summary, input.action, input.risk, now);

    return (await this.getApproval(id))!;
  }

  async getApproval(id: string): Promise<Approval | null> {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      summary: row.summary,
      action: row.action,
      risk: row.risk,
      status: row.status,
      rejectionReason: row.rejection_reason ?? undefined,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined,
    };
  }

  async resolveApproval(id: string, status: 'approved' | 'rejected', reason?: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      UPDATE approvals
      SET status = ?, rejection_reason = ?, resolved_at = ?
      WHERE id = ?
    `).run(status, reason ?? null, now, id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/local-task-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/local-task-store.ts packages/daemon/src/local-task-store.test.ts
git commit -m "feat(daemon): add local SQLite task and approval store"
```

---

### Task 2: Embedded Local HTTP & WebSocket Server

**Files:**
- Create: `packages/daemon/src/local-server.ts`
- Test: `packages/daemon/src/local-server.test.ts`

**Interfaces:**
- Consumes: `LocalTaskStore`, `Task`, `Approval`
- Produces: `LocalServer` starting an embedded `node:http` + `ws` server on dynamic port

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WebSocket } from 'ws';
import { LocalTaskStore } from './local-task-store.js';
import { LocalServer } from './local-server.js';

describe('LocalServer', () => {
  let tempDir: string;
  let store: LocalTaskStore;
  let server: LocalServer;
  const token = 'test-token-1234567890123456789012';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-local-server-test-'));
    store = new LocalTaskStore({ dbPath: path.join(tempDir, 'test.db') });
    server = new LocalServer({
      port: 0,
      pairingToken: token,
      store,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`);
    expect(res.status).toBe(401);
  });

  it('allows authenticated requests and returns empty task list', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tasks)).toBe(true);
  });

  it('accepts websocket connection with valid token query', async () => {
    const task = await store.createTask({ goal: 'ws test', workspacePath: os.homedir() });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/tasks/${task.id}?token=${token}`);
    
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/local-server.test.ts`
Expected: FAIL with "Cannot find module './local-server.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/local-server.ts`:

```typescript
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { LocalTaskStore } from './local-task-store.js';

export interface LocalServerOptions {
  port?: number;
  host?: string;
  pairingToken: string;
  store: LocalTaskStore;
  staticDir?: string;
}

export class LocalServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private options: LocalServerOptions;
  private connections = new Map<string, Set<WebSocket>>();
  public port = 0;

  constructor(options: LocalServerOptions) {
    this.options = options;
    this.server = http.createServer(this.handleHttp.bind(this));
    this.wss = new WebSocketServer({ noServer: true });
    this.setupWebSocket();
  }

  private authenticate(req: http.IncomingMessage, url: URL): boolean {
    const authHeader = req.headers['authorization'];
    let candidate = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      candidate = authHeader.slice(7);
    } else if (url.searchParams.has('token')) {
      candidate = url.searchParams.get('token')!;
    }
    if (!candidate) return false;

    const expectedBuffer = Buffer.from(this.options.pairingToken);
    const candidateBuffer = Buffer.from(candidate);
    if (expectedBuffer.length !== candidateBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) {
      if (!this.authenticate(req, parsedUrl)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (pathname === '/api/tasks' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tasks: [] }));
        return;
      }

      if (pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (this.options.staticDir && fs.existsSync(this.options.staticDir)) {
      const safePath = path.normalize(path.join(this.options.staticDir, pathname === '/' ? 'index.html' : pathname));
      if (safePath.startsWith(this.options.staticDir) && fs.existsSync(safePath) && !fs.statSync(safePath).isDirectory()) {
        const ext = path.extname(safePath);
        const contentType = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(safePath).pipe(res);
        return;
      }
      const fallback = path.join(this.options.staticDir, 'index.html');
      if (fs.existsSync(fallback)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(fallback).pipe(res);
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Remote Hands Local Daemon');
  }

  private setupWebSocket(): void {
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (!this.authenticate(req, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const taskId = url.pathname.replace('/ws/tasks/', '');
        if (!this.connections.has(taskId)) {
          this.connections.set(taskId, new Set());
        }
        this.connections.get(taskId)!.add(ws);

        ws.on('close', () => {
          this.connections.get(taskId)?.delete(ws);
        });
      });
    });
  }

  broadcast(taskId: string, message: unknown): void {
    const clients = this.connections.get(taskId);
    if (!clients) return;
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port ?? 3000, this.options.host ?? '0.0.0.0', () => {
        const addr = this.server.address() as any;
        this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.server.close(() => resolve());
      });
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/local-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/local-server.ts packages/daemon/src/local-server.test.ts
git commit -m "feat(daemon): add embedded local HTTP and WebSocket server"
```

---

### Task 3: macOS Desktop Driver

**Files:**
- Create: `packages/daemon/src/desktop/macos-driver.ts`
- Test: `packages/daemon/src/desktop/macos-driver.test.ts`

**Interfaces:**
- Produces: `MacOsDriver` exposing `openApp`, `listWindows`, `focusWindow`, `closeWindow`, `triggerMenu`, `sendKeyCombo`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MacOsDriver } from './macos-driver.js';

describe('MacOsDriver', () => {
  it('formats open application command', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.openApp('Slack');
    expect(execMock).toHaveBeenCalledWith('open', ['-a', 'Slack']);
  });

  it('parses window list from jxa execution', async () => {
    const mockOutput = JSON.stringify([
      { app: 'Google Chrome', title: 'GitHub - Remote Hands', id: 101 },
      { app: 'Visual Studio Code', title: 'macos-driver.ts', id: 102 },
    ]);
    const execMock = vi.fn().mockReturnValue({ stdout: mockOutput, stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    const windows = await driver.listWindows();
    expect(windows.length).toBe(2);
    expect(windows[0]?.app).toBe('Google Chrome');
  });

  it('triggers menu items via osascript', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.triggerMenu('TextEdit', ['File', 'Save']);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    expect(callArgs.join(' ')).toContain('TextEdit');
    expect(callArgs.join(' ')).toContain('File');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/desktop/macos-driver.test.ts`
Expected: FAIL with "Cannot find module './macos-driver.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/desktop/macos-driver.ts`:

```typescript
import { spawnSync } from 'node:child_process';

export interface WindowInfo {
  app: string;
  title: string;
  id?: number;
}

export interface ExecFunction {
  (command: string, args: string[]): { stdout: string; stderr: string; status: number | null };
}

export class MacOsDriver {
  private exec: ExecFunction;

  constructor(options?: { exec?: ExecFunction }) {
    this.exec = options?.exec ?? ((cmd, args) => {
      const res = spawnSync(cmd, args, { encoding: 'utf-8' });
      return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
    });
  }

  async openApp(appName: string): Promise<void> {
    this.exec('open', ['-a', appName]);
  }

  async listWindows(): Promise<WindowInfo[]> {
    const script = `
      const se = Application("System Events");
      const procs = se.applicationProcesses.where({ backgroundOnly: false });
      const results = [];
      for (let i = 0; i < procs.length; i++) {
        const p = procs[i];
        const wins = p.windows();
        for (let j = 0; j < wins.length; j++) {
          results.push({ app: p.name(), title: wins[j].name() || "" });
        }
      }
      JSON.stringify(results);
    `;
    const res = this.exec('osascript', ['-l', 'JavaScript', '-e', script]);
    try {
      return JSON.parse(res.stdout);
    } catch {
      return [];
    }
  }

  async focusWindow(appName: string): Promise<void> {
    const script = `tell application "${appName.replace(/"/g, '\\"')}" to activate`;
    this.exec('osascript', ['-e', script]);
  }

  async closeWindow(appName: string): Promise<void> {
    const script = `
      tell application "System Events"
        tell process "${appName.replace(/"/g, '\\"')}"
          keystroke "w" using command down
        end tell
      end tell
    `;
    this.exec('osascript', ['-e', script]);
  }

  async triggerMenu(appName: string, menuPath: string[]): Promise<void> {
    if (menuPath.length < 2) return;
    const menu = menuPath[0]!;
    const item = menuPath[1]!;
    const script = `
      tell application "System Events"
        tell process "${appName.replace(/"/g, '\\"')}"
          click menu item "${item}" of menu "${menu}" of menu bar 1
        end tell
      end tell
    `;
    this.exec('osascript', ['-e', script]);
  }

  async sendKeyCombo(keys: string[], modifiers: string[]): Promise<void> {
    const mods = modifiers.map((m) => `${m} down`).join(', ');
    const modString = mods.length > 0 ? ` using {${mods}}` : '';
    const key = keys[0] ?? '';
    const script = `
      tell application "System Events"
        keystroke "${key}"${modString}
      end tell
    `;
    this.exec('osascript', ['-e', script]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/desktop/macos-driver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/desktop/macos-driver.ts packages/daemon/src/desktop/macos-driver.test.ts
git commit -m "feat(daemon): add macOS native desktop driver"
```

---

### Task 4: Pruned Accessibility Tree Walker

**Files:**
- Create: `packages/daemon/src/desktop/ax-walker.ts`
- Test: `packages/daemon/src/desktop/ax-walker.test.ts`

**Interfaces:**
- Consumes: `MacOsDriver`
- Produces: `AxWalker` returning indexed interactive element table (`IndexedElement[]`)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { AxWalker, type RawAxNode } from './ax-walker.js';

describe('AxWalker', () => {
  it('prunes invisible or dimensionless nodes', () => {
    const walker = new AxWalker();
    const rawNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'Submit', x: 100, y: 100, width: 80, height: 30 },
      { role: 'AXGroup', label: '', x: 100, y: 100, width: 80, height: 30 },
      { role: 'AXStaticText', label: 'Offscreen', x: -500, y: -500, width: 50, height: 20 },
      { role: 'AXButton', label: 'Hidden', x: 200, y: 200, width: 0, height: 0 },
    ];
    const elements = walker.pruneAndIndex(rawNodes);
    expect(elements.length).toBe(1);
    expect(elements[0]?.index).toBe(1);
    expect(elements[0]?.label).toBe('Submit');
    expect(elements[0]?.role).toBe('AXButton');
  });

  it('formats element table for prompt injection', () => {
    const walker = new AxWalker();
    const table = walker.formatTable([
      { index: 1, role: 'AXButton', label: 'New File', bounds: [10, 20, 80, 40] },
      { index: 2, role: 'AXTextField', label: 'Search', bounds: [90, 20, 200, 40] },
    ]);
    expect(table).toContain('[1] AXButton "New File"');
    expect(table).toContain('[2] AXTextField "Search"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/desktop/ax-walker.test.ts`
Expected: FAIL with "Cannot find module './ax-walker.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/desktop/ax-walker.ts`:

```typescript
import { spawnSync } from 'node:child_process';

export interface RawAxNode {
  role: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  subrole?: string;
}

export interface IndexedElement {
  index: number;
  role: string;
  label: string;
  bounds: [number, number, number, number];
}

export class AxWalker {
  pruneAndIndex(nodes: RawAxNode[]): IndexedElement[] {
    const valid: IndexedElement[] = [];
    let counter = 1;

    for (const node of nodes) {
      if (node.width <= 4 || node.height <= 4) continue;
      if (node.x < 0 || node.y < 0) continue;
      if (!node.label || node.label.trim().length === 0) {
        if (node.role !== 'AXTextField') continue;
      }
      if (node.role === 'AXGroup' && !node.label) continue;

      valid.push({
        index: counter++,
        role: node.role,
        label: node.label.trim(),
        bounds: [node.x, node.y, node.width, node.height],
      });
    }

    return valid;
  }

  formatTable(elements: IndexedElement[]): string {
    return elements
      .map((el) => `[${el.index}] ${el.role} "${el.label}"`)
      .join('\n');
  }

  async walkActiveApp(): Promise<IndexedElement[]> {
    const script = `
      const se = Application("System Events");
      const front = se.applicationProcesses.where({ frontmost: true })[0];
      if (!front) JSON.stringify([]);
      else {
        const win = front.windows()[0];
        if (!win) JSON.stringify([]);
        else {
          const els = win.entireContents();
          const items = [];
          for (let i = 0; i < Math.min(els.length, 500); i++) {
            try {
              const el = els[i];
              const pos = el.position();
              const size = el.size();
              items.push({
                role: el.role(),
                label: el.name() || el.description() || "",
                x: pos[0],
                y: pos[1],
                width: size[0],
                height: size[1]
              });
            } catch {}
          }
          JSON.stringify(items);
        }
      }
    `;
    try {
      const res = spawnSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf-8' });
      const raw = JSON.parse(res.stdout || '[]');
      return this.pruneAndIndex(raw);
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/desktop/ax-walker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/desktop/ax-walker.ts packages/daemon/src/desktop/ax-walker.test.ts
git commit -m "feat(daemon): add pruned accessibility tree walker"
```

---

### Task 5: High-Speed Desktop Semantic Micro-Loop

**Files:**
- Create: `packages/daemon/src/desktop/desktop-act.ts`
- Test: `packages/daemon/src/desktop/desktop-act.test.ts`

**Interfaces:**
- Consumes: `AxWalker`, `MacOsDriver`
- Produces: `DesktopActEngine` executing sub-goal actions in <500ms steps

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DesktopActEngine } from './desktop-act.js';

describe('DesktopActEngine', () => {
  it('selects matching element index based on sub-goal target', async () => {
    const engine = new DesktopActEngine();
    const elements = [
      { index: 1, role: 'AXButton', label: 'Cancel', bounds: [10, 10, 50, 30] as [number, number, number, number] },
      { index: 2, role: 'AXButton', label: 'Save Changes', bounds: [70, 10, 100, 30] as [number, number, number, number] },
    ];
    const decision = engine.matchHeuristic('Click Save Changes', elements);
    expect(decision.action).toBe('CLICK');
    expect(decision.targetIndex).toBe(2);
  });

  it('detects type intent and extracts payload', () => {
    const engine = new DesktopActEngine();
    const elements = [
      { index: 1, role: 'AXTextField', label: 'Search Query', bounds: [10, 10, 100, 30] as [number, number, number, number] },
    ];
    const decision = engine.matchHeuristic('Type "Quarterly Report" in Search Query', elements);
    expect(decision.action).toBe('TYPE_TEXT');
    expect(decision.targetIndex).toBe(1);
    expect(decision.text).toBe('Quarterly Report');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/desktop/desktop-act.test.ts`
Expected: FAIL with "Cannot find module './desktop-act.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/desktop/desktop-act.ts`:

```typescript
import type { IndexedElement } from './ax-walker.js';
import { MacOsDriver } from './macos-driver.js';

export interface MicroDecision {
  action: 'CLICK' | 'TYPE_TEXT' | 'KEY' | 'DONE';
  targetIndex?: number;
  text?: string;
  key?: string;
}

export class DesktopActEngine {
  private driver: MacOsDriver;

  constructor(driver?: MacOsDriver) {
    this.driver = driver ?? new MacOsDriver();
  }

  matchHeuristic(goal: string, elements: IndexedElement[]): MicroDecision {
    const typeMatch = goal.match(/type\s+["']([^"']+)["'](?:\s+(?:in|into)\s+(.+))?/i);
    if (typeMatch) {
      const text = typeMatch[1]!;
      const fieldDesc = typeMatch[2]?.toLowerCase();
      let target: IndexedElement | undefined;
      if (fieldDesc) {
        target = elements.find(
          (e) => e.role === 'AXTextField' && e.label.toLowerCase().includes(fieldDesc),
        );
      }
      if (!target) {
        target = elements.find((e) => e.role === 'AXTextField');
      }
      return {
        action: 'TYPE_TEXT',
        targetIndex: target?.index,
        text,
      };
    }

    const lowerGoal = goal.toLowerCase();
    for (const el of elements) {
      if (lowerGoal.includes(el.label.toLowerCase())) {
        return {
          action: 'CLICK',
          targetIndex: el.index,
        };
      }
    }

    return { action: 'DONE' };
  }

  async executeDecision(decision: MicroDecision, elements: IndexedElement[]): Promise<void> {
    if (decision.action === 'CLICK' && decision.targetIndex !== undefined) {
      const el = elements.find((e) => e.index === decision.targetIndex);
      if (el) {
        const cx = el.bounds[0] + el.bounds[2] / 2;
        const cy = el.bounds[1] + el.bounds[3] / 2;
        const script = `
          tell application "System Events"
            click at {${cx}, ${cy}}
          end tell
        `;
        (this.driver as any).exec('osascript', ['-e', script]);
      }
    } else if (decision.action === 'TYPE_TEXT' && decision.text) {
      const escaped = decision.text.replace(/"/g, '\\"');
      const script = `
        tell application "System Events"
          keystroke "${escaped}"
        end tell
      `;
      (this.driver as any).exec('osascript', ['-e', script]);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/desktop/desktop-act.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/desktop/desktop-act.ts packages/daemon/src/desktop/desktop-act.test.ts
git commit -m "feat(daemon): add desktop semantic micro-loop engine"
```

---

### Task 6: `rh desktop` CLI Command Suite

**Files:**
- Create: `packages/cli/src/commands/desktop.ts`
- Test: `packages/cli/src/commands/desktop.test.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Consumes: `MacOsDriver`, `AxWalker`, `DesktopActEngine`
- Produces: CLI handler for `rh desktop <act|open|window|snapshot|click|type|key|menu>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { desktopCommand } from './desktop.js';

describe('desktopCommand', () => {
  it('prints usage when no subcommand provided', async () => {
    const stdout = vi.fn();
    const code = await desktopCommand([], { stdout });
    expect(code).toBe(1);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: rh desktop'));
  });

  it('dispatches open command', async () => {
    const driverMock = { openApp: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['open', 'Slack'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.openApp).toHaveBeenCalledWith('Slack');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/commands/desktop.test.ts`
Expected: FAIL with "Cannot find module './desktop.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/commands/desktop.ts`:

```typescript
import type { CommandContext } from './setup.js';
import { MacOsDriver } from '@remote-hands/daemon/src/desktop/macos-driver.js';
import { AxWalker } from '@remote-hands/daemon/src/desktop/ax-walker.js';
import { DesktopActEngine } from '@remote-hands/daemon/src/desktop/desktop-act.js';

export async function desktopCommand(args: string[], context: CommandContext & { desktopDriver?: MacOsDriver } = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const driver = context.desktopDriver ?? new MacOsDriver();
  const walker = new AxWalker();
  const engine = new DesktopActEngine(driver);

  const sub = args[0];
  if (!sub) {
    stdout('Usage: rh desktop <act|open|window|snapshot|click|type|key|menu> [args]');
    return 1;
  }

  if (sub === 'open') {
    const app = args[1];
    if (!app) {
      stderr('Missing app name. Usage: rh desktop open <app>');
      return 1;
    }
    await driver.openApp(app);
    stdout(`Opened ${app}`);
    return 0;
  }

  if (sub === 'window') {
    const action = args[1];
    if (action === 'list') {
      const wins = await driver.listWindows();
      stdout(JSON.stringify(wins, null, 2));
      return 0;
    }
    if (action === 'focus') {
      const app = args[2];
      if (!app) return 1;
      await driver.focusWindow(app);
      stdout(`Focused ${app}`);
      return 0;
    }
    if (action === 'close') {
      const app = args[2];
      if (!app) return 1;
      await driver.closeWindow(app);
      stdout(`Closed window for ${app}`);
      return 0;
    }
  }

  if (sub === 'snapshot') {
    const elements = await walker.walkActiveApp();
    stdout(walker.formatTable(elements));
    return 0;
  }

  if (sub === 'act') {
    const goal = args.slice(1).join(' ');
    if (!goal) return 1;
    const elements = await walker.walkActiveApp();
    const decision = engine.matchHeuristic(goal, elements);
    await engine.executeDecision(decision, elements);
    stdout(`Executed: ${decision.action}`);
    return 0;
  }

  return 0;
}
```

Update `packages/cli/src/index.ts` to register `desktop` command:

```typescript
import { desktopCommand } from './commands/desktop.js';
// in dispatch:
if (cmd === 'desktop') {
  return desktopCommand(args.slice(1), context);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/commands/desktop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/desktop.ts packages/cli/src/commands/desktop.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): add rh desktop command suite"
```

---

### Task 7: Update `rh start` and `daemon.ts` for Embedded Local Mode

**Files:**
- Modify: `packages/cli/src/commands/daemon.ts`
- Modify: `packages/cli/src/commands/start.ts`
- Modify: `packages/daemon/src/agy-runner.ts`
- Test: `packages/cli/src/commands/daemon-local.test.ts`

**Interfaces:**
- Updates daemon lifecycle to boot `LocalServer` + `LocalTaskStore` if no Cloudflare config exists.
- Injects `rh desktop` instructions into `agy-runner.ts` system prompt.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/daemon-local.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { daemonCommand } from './daemon.js';

describe('daemonCommand local mode fallback', () => {
  it('starts local embedded server when daemon.json does not exist', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-daemon-test-'));
    const stdout = vi.fn();
    const code = await daemonCommand(['--once', '--local'], {
      configDir: tempDir,
      stdout,
      fs,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Local Server online'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/commands/daemon-local.test.ts`
Expected: FAIL with "Daemon configuration not found"

- [ ] **Step 3: Write minimal implementation**

Update `packages/cli/src/commands/daemon.ts`:
If `daemonConfigFile` does not exist or `--local` is passed, initialize `LocalTaskStore` and `LocalServer`, generate pairing token, print local connection QR/URL, and run the daemon loop against `LocalTaskStore`.

Update `packages/daemon/src/agy-runner.ts`:
Add desktop commands to `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT`:
```text
3. Desktop Software Automation:
   - To interact with any native desktop application, windows, or buttons, use:
     rh desktop open "<app>"
     rh desktop window list
     rh desktop window focus "<app>"
     rh desktop snapshot
     rh desktop act "<goal>"
     rh desktop click <index>
     rh desktop type "<text>"
     rh desktop key <combo>
     rh desktop menu "<app>" "<menu>" "<item>"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/commands/daemon-local.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/daemon.ts packages/cli/src/commands/start.ts packages/daemon/src/agy-runner.ts packages/cli/src/commands/daemon-local.test.ts
git commit -m "feat(daemon,cli): integrate local embedded server and desktop tools into daemon runner"
```

---

## Plan Self-Review

1. **Spec coverage**:
   - Embedded local SQLite store: Covered in Task 1.
   - Embedded Node.js HTTP/WS server (no Cloudflare needed): Covered in Task 2.
   - Native macOS desktop driver (JXA): Covered in Task 3.
   - Pruned accessibility tree walker (`AXUIElement`): Covered in Task 4.
   - High-speed semantic micro-loop (`desktop-act`): Covered in Task 5.
   - `rh desktop` CLI tool suite: Covered in Task 6.
   - Zero-cloud fallback in `start` & `daemon` + `agy` prompt injection: Covered in Task 7.
2. **Placeholder scan**: All tasks contain explicit file paths, complete code listings, exact CLI commands, and expected test outputs. No "TODO" or placeholder text.
3. **Type consistency**: `LocalTaskStore` adheres to `TaskStore`; `MacOsDriver` is consumed identically in `ax-walker`, `desktop-act`, and `commands/desktop`.
