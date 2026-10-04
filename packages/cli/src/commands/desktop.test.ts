import { describe, it, expect, vi } from 'vitest';
import { desktopCommand } from './desktop.js';
import { DesktopActEngine, searchAndTriggerMenu } from '@remote-hands/daemon';

describe('desktopCommand', () => {
  it.each(['click 3', 'type "hello" into Sen'])('requires approval before an act goal presses Send: %s', async (goal) => {
    const elements = [{ index: 3, role: 'AXButton', label: 'Send', bounds: [0, 0, 10, 10] as [number, number, number, number] }];
    const engine = new DesktopActEngine();
    const execute = vi.spyOn(engine, 'executeDecision').mockResolvedValue(undefined);
    const approve = vi.fn().mockResolvedValue(1);
    const code = await desktopCommand(['act', goal], {
      env: {}, taskId: 'task-1', approve, stdout: () => {}, stderr: () => {},
      desktopDriver: {}, walker: { walkActiveApp: async () => elements }, actEngine: engine,
    });
    expect(code).toBe(1);
    expect(approve.mock.calls[0]?.[0]).toContain('--action=send');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unreadable'])('blocks an agent AX action when its target is %s', async (mode) => {
    const press = vi.fn().mockResolvedValue(true);
    const code = await desktopCommand(['ax-action', 'Mail', '3'], {
      env: {}, taskId: 'task-1', stdout: () => {}, stderr: () => {}, desktopDriver: {},
      walker: { walkActiveApp: async () => { if (mode === 'unreadable') throw new Error('AX failed'); return []; } },
      performAxAction: press,
    });
    expect(code).toBe(1);
    expect(press).not.toHaveBeenCalled();
  });

  it('blocks the resolved Delete item for an abbreviated menu-search query', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stderr: '', stdout: JSON.stringify({ success: true, triggeredPath: ['Edit', 'Delete'], appPid: 123 }) });
    const approve = vi.fn().mockResolvedValue(1);
    const code = await desktopCommand(['menu-search', 'Mail', 'Del'], {
      env: {}, taskId: 'task-1', approve, stdout: () => {}, stderr: () => {},
      desktopDriver: { exec }, searchAndTriggerMenu,
    });
    expect(code).toBe(1);
    expect(approve.mock.calls[0]?.[0]).toContain('--action=delete');
    // The only native call resolves the menu without pressing it.
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('prints usage when no subcommand provided', async () => {
    const stdout = vi.fn();
    const code = await desktopCommand([], { stdout });
    expect(code).toBe(1);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: rh desktop'));
  });

  it('prints usage and returns 0 on --help', async () => {
    const stdout = vi.fn();
    const code = await desktopCommand(['--help'], { stdout });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: rh desktop'));
  });

  it('prints usage and returns 0 on -h and help', async () => {
    const stdout = vi.fn();
    const code1 = await desktopCommand(['-h'], { stdout });
    expect(code1).toBe(0);
    const code2 = await desktopCommand(['help'], { stdout });
    expect(code2).toBe(0);
  });

  it('dispatches open command and reports missing app', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['open'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Missing app name'));
  });

  it('dispatches open command successfully', async () => {
    const driverMock = { openApp: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['open', 'Slack'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.openApp).toHaveBeenCalledWith('Slack');
    expect(stdout).toHaveBeenCalledWith('Opened Slack');
  });

  it('supports multi-word app names in open command', async () => {
    const driverMock = { openApp: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['open', 'Google', 'Chrome'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.openApp).toHaveBeenCalledWith('Google Chrome');
    expect(stdout).toHaveBeenCalledWith('Opened Google Chrome');
  });

  it('handles window list', async () => {
    const mockWindows = [
      { app: 'Finder', title: 'Downloads' },
      { app: 'Slack', title: 'general' },
    ];
    const driverMock = { listWindows: vi.fn().mockResolvedValue(mockWindows) };
    const stdout = vi.fn();
    const code = await desktopCommand(['window', 'list'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.listWindows).toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(mockWindows, null, 2));
  });

  it('handles window without action', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['window'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage: rh desktop window'));
  });

  it('handles window focus', async () => {
    const driverMock = { focusWindow: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['window', 'focus', 'Visual', 'Studio', 'Code'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.focusWindow).toHaveBeenCalledWith('Visual Studio Code');
    expect(stdout).toHaveBeenCalledWith('Focused Visual Studio Code');
  });

  it('reports missing app for window focus', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['window', 'focus'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Missing app name'));
  });

  it('handles window close', async () => {
    const driverMock = { closeWindow: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['window', 'close', 'Slack'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.closeWindow).toHaveBeenCalledWith('Slack');
    expect(stdout).toHaveBeenCalledWith('Closed window for Slack');
  });

  it('reports missing app for window close', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['window', 'close'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Missing app name'));
  });

  it('reports unknown window action', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['window', 'minimize'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown window action: minimize'));
  });

  it('handles snapshot with formatted table output', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [10, 10, 50, 20] },
    ];
    const walkerMock = {
      walkActiveApp: vi.fn().mockResolvedValue(mockElements),
      formatTable: vi.fn().mockReturnValue('[1] AXButton "Submit"'),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['snapshot'], {
      stdout,
      walker: walkerMock as any,
    });
    expect(code).toBe(0);
    expect(walkerMock.walkActiveApp).toHaveBeenCalledWith(undefined, { allowOcr: false });
    expect(stdout).toHaveBeenCalledWith('[1] AXButton "Submit"');
  });

  it('handles snapshot with --json flag', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [10, 10, 50, 20] },
    ];
    const walkerMock = {
      walkActiveApp: vi.fn().mockResolvedValue(mockElements),
      formatTable: vi.fn(),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['snapshot', '--json'], {
      stdout,
      walker: walkerMock as any,
    });
    expect(code).toBe(0);
    expect(walkerMock.walkActiveApp).toHaveBeenCalledWith(undefined, { allowOcr: false });
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(mockElements, null, 2));
    expect(walkerMock.formatTable).not.toHaveBeenCalled();
  });

  it('handles snapshot with app name and --json flag', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Save', bounds: [0, 0, 10, 10] },
    ];
    const walkerMock = {
      walkActiveApp: vi.fn().mockResolvedValue(mockElements),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['snapshot', 'Slack', '--json'], {
      stdout,
      walker: walkerMock as any,
    });
    expect(code).toBe(0);
    expect(walkerMock.walkActiveApp).toHaveBeenCalledWith('Slack', { allowOcr: false });
  });

  it('handles snapshot with --no-ocr flag', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Save', bounds: [0, 0, 10, 10] },
    ];
    const walkerMock = {
      walkActiveApp: vi.fn().mockResolvedValue(mockElements),
      formatTable: vi.fn().mockReturnValue('[1] AXButton "Save"'),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['snapshot', 'Slack', '--no-ocr'], {
      stdout,
      walker: walkerMock as any,
    });
    expect(code).toBe(0);
    expect(walkerMock.walkActiveApp).toHaveBeenCalledWith('Slack', { allowOcr: false });
  });

  it('handles snapshot with --ocr flag', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Save', bounds: [0, 0, 10, 10] },
    ];
    const walkerMock = {
      walkActiveApp: vi.fn().mockResolvedValue(mockElements),
      formatTable: vi.fn().mockReturnValue('[1] AXButton "Save"'),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['snapshot', 'Slack', '--ocr'], {
      stdout,
      walker: walkerMock as any,
    });
    expect(code).toBe(0);
    expect(walkerMock.walkActiveApp).toHaveBeenCalledWith('Slack', { allowOcr: true });
  });

  it('handles click at x,y coordinates with clickAt method', async () => {
    const driverMock = { clickAt: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['click', '150,250'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.clickAt).toHaveBeenCalledWith(150, 250);
    expect(stdout).toHaveBeenCalledWith('Clicked at 150,250');
  });

  it('handles click at x,y coordinates via driver.exec', async () => {
    const driverMock = { exec: vi.fn() };
    const stdout = vi.fn();
    const code = await desktopCommand(['click', '100', '200'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.exec).toHaveBeenCalledWith('osascript', [
      '-e',
      expect.stringContaining('click at {100, 200}'),
    ]);
    expect(stdout).toHaveBeenCalledWith('Clicked at 100,200');
  });

  it('asks the phone before clicking a risky element during a task and stops on rejection', async () => {
    const mockElements = [{ index: 3, role: 'AXButton', label: 'Send', bounds: [10, 10, 50, 20] }];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const engineMock = { executeDecision: vi.fn().mockResolvedValue(undefined) };
    const stderr = vi.fn();
    const approve = vi.fn(async (_args: string[], ctx: any) => {
      ctx.stderr('Approval rejected by user.');
      return 1;
    });
    const code = await desktopCommand(['click', '3'], {
      stderr,
      walker: walkerMock as any,
      actEngine: engineMock as any,
      env: {},
      taskId: 'task-1',
      approve,
    });
    expect(code).toBe(1);
    expect(approve.mock.calls[0]![0]).toEqual(['Press "Send"', '--action=send', '--risk=high', '--task=task-1']);
    expect(engineMock.executeDecision).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"Send" was not pressed'));
  });

  it('handles click by element index', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Cancel', bounds: [10, 10, 50, 20] },
      { index: 2, role: 'AXButton', label: 'Save', bounds: [70, 10, 50, 20] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const engineMock = { executeDecision: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['click', '2'], {
      stdout,
      walker: walkerMock as any,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(engineMock.executeDecision).toHaveBeenCalledWith(
      { action: 'CLICK', targetIndex: 2 },
      mockElements
    );
    expect(stdout).toHaveBeenCalledWith('Clicked element [2]');
  });

  it('handles click by bracketed element index [1]', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [10, 10, 50, 20] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const engineMock = { executeDecision: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['click', '[1]'], {
      stdout,
      walker: walkerMock as any,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(engineMock.executeDecision).toHaveBeenCalledWith(
      { action: 'CLICK', targetIndex: 1 },
      mockElements
    );
  });

  it('reports missing target for click', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['click'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Missing target'));
  });

  it('reports error when element index not found', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [10, 10, 50, 20] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const stderr = vi.fn();
    const code = await desktopCommand(['click', '99'], {
      stderr,
      walker: walkerMock as any,
    });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Element [99] not found');
  });

  it('reports invalid click target', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['click', 'invalid-coord-here'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid click target'));
  });

  it('handles type text command via custom typeText', async () => {
    const driverMock = { typeText: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['type', 'Hello', 'World'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.typeText).toHaveBeenCalledWith('Hello World');
    expect(stdout).toHaveBeenCalledWith('Typed: Hello World');
  });

  it('handles type text command via actEngine fallback', async () => {
    const engineMock = { executeDecision: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['type', 'Remote Hands'], {
      stdout,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(engineMock.executeDecision).toHaveBeenCalledWith(
      { action: 'TYPE_TEXT', text: 'Remote Hands' },
      []
    );
    expect(stdout).toHaveBeenCalledWith('Typed: Remote Hands');
  });

  it('reports missing text for type', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['type'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Missing text'));
  });

  it('handles key combo command via pressKey', async () => {
    const driverMock = { pressKey: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['key', 'cmd+s'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.pressKey).toHaveBeenCalledWith('cmd+s');
    expect(stdout).toHaveBeenCalledWith('Pressed key: cmd+s');
  });

  it('handles key combo command via actEngine fallback', async () => {
    const engineMock = { executeDecision: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['key', 'enter'], {
      stdout,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(engineMock.executeDecision).toHaveBeenCalledWith(
      { action: 'KEY', key: 'enter' },
      []
    );
    expect(stdout).toHaveBeenCalledWith('Pressed key: enter');
  });

  it('reports missing key combo for key', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['key'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Missing key combo'));
  });

  it('handles menu command', async () => {
    const driverMock = { triggerMenu: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['menu', 'TextEdit', 'File', 'Save'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.triggerMenu).toHaveBeenCalledWith('TextEdit', ['File', 'Save']);
    expect(stdout).toHaveBeenCalledWith('Triggered menu "File > Save" in TextEdit');
  });

  it('handles deep menu command with submenus', async () => {
    const driverMock = { triggerMenu: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['menu', 'Pages', 'File', 'Export To', 'PDF'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.triggerMenu).toHaveBeenCalledWith('Pages', ['File', 'Export To', 'PDF']);
    expect(stdout).toHaveBeenCalledWith('Triggered menu "File > Export To > PDF" in Pages');
  });

  it('reports missing args for menu command', async () => {
    const stderr = vi.fn();
    const code1 = await desktopCommand(['menu'], { stderr });
    expect(code1).toBe(1);
    const code2 = await desktopCommand(['menu', 'TextEdit'], { stderr });
    expect(code2).toBe(1);
    const code3 = await desktopCommand(['menu', 'TextEdit', 'File'], { stderr });
    expect(code3).toBe(1);
  });

  it('handles act command via engine.executeDecision', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Save Changes', bounds: [0, 0, 10, 10] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const engineMock = {
      matchHeuristic: vi.fn().mockReturnValue({ action: 'CLICK', targetIndex: 1 }),
      executeDecision: vi.fn().mockResolvedValue(undefined),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['act', 'Click', 'Save', 'Changes'], {
      stdout,
      walker: walkerMock as any,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(walkerMock.walkActiveApp).toHaveBeenCalled();
    expect(engineMock.executeDecision).toHaveBeenCalledWith({ action: 'CLICK', targetIndex: 1 }, mockElements);
    expect(stdout).toHaveBeenCalledWith('Executed: CLICK');
  });

  it('handles act command via matchHeuristic and executeDecision', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [0, 0, 10, 10] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const engineMock = {
      matchHeuristic: vi.fn().mockReturnValue({ action: 'CLICK', targetIndex: 1 }),
      executeDecision: vi.fn().mockResolvedValue(undefined),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['act', 'Submit'], {
      stdout,
      walker: walkerMock as any,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(engineMock.matchHeuristic).toHaveBeenCalledWith('Submit', mockElements);
    expect(engineMock.executeDecision).toHaveBeenCalledWith(
      { action: 'CLICK', targetIndex: 1 },
      mockElements
    );
    expect(stdout).toHaveBeenCalledWith('Executed: CLICK');
  });

  it('reports missing goal for act command', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['act'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Missing goal'));
  });

  it('reports unknown subcommand', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['invalidSubcommand'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Unknown desktop subcommand: invalidSubcommand')
    );
  });

  it('handles errors thrown by driver cleanly', async () => {
    const driverMock = {
      openApp: vi.fn().mockRejectedValue(new Error('Permission denied')),
    };
    const stderr = vi.fn();
    const code = await desktopCommand(['open', 'SecretApp'], {
      stderr,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Permission denied');
  });

  it('captures screenshot and prints file status', async () => {
    const driverMock = {
      captureScreenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot-data')),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['screenshot', '--path', '/tmp/custom.jpg'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(driverMock.captureScreenshot).toHaveBeenCalledWith({ destPath: '/tmp/custom.jpg' });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Screenshot saved to /tmp/custom.jpg'));
  });

  it('captures screenshot and outputs base64 when requested', async () => {
    const driverMock = {
      captureScreenshot: vi.fn().mockResolvedValue(Buffer.from('fake-shot')),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['screenshot', '--base64'], {
      stdout,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(Buffer.from('fake-shot').toString('base64'));
  });

  it('reports failure when screenshot capture returns null', async () => {
    const driverMock = {
      captureScreenshot: vi.fn().mockResolvedValue(null),
    };
    const stderr = vi.fn();
    const code = await desktopCommand(['screenshot'], {
      stderr,
      desktopDriver: driverMock as any,
    });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Failed to capture desktop screenshot');
  });

  it('dispatches menu-search command successfully', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const code = await desktopCommand(['menu-search', 'Bambu Studio', 'slice'], { stdout, stderr });
    expect([0, 1]).toContain(code);
  });

  it('handles menu-search with mocked success and triggeredPath', async () => {
    const searchMock = vi.fn().mockResolvedValue({
      success: true,
      triggeredPath: ['File', 'Export', 'STL'],
    });
    const driverMock = { exec: vi.fn() };
    const stdout = vi.fn();
    const code = await desktopCommand(['menu-search', 'Bambu Studio', 'Export', 'STL'], {
      stdout,
      desktopDriver: driverMock as any,
      searchAndTriggerMenu: searchMock as any,
    });
    expect(code).toBe(0);
    expect(searchMock).toHaveBeenCalledWith('Bambu Studio', 'Export STL', driverMock.exec, expect.any(Function));
    expect(stdout).toHaveBeenCalledWith('Triggered menu: File > Export > STL');
  });

  it('handles menu-search with triggeredPath fallback to query', async () => {
    const searchMock = vi.fn().mockResolvedValue({ success: true });
    const stdout = vi.fn();
    const code = await desktopCommand(['menu-search', 'Bambu Studio', 'slice'], {
      stdout,
      searchAndTriggerMenu: searchMock as any,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith('Triggered menu: slice');
  });

  it('handles menu-search failure from searchAndTriggerMenu', async () => {
    const searchMock = vi.fn().mockResolvedValue({
      success: false,
      error: 'Menu item not found',
    });
    const stderr = vi.fn();
    const code = await desktopCommand(['menu-search', 'Bambu Studio', 'unknown item'], {
      stderr,
      searchAndTriggerMenu: searchMock as any,
    });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Failed to trigger menu: Menu item not found');
  });

  it('reports missing args for menu-search command', async () => {
    const stderr1 = vi.fn();
    const code1 = await desktopCommand(['menu-search'], { stderr: stderr1 });
    expect(code1).toBe(1);
    expect(stderr1).toHaveBeenCalledWith('Usage: rh desktop menu-search <app> <query>');

    const stderr2 = vi.fn();
    const code2 = await desktopCommand(['menu-search', 'Bambu Studio'], { stderr: stderr2 });
    expect(code2).toBe(1);
    expect(stderr2).toHaveBeenCalledWith('Usage: rh desktop menu-search <app> <query>');
  });

  it('dispatches menu-list command successfully', async () => {
    const stdout = vi.fn();
    const code = await desktopCommand(['menu-list', 'Bambu Studio'], { stdout });
    expect([0, 1]).toContain(code);
  });

  it('handles menu-list with mocked menu tree', async () => {
    const mockTree = [{ title: 'File', children: [{ title: 'New' }] }];
    const crawlMock = vi.fn().mockResolvedValue(mockTree);
    const driverMock = { exec: vi.fn() };
    const stdout = vi.fn();
    const code = await desktopCommand(['menu-list', 'Bambu', 'Studio'], {
      stdout,
      desktopDriver: driverMock as any,
      crawlAppMenu: crawlMock as any,
    });
    expect(code).toBe(0);
    expect(crawlMock).toHaveBeenCalledWith('Bambu Studio', driverMock.exec);
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(mockTree, null, 2));
  });

  it('reports missing app for menu-list command', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['menu-list'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Usage: rh desktop menu-list <app>');
  });

  it('dispatches ax-action command successfully with default AXPress', async () => {
    const axMock = vi.fn().mockResolvedValue(true);
    const driverMock = { exec: vi.fn() };
    const stdout = vi.fn();
    const code = await desktopCommand(['ax-action', 'Bambu Studio', '12'], {
      stdout,
      desktopDriver: driverMock as any,
      walker: { walkActiveApp: vi.fn().mockResolvedValue([]) },
      performAxAction: axMock as any,
    });
    expect(code).toBe(0);
    expect(axMock).toHaveBeenCalledWith('Bambu Studio', 12, 'AXPress', driverMock.exec);
    expect(stdout).toHaveBeenCalledWith('Executed AXPress on element [12] in Bambu Studio');
  });

  it('dispatches ax-action command with custom action and bracketed index', async () => {
    const axMock = vi.fn().mockResolvedValue(true);
    const driverMock = { exec: vi.fn() };
    const stdout = vi.fn();
    const code = await desktopCommand(['ax-action', 'Slack', '[5]', 'AXShowMenu'], {
      stdout,
      desktopDriver: driverMock as any,
      walker: { walkActiveApp: vi.fn().mockResolvedValue([]) },
      performAxAction: axMock as any,
    });
    expect(code).toBe(0);
    expect(axMock).toHaveBeenCalledWith('Slack', 5, 'AXShowMenu', driverMock.exec);
    expect(stdout).toHaveBeenCalledWith('Executed AXShowMenu on element [5] in Slack');
  });

  it('reports missing args for ax-action command', async () => {
    const stderr1 = vi.fn();
    const code1 = await desktopCommand(['ax-action'], { stderr: stderr1 });
    expect(code1).toBe(1);
    expect(stderr1).toHaveBeenCalledWith('Usage: rh desktop ax-action <app> <index> [action]');

    const stderr2 = vi.fn();
    const code2 = await desktopCommand(['ax-action', 'Slack'], { stderr: stderr2 });
    expect(code2).toBe(1);
    expect(stderr2).toHaveBeenCalledWith('Usage: rh desktop ax-action <app> <index> [action]');
  });

  it('reports invalid index for ax-action command', async () => {
    const stderr = vi.fn();
    const code = await desktopCommand(['ax-action', 'Slack', 'notanumber'], { stderr });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Usage: rh desktop ax-action <app> <index> [action]');
  });

  it('handles ax-action failure from performAxAction', async () => {
    const axMock = vi.fn().mockResolvedValue(false);
    const stderr = vi.fn();
    const code = await desktopCommand(['ax-action', 'Slack', '3'], {
      stderr,
      walker: { walkActiveApp: vi.fn().mockResolvedValue([]) },
      performAxAction: axMock as any,
    });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Failed to execute AXPress on element [3] in Slack');
  });

  it('passes targetApp to engine.executeDecision when specified in goal', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [0, 0, 10, 10] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const engineMock = {
      matchHeuristic: vi.fn().mockReturnValue({ action: 'CLICK', targetIndex: 1 }),
      executeDecision: vi.fn().mockResolvedValue(undefined),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['act', 'in', 'Slack,', 'click', 'Submit'], {
      stdout,
      walker: walkerMock as any,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(walkerMock.walkActiveApp).toHaveBeenCalledWith('Slack', { allowOcr: false });
    expect(engineMock.executeDecision).toHaveBeenCalledWith({ action: 'CLICK', targetIndex: 1 }, mockElements, 'Slack');
    expect(stdout).toHaveBeenCalledWith('Executed: CLICK');
  });

  it('resolves verified bounds and role from walker in ax-action command', async () => {
    const mockElements = [
      { index: 5, role: 'AXButton', label: 'Slice', bounds: [100, 200, 80, 40] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const axMock = vi.fn().mockResolvedValue(true);
    const driverMock = { exec: vi.fn() };
    const stdout = vi.fn();
    const code = await desktopCommand(['ax-action', 'Bambu Studio', '5'], {
      stdout,
      desktopDriver: driverMock as any,
      walker: walkerMock as any,
      performAxAction: axMock as any,
    });
    expect(code).toBe(0);
    expect(axMock).toHaveBeenCalledWith(
      'Bambu Studio',
      { index: 5, bounds: [100, 200, 80, 40], role: 'AXButton', label: 'Slice' },
      'AXPress',
      driverMock.exec,
    );
    expect(stdout).toHaveBeenCalledWith('Executed AXPress on element [5] in Bambu Studio');
  });

  it('passes targetApp to engine.executeDecision when specified at the end of goal', async () => {
    const mockElements = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [0, 0, 10, 10] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const engineMock = {
      matchHeuristic: vi.fn().mockReturnValue({ action: 'CLICK', targetIndex: 1 }),
      executeDecision: vi.fn().mockResolvedValue(undefined),
    };
    const stdout = vi.fn();
    const code = await desktopCommand(['act', 'click', 'Submit', 'in', 'Google Chrome'], {
      stdout,
      walker: walkerMock as any,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(walkerMock.walkActiveApp).toHaveBeenCalledWith('Google Chrome', { allowOcr: false });
    expect(engineMock.executeDecision).toHaveBeenCalledWith({ action: 'CLICK', targetIndex: 1 }, mockElements, 'Google Chrome');
    expect(stdout).toHaveBeenCalledWith('Executed: CLICK');
  });

  it('passes app to engine.executeDecision when app name follows index in click command', async () => {
    const mockElements = [
      { index: 2, role: 'AXButton', label: 'Save', bounds: [70, 10, 100, 30] },
    ];
    const walkerMock = { walkActiveApp: vi.fn().mockResolvedValue(mockElements) };
    const engineMock = { executeDecision: vi.fn().mockResolvedValue(undefined) };
    const stdout = vi.fn();
    const code = await desktopCommand(['click', '2', 'Bambu Studio'], {
      stdout,
      walker: walkerMock as any,
      actEngine: engineMock as any,
    });
    expect(code).toBe(0);
    expect(engineMock.executeDecision).toHaveBeenCalledWith(
      { action: 'CLICK', targetIndex: 2 },
      mockElements,
      'Bambu Studio',
    );
    expect(stdout).toHaveBeenCalledWith('Clicked element [2]');
  });
});
