import { describe, it, expect, vi } from 'vitest';
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
    if (process.platform === 'darwin') {
      expect(manager.getProfileDirectory()).toContain('Application Support/Google/Chrome');
    } else {
      expect(manager.getProfileDirectory()).toBeDefined();
    }
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
