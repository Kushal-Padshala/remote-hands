import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hudCommand } from './hud.js';

describe('CLI hud command', () => {
  let mockServiceManager: any;
  let mockCoordinator: any;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    mockServiceManager = {
      install: vi.fn().mockReturnValue({ success: true, plistPath: '/mock/path.plist' }),
      uninstall: vi.fn().mockReturnValue(true),
      isInstalled: vi.fn().mockReturnValue(true),
      isRunning: vi.fn().mockReturnValue(true),
    };
    mockCoordinator = {
      triggerPrompt: vi.fn().mockResolvedValue(true),
      startListening: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };
  });

  it('prints help message on --help', async () => {
    const code = await hudCommand(['--help'], {
      stdout: (msg) => logs.push(msg),
    });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('Usage: rh hud'))).toBe(true);
  });

  it('installs launchagent background service on rh hud install', async () => {
    const code = await hudCommand(['install'], {
      serviceManager: mockServiceManager,
      stdout: (msg) => logs.push(msg),
      stderr: (msg) => errors.push(msg),
    });
    expect(code).toBe(0);
    expect(mockServiceManager.install).toHaveBeenCalled();
    expect(logs.some((l) => l.includes('Desktop Overlay Assistant installed'))).toBe(true);
  });

  it('installs the service without offering browser setup', async () => {
    const offer = vi.fn(async () => {});
    const code = await hudCommand(['install'], {
      serviceManager: mockServiceManager,
      browserSetupOffer: offer,
      stdout: (msg) => logs.push(msg),
      stderr: (msg) => errors.push(msg),
    });
    expect(code).toBe(0);
    expect(offer).not.toHaveBeenCalled();
    expect(mockServiceManager.install).toHaveBeenCalled();
  });

  it('status tells the person when the background HUD runs an older copy', async () => {
    mockServiceManager.installedCopyIsStale = vi.fn().mockReturnValue(true);
    await hudCommand(['status'], { serviceManager: mockServiceManager, stdout: (m) => logs.push(m) });
    expect(logs.join('\n')).toContain('older copy');
    expect(logs.join('\n')).toContain('rh hud install');

    logs.length = 0;
    mockServiceManager.installedCopyIsStale.mockReturnValue(false);
    await hudCommand(['status'], { serviceManager: mockServiceManager, stdout: (m) => logs.push(m) });
    expect(logs.join('\n')).not.toContain('older copy');
  });

  it('uninstalls launchagent background service on rh hud uninstall', async () => {
    const code = await hudCommand(['uninstall'], {
      serviceManager: mockServiceManager,
      stdout: (msg) => logs.push(msg),
    });
    expect(code).toBe(0);
    expect(mockServiceManager.uninstall).toHaveBeenCalled();
    expect(logs.some((l) => l.includes('removed'))).toBe(true);
  });

  it('checks status of desktop overlay on rh hud status', async () => {
    const code = await hudCommand(['status'], {
      serviceManager: mockServiceManager,
      stdout: (msg) => logs.push(msg),
    });
    expect(code).toBe(0);
    expect(mockServiceManager.isInstalled).toHaveBeenCalled();
    expect(mockServiceManager.isRunning).toHaveBeenCalled();
    expect(logs.some((l) => l.includes('Desktop Overlay Status'))).toBe(true);
  });

  it('triggers prompt immediately on rh hud prompt', async () => {
    const code = await hudCommand(['prompt', '--app=Chrome'], {
      coordinator: mockCoordinator,
      stdout: (msg) => logs.push(msg),
    });
    expect(code).toBe(0);
    expect(mockCoordinator.triggerPrompt).toHaveBeenCalledWith('Chrome');
    expect(logs.some((l) => l.includes('Action initiated'))).toBe(true);
  });

  it('disposes the coordinator after rh hud prompt finishes', async () => {
    mockCoordinator.dispose = vi.fn();
    await hudCommand(['prompt'], { coordinator: mockCoordinator, stdout: (msg) => logs.push(msg) });
    expect(mockCoordinator.dispose).toHaveBeenCalledTimes(1);
  });

  it('waits for the in-flight task before disposing the coordinator', async () => {
    const order: string[] = [];
    mockCoordinator.dispose = vi.fn(() => order.push('dispose'));
    mockCoordinator.whenIdle = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('idle');
    });
    await hudCommand(['prompt'], { coordinator: mockCoordinator, stdout: (msg) => logs.push(msg) });
    expect(order).toEqual(['idle', 'dispose']);
  });

  it('disposes the coordinator even when the prompt task throws', async () => {
    mockCoordinator.dispose = vi.fn();
    mockCoordinator.triggerPrompt.mockRejectedValue(new Error('boom'));
    await expect(
      hudCommand(['prompt'], { coordinator: mockCoordinator, stdout: (msg) => logs.push(msg) }),
    ).rejects.toThrow('boom');
    expect(mockCoordinator.dispose).toHaveBeenCalledTimes(1);
  });

  it('starts background listener on rh hud listen', async () => {
    let stopped = false;
    mockCoordinator.startListening.mockReturnValue({
      stop: () => {
        stopped = true;
      },
    });
    let listenerObj: any;
    // --skip-permissions: on macOS the real Screen Recording check would wait for the user.
    const code = await hudCommand(['listen', '--skip-permissions'], {
      coordinator: mockCoordinator,
      stdout: (msg) => logs.push(msg),
      browserSetupOffer: async () => {},
      onListenerReady: (l) => {
        listenerObj = l;
      },
    });
    expect(code).toBe(0);
    expect(mockCoordinator.startListening).toHaveBeenCalled();
    expect(listenerObj).toBeDefined();
    listenerObj.stop();
    expect(stopped).toBe(true);
  });
});

