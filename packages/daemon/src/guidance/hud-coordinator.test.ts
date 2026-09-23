import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HudCoordinator } from './hud-coordinator.js';

describe('HudCoordinator', () => {
  let mockHudRunner: any;
  let mockIntentResolver: any;
  let mockGuidanceManager: any;
  let coordinator: HudCoordinator;

  beforeEach(() => {
    mockHudRunner = {
      openPrompt: vi.fn(),
      startListener: vi.fn(),
    };
    mockIntentResolver = {
      resolve: vi.fn(),
    };
    mockGuidanceManager = {
      startSession: vi.fn(),
    };
    coordinator = new HudCoordinator(
      mockHudRunner,
      mockIntentResolver,
      mockGuidanceManager
    );
  });

  it('triggers prompt, resolves intent, and starts guidance session', async () => {
    mockHudRunner.openPrompt.mockResolvedValue({
      query: 'how to upload file',
      app: 'Photoshop',
    });
    mockIntentResolver.resolve.mockResolvedValue({
      steps: [
        { type: 'desktop', app: 'Photoshop', target: 'File', text: 'Click File' },
        { type: 'desktop', app: 'Photoshop', target: 'Open', text: 'Click Open' },
      ],
      confidence: 0.9,
      source: 'heuristic',
    });
    mockGuidanceManager.startSession.mockResolvedValue({
      id: 'g1',
      currentStepIndex: 0,
      steps: [{}],
      active: true,
    });

    const success = await coordinator.triggerPrompt('Photoshop');
    expect(success).toBe(true);
    expect(mockHudRunner.openPrompt).toHaveBeenCalledWith('Photoshop');
    expect(mockIntentResolver.resolve).toHaveBeenCalledWith('how to upload file', 'Photoshop');
    expect(mockGuidanceManager.startSession).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ target: 'File', text: 'Click File' }),
      ])
    );
  });

  it('returns false when prompt is dismissed or cancelled by user', async () => {
    mockHudRunner.openPrompt.mockResolvedValue(null);

    const success = await coordinator.triggerPrompt();
    expect(success).toBe(false);
    expect(mockIntentResolver.resolve).not.toHaveBeenCalled();
    expect(mockGuidanceManager.startSession).not.toHaveBeenCalled();
  });

  it('hooks global hotkey listener and executes prompt flow on keypress', async () => {
    let capturedCallback: any;
    mockHudRunner.startListener.mockImplementation((cb: any) => {
      capturedCallback = cb;
      return { stop: vi.fn() };
    });

    mockIntentResolver.resolve.mockResolvedValue({
      steps: [{ type: 'desktop', text: 'Action' }],
    });

    const listener = coordinator.startListening();
    expect(listener.stop).toBeDefined();
    expect(mockHudRunner.startListener).toHaveBeenCalled();

    await capturedCallback({ query: 'open file', app: 'Finder' });
    expect(mockIntentResolver.resolve).toHaveBeenCalledWith('open file', 'Finder');
    expect(mockGuidanceManager.startSession).toHaveBeenCalled();
  });
});
