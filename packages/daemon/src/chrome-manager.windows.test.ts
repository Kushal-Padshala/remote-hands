import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeManager } from './chrome-manager.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(() => Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn(), pid: 1 })),
}));

describe('ChromeManager on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let dir: string;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome win '));
    vi.mocked(spawn).mockClear();
    let calls = 0;
    // nothing answers at first; once the browser has been started, it does
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection refused');
      return { ok: true, json: async () => ({ Browser: 'Chrome/130.0.0.0', webSocketDebuggerUrl: 'ws://x' }) };
    });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts the browser through cmd /c start, so it is not part of the agent\'s process tree (cancelling a task must not close it)', async () => {
    const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const manager = new ChromeManager({ mode: 'dedicated', port: 9555, customProfileDir: dir, chromeExecutablePath: exe });
    const status = await manager.ensureRunning();
    expect(status.available).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]! as unknown as [string, string[], Record<string, unknown>];
    expect(file.toLowerCase()).toContain('cmd');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = args[3]!;
    expect(line.startsWith('"start "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ')).toBe(true);
    expect(line).toContain('--remote-debugging-port=9555');
    expect(line).toContain(`"--user-data-dir=${dir}"`);
    expect(line.endsWith('"')).toBe(true);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true });
  });
});
