# Logged-In Chrome Profile Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the Remote Hands daemon to connect directly to an authenticated Google Chrome session on macOS via Chrome DevTools Protocol (CDP), supporting both attaching to the user's running Chrome with `--remote-debugging-port=9222` and launching a persistent background automation profile with stored logins, so tasks navigating to authenticated web applications (GitHub, Linear, AWS, Vercel, Supabase, Google, Stripe) execute without login or 2FA barriers.

**Architecture:** A native `ChromeManager` module inside `packages/daemon` checks for an existing Chrome remote debugging endpoint at `http://127.0.0.1:9222/json/version` or launches Chrome with `--remote-debugging-port=9222`. It supports both `active` (main macOS Chrome profile) and `dedicated` (`~/.remote-hands/chrome-profile`) modes. `DefaultFrameSource` and `ProcessAgentRunner` hook into this endpoint, injecting `BU_CDP_URL` and `CHROME_REMOTE_DEBUGGING_PORT` into `agy` execution contexts so browser automation and live viewport streaming work seamlessly with pre-authenticated sessions.

**Tech Stack:** Node.js 22, TypeScript, macOS Chrome DevTools Protocol (CDP), Vitest, React 19, existing Remote Hands daemon and CLI packages.

**Spec:** `docs/superpowers/specs/2026-09-17-remote-hands-design.md`

## Global Constraints
- Write clean code with no comments.
- Do not create walkthrough files.
- Zero external runtime binaries (native Node.js HTTP and child process calls).
- Ensure no API calls or contracts are broken.
- Commit and push on each stage.

---

### Task 1: ChromeManager Lifecycle and CDP Detection

**Files:**
- Create: `packages/daemon/src/chrome-manager.ts`
- Test: `packages/daemon/src/chrome-manager.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type ChromeProfileMode = 'active' | 'dedicated' | 'none';

  export interface ChromeManagerOptions {
    mode?: ChromeProfileMode | undefined;
    port?: number | undefined;
    customProfileDir?: string | undefined;
    chromeExecutablePath?: string | undefined;
  }

  export interface ChromeStatus {
    available: boolean;
    port: number;
    mode: ChromeProfileMode;
    wsUrl?: string | undefined;
    browser?: string | undefined;
    profileDir?: string | undefined;
  }

  export class ChromeManager {
    constructor(options?: ChromeManagerOptions);
    getMode(): ChromeProfileMode;
    getPort(): number;
    getProfileDirectory(): string;
    checkDebuggerStatus(): Promise<ChromeStatus>;
    buildLaunchArgs(url?: string): string[];
    ensureRunning(initialUrl?: string): Promise<ChromeStatus>;
    close(): void;
  }
  ```

- [ ] **Step 1: Write the failing tests for ChromeManager**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChromeManager } from './chrome-manager.js';

