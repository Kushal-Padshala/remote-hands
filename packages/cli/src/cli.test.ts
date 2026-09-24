import { describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

describe('CLI command dispatcher', () => {
  it('dispatches setup command', async () => {
    const logs: string[] = [];
    const fakeRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'mock' });
    const code = await main(['setup'], {
      stdout: (msg) => logs.push(msg),
      stderr: () => {},
      runner: fakeRunner as any,
    });
    expect(logs.some((l) => l.includes('Remote Hands'))).toBe(true);
  });

  it('dispatches deploy command', async () => {
    const logs: string[] = [];
    const code = await main(['deploy'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('Deploying'))).toBe(true);
  });

  it('dispatches start command', async () => {
    const logs: string[] = [];
    const code = await main(['start', '--no-clamshell', '--once'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('Daemon'))).toBe(true);
  });

  it('dispatches start command with --browser-profile flag', async () => {
    const logs: string[] = [];
    const code = await main(['start', '--no-clamshell', '--once', '--browser-profile=dedicated'], {
      stdout: (msg) => logs.push(msg),
    });
    expect(code).toBe(0);
  });

  it('dispatches daemon command', async () => {
    const logs: string[] = [];
    const code = await main(['daemon', '--once'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('daemon') || l.includes('Machine') || l.includes('Starting'))).toBe(true);
  });

  it('dispatches doctor command', async () => {
    const logs: string[] = [];
    const code = await main(['doctor'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('health checks'))).toBe(true);
    expect(logs.some((l) => l.includes('Chrome profiles:'))).toBe(true);
  }, 30000);

  it('prints help on --help or no command', async () => {
    const logs: string[] = [];
    const code = await main(['--help'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('Usage: remote-hands'))).toBe(true);

    const emptyLogs: string[] = [];
    const codeEmpty = await main([], { stdout: (msg) => emptyLogs.push(msg) });
    expect(codeEmpty).toBe(0);
    expect(emptyLogs.some((l) => l.includes('Usage: remote-hands'))).toBe(true);
  });

  it('lists browser command in help output', async () => {
    const logs: string[] = [];
    const code = await main(['--help'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('browser'))).toBe(true);
  });

  it('returns error code 1 on unknown command', async () => {
    const errors: string[] = [];
    const code = await main(['foobar'], { stderr: (msg) => errors.push(msg) });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes('Unknown command: foobar'))).toBe(true);
  });

  it('dispatches profiles command', async () => {
    const logs: string[] = [];
    const code = await main(['profiles'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('Chrome Browser Profiles'))).toBe(true);
    expect(logs.some((l) => l.includes('Debugger Status:'))).toBe(true);
  });

  it('lists profiles command in help output', async () => {
    const logs: string[] = [];
    const code = await main(['--help'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('profiles'))).toBe(true);
  });

  it('passes custom profile name to ChromeManager on start', async () => {
    const logs: string[] = [];
    const context: any = { stdout: (msg: string) => logs.push(msg) };
    const code = await main(['start', '--no-clamshell', '--once', '--browser-profile=FLCC'], context);
    expect(code).toBe(0);
    expect(context.chromeManager).toBeDefined();
    expect(context.chromeManager.getProfile()).toBe('FLCC');
    expect(context.chromeManager.getMode()).toBe('active');
  });

  it('passes custom profile name to ChromeManager on daemon', async () => {
    const logs: string[] = [];
    const context: any = { stdout: (msg: string) => logs.push(msg) };
    const code = await main(['daemon', '--once', '--browser-profile=FLCC'], context);
    expect(code).toBe(0);
    expect(context.chromeManager).toBeDefined();
    expect(context.chromeManager.getProfile()).toBe('FLCC');
    expect(context.chromeManager.getMode()).toBe('active');
  });

  it('supports space-separated --browser-profile argument', async () => {
    const logs: string[] = [];
    const context: any = { stdout: (msg: string) => logs.push(msg) };
    const code = await main(['daemon', '--once', '--browser-profile', 'kushal'], context);
    expect(code).toBe(0);
    expect(context.chromeManager).toBeDefined();
    expect(context.chromeManager.getProfile()).toBe('kushal');
    expect(context.chromeManager.getMode()).toBe('active');
  });

  it('lists guide command in help output', async () => {
    const logs: string[] = [];
    const code = await main(['--help'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('guide'))).toBe(true);
  });

  it('dispatches guide command', async () => {
    const logs: string[] = [];
    const fakeManager = {
      getStatus: () => null,
      dismiss: async () => {},
      next: async () => null,
      startSession: async () => ({}),
    };
    const code = await main(['guide', 'status'], {
      stdout: (msg) => logs.push(msg),
      manager: fakeManager as any,
    } as any);
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('No active guidance session'))).toBe(true);
  });

  it('lists hud command in help output', async () => {
    const logs: string[] = [];
    const code = await main(['--help'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('hud'))).toBe(true);
  });

  it('dispatches hud command', async () => {
    const logs: string[] = [];
    const fakeServiceManager = {
      install: vi.fn(),
      uninstall: vi.fn(),
      isInstalled: vi.fn().mockReturnValue(true),
      isRunning: vi.fn().mockReturnValue(true),
    };
    const code = await main(['hud', 'status'], {
      stdout: (msg) => logs.push(msg),
      serviceManager: fakeServiceManager,
    } as any);
    expect(code).toBe(0);
    expect(fakeServiceManager.isInstalled).toHaveBeenCalled();
    expect(logs.some((l) => l.includes('Desktop Overlay Status'))).toBe(true);
  });

  it('lists permissions command in help output', async () => {
    const logs: string[] = [];
    const code = await main(['--help'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('permissions'))).toBe(true);
  });

  it('dispatches permissions command', async () => {
    const logs: string[] = [];
    const mockFs: any = {
      readFile: async () => JSON.stringify({ permissions: { allow: ['read_file'] } }),
      writeFile: async () => {},
      exists: async () => true,
    };
    const code = await main(['permissions', '--help'], {
      stdout: (msg) => logs.push(msg),
      fs: mockFs,
    });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('rh permissions'))).toBe(true);
  });
});

