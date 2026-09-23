import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeGuideCommand, guideCommand } from './guide.js';

describe('CLI guide command', () => {
  let mockManager: any;
  let logSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    mockManager = {
      startSession: vi.fn().mockResolvedValue({ id: 'g1', currentStepIndex: 0, steps: [{}], active: true }),
      next: vi.fn().mockResolvedValue({ id: 'g1', currentStepIndex: 1, steps: [{}, {}], active: true }),
      dismiss: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(null),
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('handles show command with browser selector', async () => {
    const code = await executeGuideCommand(['show', '--browser', '--target=button#upload', '--text=Click upload'], mockManager);
    expect(code).toBe(0);
    expect(mockManager.startSession).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'browser', selector: 'button#upload', text: 'Click upload' }),
    ]);
  });

  it('handles show command with snapshot index', async () => {
    const code = await executeGuideCommand(['show', '--browser', '--index=4', '--text=Choose File'], mockManager);
    expect(code).toBe(0);
    expect(mockManager.startSession).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'browser', index: 4, text: 'Choose File' }),
    ]);
  });

  it('handles show command with desktop target and app', async () => {
    const code = await executeGuideCommand(['show', '--desktop', '--app=Finder', '--target=Applications', '--text=Click Applications'], mockManager);
    expect(code).toBe(0);
    expect(mockManager.startSession).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'desktop', app: 'Finder', target: 'Applications', text: 'Click Applications' }),
    ]);
  });

  it('handles next command', async () => {
    const code = await executeGuideCommand(['next'], mockManager);
    expect(code).toBe(0);
    expect(mockManager.next).toHaveBeenCalled();
  });

  it('handles next command when session completes', async () => {
    mockManager.next.mockResolvedValueOnce(null);
    const code = await executeGuideCommand(['next'], mockManager);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('completed'));
  });

  it('handles dismiss command', async () => {
    const code = await executeGuideCommand(['dismiss'], mockManager);
    expect(code).toBe(0);
    expect(mockManager.dismiss).toHaveBeenCalled();
  });

  it('handles status command when session is active', async () => {
    mockManager.getStatus.mockReturnValueOnce({ currentStepIndex: 0, steps: [{}, {}] });
    const code = await executeGuideCommand(['status'], mockManager);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Step 1 of 2'));
  });

  it('handles status command when no active session', async () => {
    mockManager.getStatus.mockReturnValueOnce(null);
    const code = await executeGuideCommand(['status'], mockManager);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No active'));
  });

  it('handles help command', async () => {
    const code = await executeGuideCommand(['--help'], mockManager);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: rh guide'));
  });

  it('handles unknown subcommand', async () => {
    const code = await executeGuideCommand(['invalidSubcommand'], mockManager);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown guide subcommand'));
  });

  it('supports guideCommand with CommandContext stdout and stderr', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await guideCommand(['dismiss'], {
      manager: mockManager,
      stdout: (msg) => logs.push(msg),
      stderr: (msg) => errors.push(msg),
    });
    expect(code).toBe(0);
    expect(mockManager.dismiss).toHaveBeenCalled();
    expect(logs.some((l) => l.includes('Visual guidance dismissed'))).toBe(true);
    expect(errors.length).toBe(0);
  });
});