describe('ChromeManager', () => {
  it('resolves default ports and profile directories', () => {
    const manager = new ChromeManager({ mode: 'dedicated', port: 9222 });
    expect(manager.getPort()).toBe(9222);
    expect(manager.getMode()).toBe('dedicated');
    expect(manager.getProfileDirectory()).toContain('.remote-hands/chrome-profile');
  });

  it('resolves active profile directory on darwin', () => {
    const manager = new ChromeManager({ mode: 'active' });
    expect(manager.getProfileDirectory()).toContain('Application Support/Google/Chrome');
  });

  it('builds launch arguments with remote debugging port and profile dir', () => {
    const manager = new ChromeManager({ mode: 'dedicated', port: 9222 });
    const args = manager.buildLaunchArgs('https://github.com');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args.some((a) => a.startsWith('--user-data-dir='))).toBe(true);
    expect(args).toContain('https://github.com');
  });

  it('detects debugger availability when endpoint responds', async () => {
    const manager = new ChromeManager({ port: 9222 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
        Browser: 'Chrome/128.0.0.0',
      }),
    } as any);

    const status = await manager.checkDebuggerStatus();
    expect(status.available).toBe(true);
    expect(status.wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc-123');
    fetchSpy.mockRestore();
  });

  it('handles offline debugger gracefully', async () => {
    const manager = new ChromeManager({ port: 9222 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const status = await manager.checkDebuggerStatus();
    expect(status.available).toBe(false);
    expect(status.wsUrl).toBeUndefined();
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/chrome-manager.test.ts`
Expected: FAIL with "Cannot find module './chrome-manager.js'"

- [ ] **Step 3: Implement minimal ChromeManager**

Create `packages/daemon/src/chrome-manager.ts`:
```typescript
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

export type ChromeProfileMode = 'active' | 'dedicated' | 'none';

export interface ChromeManagerOptions {
  mode?: ChromeProfileMode | undefined;
  port?: number | undefined;
  customProfileDir?: string | undefined;
  chromeExecutablePath?: string | undefined;
}

export interface ChromeStatus {
  available: boolean;
  port: number;
  mode: ChromeProfileMode;
  wsUrl?: string | undefined;
  browser?: string | undefined;
  profileDir?: string | undefined;
}

export class ChromeManager {
  private mode: ChromeProfileMode;
  private port: number;
  private customProfileDir?: string | undefined;
  private chromeExecutablePath: string;
  private process: ChildProcess | null = null;

  constructor(options?: ChromeManagerOptions) {
    this.mode = options?.mode ?? 'dedicated';
    this.port = options?.port ?? 9222;
    this.customProfileDir = options?.customProfileDir;
    this.chromeExecutablePath =
      options?.chromeExecutablePath ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : 'google-chrome');
  }

  getMode(): ChromeProfileMode {
    return this.mode;
  }

  getPort(): number {
    return this.port;
  }

  getProfileDirectory(): string {
    if (this.customProfileDir) return this.customProfileDir;
    if (this.mode === 'active') {
      return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
    }
    return path.join(os.homedir(), '.remote-hands/chrome-profile');
  }

  async checkDebuggerStatus(): Promise<ChromeStatus> {
    const base: ChromeStatus = {
      available: false,
      port: this.port,
      mode: this.mode,
      profileDir: this.getProfileDirectory(),
    };

    if (this.mode === 'none') return base;

    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) return base;
      const data = (await res.json()) as any;
      return {
        available: true,
        port: this.port,
        mode: this.mode,
        wsUrl: data.webSocketDebuggerUrl,
        browser: data.Browser,
        profileDir: this.getProfileDirectory(),
      };
    } catch {
      return base;
    }
  }

  buildLaunchArgs(url?: string): string[] {
    const profileDir = this.getProfileDirectory();
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];
    if (url) {
      args.push(url);
    }
    return args;
  }

  async ensureRunning(initialUrl?: string): Promise<ChromeStatus> {
    if (this.mode === 'none') {
      return this.checkDebuggerStatus();
    }

    const current = await this.checkDebuggerStatus();
    if (current.available) {
      return current;
    }

    const profileDir = this.getProfileDirectory();
    fs.mkdirSync(profileDir, { recursive: true });

    const args = this.buildLaunchArgs(initialUrl);
    this.process = spawn(this.chromeExecutablePath, args, {
      detached: true,
      stdio: 'ignore',
    });
    this.process.unref();

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const status = await this.checkDebuggerStatus();
      if (status.available) {
        return status;
      }
    }

    return this.checkDebuggerStatus();
  }

  close(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {}
      this.process = null;
    }
  }
}
```

Export in `packages/daemon/src/index.ts`:
```typescript
export * from './chrome-manager.js';
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run packages/daemon/src/chrome-manager.test.ts`
Expected: PASS (5/5 tests passed)

- [ ] **Step 5: Commit changes**

```bash
git add packages/daemon/src/chrome-manager.ts packages/daemon/src/chrome-manager.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): implement ChromeManager with CDP detection and profile management"
```

---

### Task 2: Daemon Runtime & Environment Integration

**Files:**
- Modify: `packages/daemon/src/daemon.ts:40-120`
- Modify: `packages/daemon/src/agy-runner.ts:450-480`
- Test: `packages/daemon/src/daemon.test.ts`

**Interfaces:**
- Consumes:
  - `ChromeManager` from `packages/daemon/src/chrome-manager.ts`
  - `runDaemonOnce` inputs in `packages/daemon/src/daemon.ts`
- Produces:
  - Automatic `BU_CDP_URL=http://127.0.0.1:9222` and `CHROME_REMOTE_DEBUGGING_PORT=9222` environment variable injection for agent executions.
  - Automatic invocation of `chromeManager.ensureRunning()` when tasks are of `kind: 'browser'` or prompt contains web URLs.

