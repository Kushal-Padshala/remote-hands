import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('starts background listener on rh hud listen', async () => {
    let stopped = false;
    mockCoordinator.startListening.mockReturnValue({
      stop: () => {
        stopped = true;
      },
    });
    let listenerObj: any;
    const code = await hudCommand(['listen'], {
      coordinator: mockCoordinator,
      stdout: (msg) => logs.push(msg),
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