describe('CLI hud install on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  const run = async (hotkey: { state: string } | null) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const serviceManager = {
      install: vi.fn().mockReturnValue({ success: true, plistPath: 'the Windows startup list' }),
      isInstalled: () => true,
      isRunning: () => true,
      waitForHotkey: vi.fn().mockResolvedValue(hotkey),
    };
    const code = await hudCommand(['install'], { serviceManager, stdout: (m) => logs.push(m), stderr: (m) => errors.push(m) });
    return { code, out: logs.join('\n'), err: errors.join('\n') };
  };

  it('names the shortcut only after the listener confirmed it', async () => {
    const ready = await run({ state: 'ready' });
    expect(ready.code).toBe(0);
    expect(ready.out).toContain('HotKey:');
    expect(ready.out).toContain('Starts at login: the Windows startup list');
  });

  it('says it is not confirmed, and does not name a shortcut, when the listener has not answered', async () => {
    const slow = await run(null);
    expect(slow.code).toBe(0);
    expect(slow.out).toContain('has not confirmed its shortcut yet');
    expect(slow.out).not.toContain('HotKey:');
    expect(slow.out).toContain('installed successfully');
  });

  it('fails with a plain message when no shortcut was free', async () => {
    const failed = await run({ state: 'failed' });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('already used by another program');
    expect(failed.out).not.toContain('installed successfully');
  });
});

describe('CLI hud listen started by the Windows supervisor', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    delete process.env.RH_HUD_OWNER_PIPE;
    vi.restoreAllMocks();
  });

  it('stops when the supervisor\'s pipe closes, so a listener never outlives the service that owns it', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.RH_HUD_OWNER_PIPE = '1';
    const handlers = new Map<string, () => void>();
    const onSpy = vi.spyOn(process.stdin, 'on').mockImplementation(((event: string, fn: () => void) => {
      handlers.set(event, fn);
      return process.stdin;
    }) as never);
    const resume = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    const stop = vi.fn();
    const coordinator = { startListening: vi.fn().mockReturnValue({ stop }) };
    let finished = false;
    const done = hudCommand(['listen', '--skip-permissions'], {
      coordinator,
      blockUntilSignal: true,
      onListenerReady: () => {},
      stdout: () => {},
    } as never).then((code) => {
      finished = true;
      return code;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(false);
    expect(onSpy).toHaveBeenCalledWith('end', expect.any(Function));
    expect(resume).toHaveBeenCalled();
    handlers.get('end')!();
    expect(await done).toBe(0);
    expect(stop).toHaveBeenCalled();
  });

  it('does not watch its input when it was not started by the supervisor (a person running it in a terminal)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const onSpy = vi.spyOn(process.stdin, 'on');
    const coordinator = { startListening: vi.fn().mockReturnValue({ stop: vi.fn() }) };
    await hudCommand(['listen', '--skip-permissions'], { coordinator, once: true, stdout: () => {} } as never);
    expect(onSpy).not.toHaveBeenCalledWith('end', expect.any(Function));
  });
});