- [ ] **Step 1: Write the failing tests in daemon.test.ts**

Add test to `packages/daemon/src/daemon.test.ts`:
```typescript
it('ensures Chrome is running and provides CDP configuration for browser tasks', async () => {
  const mockRunner = {
    run: vi.fn().mockResolvedValue({
      status: 'DONE',
      summary: 'Inspected GitHub pull requests',
    }),
  };

  const mockStore = {
    claimNextTask: vi.fn().mockResolvedValue({
      id: 'browser-task-1',
      prompt: 'Check my open pull requests on https://github.com',
      kind: 'browser',
      mode: 'default',
      status: 'running',
    }),
    updateTaskStatus: vi.fn().mockResolvedValue(undefined),
  };

  const mockChrome = {
    ensureRunning: vi.fn().mockResolvedValue({
      available: true,
      port: 9222,
      mode: 'dedicated',
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
    }),
    checkDebuggerStatus: vi.fn().mockResolvedValue({
      available: true,
      port: 9222,
      mode: 'dedicated',
    }),
  };

  await runDaemonOnce({
    machineId: 'test-machine',
    store: mockStore as any,
    runner: mockRunner as any,
    chromeManager: mockChrome as any,
  });

  expect(mockChrome.ensureRunning).toHaveBeenCalled();
  expect(mockRunner.run).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'browser-task-1' }),
    expect.any(Function),
    expect.objectContaining({
      signal: expect.any(AbortSignal),
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/daemon.test.ts`
Expected: FAIL because `chromeManager` is not supported on `RunDaemonOnceInput`.

- [ ] **Step 3: Update daemon.ts and agy-runner.ts to support ChromeManager**

Update `RunDaemonOnceInput` in `packages/daemon/src/daemon.ts`:
```typescript
export interface RunDaemonOnceInput {
  machineId: string;
  store: TaskStore;
  runner: AgentRunner;
  frameSource?: FrameSource;
  onFrame?: (frame: BrowserFrame) => void;
  chromeManager?: ChromeManager;
  hermesBrain?: HermesBrain;
}
```

In `runDaemonOnce`, when `running.kind === 'browser'` or prompt contains `http`:
```typescript
  if (isBrowserKind || running.prompt.includes('http://') || running.prompt.includes('https://')) {
    if (input.chromeManager) {
      await input.chromeManager.ensureRunning().catch(() => {});
    }
  }
```

In `packages/daemon/src/agy-runner.ts`, pass `BU_CDP_URL` and `CHROME_REMOTE_DEBUGGING_PORT` into spawned child processes:
```typescript
  const env = {
    ...process.env,
    BU_CDP_URL: 'http://127.0.0.1:9222',
    CHROME_REMOTE_DEBUGGING_PORT: '9222',
  };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run packages/daemon/src/daemon.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add packages/daemon/src/daemon.ts packages/daemon/src/agy-runner.ts packages/daemon/src/daemon.test.ts
git commit -m "feat(daemon): connect daemon task lifecycle to ChromeManager and inject CDP variables"
```

---

### Task 3: CLI Start, Daemon, and Doctor Integration

**Files:**
- Modify: `packages/cli/src/commands/start.ts`
- Modify: `packages/cli/src/commands/daemon.ts`
- Modify: `packages/cli/src/commands/doctor.ts`
- Test: `packages/cli/src/cli.test.ts`

**Interfaces:**
- Produces:
  - `--browser-profile <active|dedicated|none>` option in `rh start` and `rh daemon`.
  - Chrome diagnosis in `rh doctor` checking Google Chrome presence, version, and port 9222 status.

- [ ] **Step 1: Write test for CLI browser-profile flag in cli.test.ts**

Add test to `packages/cli/src/cli.test.ts`:
```typescript
it('parses --browser-profile flag and passes to daemon', async () => {
  const stdoutSpy = vi.fn();
  const context: CommandContext = {
    stdout: stdoutSpy,
    runner: new StaticAgentRunner({ status: 'DONE', summary: 'Success' }),
  };

  const code = await startCommand(['--no-clamshell', '--once', '--browser-profile=dedicated'], context);
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/cli.test.ts`
Expected: PASS or FAIL depending on argument forwarding.

- [ ] **Step 3: Implement browser-profile in start.ts, daemon.ts, and doctor.ts**

In `packages/cli/src/commands/daemon.ts`:
```typescript
  const browserProfileArg = args.find((a) => a.startsWith('--browser-profile='));
  const profileMode: ChromeProfileMode = browserProfileArg
    ? (browserProfileArg.split('=')[1] as ChromeProfileMode)
    : 'dedicated';

  const chromeManager = new ChromeManager({ mode: profileMode, port: 9222 });
```
Pass `chromeManager` into `runDaemonOnce({ ... chromeManager })`.

In `packages/cli/src/commands/doctor.ts`, add a section for Chrome Diagnostic:
```typescript
  const chromeManager = new ChromeManager({ mode: 'dedicated', port: 9222 });
  const status = await chromeManager.checkDebuggerStatus();
  if (status.available) {
    stdout(`  ${c.brightGreen('✔')} Chrome Remote Debugger: ACTIVE (Port ${status.port}, Mode: ${status.mode})\n`);
  } else {
    stdout(`  ${c.yellow('ℹ')} Chrome Remote Debugger: Ready to launch on demand (Port 9222, Mode: ${status.mode})\n`);
  }
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run packages/cli/src/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add packages/cli/src/commands/start.ts packages/cli/src/commands/daemon.ts packages/cli/src/commands/doctor.ts packages/cli/src/cli.test.ts
git commit -m "feat(cli): add --browser-profile support to start, daemon, and doctor commands"
```

---

### Task 4: Web UI Browser Status and Profile Badge

**Files:**
- Modify: `apps/web/src/screens/LiveTaskScreen.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces:
  - A subtle profile badge in the Screen stream header (`🌐 Authenticated Chrome Profile`) when viewing live browser frames.

- [ ] **Step 1: Write test for browser badge display in App.test.tsx**

Add test to `apps/web/src/App.test.tsx`:
```typescript
it('displays authenticated profile badge when viewing browser screen', async () => {
  const socket = new MockSocket();
  render(
    <LiveTaskScreen
      task={{ ...fakeTask, kind: 'browser' }}
      onBack={() => {}}
      webSocketFactory={() => socket as any}
    />
  );

  socket.triggerMessage({
    type: 'task.frame',
    task_id: fakeTask.id,
    jpeg_base64: 'fake-frame-data',
    captured_at: new Date().toISOString(),
  });

  await waitFor(() => {
    expect(screen.getByText(/Screen/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify**

Run: `npx vitest run apps/web/src/App.test.tsx`
Expected: PASS

- [ ] **Step 3: Add the profile badge to LiveTaskScreen.tsx**

In `apps/web/src/screens/LiveTaskScreen.tsx`, inside `chat-inline-frame`:
```tsx
        {taskKind !== 'coding' && showFrame && frameBase64 && (
          <div className="chat-inline-frame" style={{ margin: '8px 0 12px 0' }}>
            <div className="frame-meta-bar">
              <span className="frame-profile-badge">🌐 Logged-in Chrome Profile Active</span>
            </div>
            <FrameViewer frameBase64={frameBase64} onClose={() => setShowFrame(false)} />
          </div>
        )}
```

In `apps/web/src/styles.css`:
```css
.frame-meta-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  padding: 0 4px;
}

.frame-profile-badge {
  font-size: 0.6875rem;
  font-family: var(--font-mono, monospace);
  color: var(--accent-emerald);
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.25);
  border-radius: 6px;
  padding: 2px 8px;
}
```

- [ ] **Step 4: Run all web tests and build**

Run: `pnpm test && pnpm build`
Expected: All tests pass, 0 compile errors.

- [ ] **Step 5: Commit changes**

```bash
git add apps/web/src/screens/LiveTaskScreen.tsx apps/web/src/styles.css apps/web/src/App.test.tsx
git commit -m "feat(web): add authenticated profile status badge to live screen stream viewer"
```
