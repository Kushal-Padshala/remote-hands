import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HudCoordinator, isAutonomousGoal, formatContextualTaskPrompt } from './hud-coordinator.js';

describe('HudCoordinator', () => {
  let mockHudRunner: any;
  let mockIntentResolver: any;
  let mockGuidanceManager: any;
  let mockMacOsDriver: any;
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
    mockMacOsDriver = {
      getActiveWindowContext: vi.fn().mockResolvedValue({
        app: 'Google Chrome',
        title: 'Real Estate Portal',
        url: 'https://realestate.example.com',
        isBrowser: true,
      }),
    };
    coordinator = new HudCoordinator(
      mockHudRunner,
      mockIntentResolver,
      mockGuidanceManager,
      mockMacOsDriver
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
    expect(mockIntentResolver.resolve).toHaveBeenCalledWith('how to upload file', 'Google Chrome');
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

    await capturedCallback({ query: 'how to find files', app: 'Finder' });
    expect(mockIntentResolver.resolve).toHaveBeenCalledWith('how to find files', 'Google Chrome');
    expect(mockGuidanceManager.startSession).toHaveBeenCalled();
  });

  it('detects active browser window and enqueues autonomous task with research mandate', async () => {
    const mockStore = {
      createTask: vi.fn().mockImplementation(async (input: any) => ({
        id: 'task-hud-123',
        prompt: input.prompt,
        goal: input.goal,
        kind: input.kind,
        status: 'queued',
      })),
    };
    const onTaskCreated = vi.fn();

    const taskCoordinator = new HudCoordinator({
      hudRunner: mockHudRunner,
      intentResolver: mockIntentResolver,
      guidanceManager: mockGuidanceManager,
      macosDriver: mockMacOsDriver,
      store: mockStore as any,
      onTaskCreated,
    });

    mockHudRunner.openPrompt.mockResolvedValue({
      query: 'start a new campaine for a rpoeprty which si on rent and i want the clients to get redirected to the website',
      app: 'Google Chrome',
    });

    const success = await taskCoordinator.triggerPrompt('Google Chrome');
    expect(success).toBe(true);
    expect(mockMacOsDriver.getActiveWindowContext).toHaveBeenCalledWith('Google Chrome');
    expect(mockStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'start a new campaine for a rpoeprty which si on rent and i want the clients to get redirected to the website',
        kind: 'browser',
        status: 'queued',
        mode: 'autonomous',
      })
    );
    expect(onTaskCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-hud-123' })
    );

    const callArgs = mockStore.createTask.mock.calls[0]![0];
    expect(callArgs.prompt).toContain('Frontmost Application: Google Chrome');
    expect(callArgs.prompt).toContain('Active URL: https://realestate.example.com');
    expect(callArgs.prompt).toContain('Autonomous Research:');
    expect(callArgs.prompt).toContain('Full-Speed Execution:');
  });

  it('correctly classifies autonomous goals vs visual guidance questions', () => {
    expect(
      isAutonomousGoal('start a new campaine for a rpoeprty which si on rent and i want the clients to get redirected to the website')
    ).toBe(true);
    expect(isAutonomousGoal('create facebook ads for rental property')).toBe(true);
    expect(isAutonomousGoal('automate filling out client intake form')).toBe(true);
    expect(isAutonomousGoal('redirect customer to payment link')).toBe(true);

    expect(isAutonomousGoal('how to upload a file')).toBe(false);
    expect(isAutonomousGoal('where is the settings button')).toBe(false);
    expect(isAutonomousGoal('point to the export option')).toBe(false);
    expect(isAutonomousGoal('show me where to click')).toBe(false);
  });

  it('formats rich contextual task prompt with browser info and instructions', () => {
    const formatted = formatContextualTaskPrompt('launch marketing campaign for rental flat', {
      app: 'Arc',
      title: 'Meta Ads Manager',
      url: 'https://adsmanager.facebook.com/ads/manage',
      isBrowser: true,
    });

    expect(formatted).toContain('Goal: launch marketing campaign for rental flat');
    expect(formatted).toContain('Frontmost Application: Arc');
    expect(formatted).toContain('Window Title: Meta Ads Manager');
    expect(formatted).toContain('Active URL: https://adsmanager.facebook.com/ads/manage');
    expect(formatted).toContain('Application Type: Web Browser');
    expect(formatted).toContain('Autonomous Research:');
    expect(formatted).toContain('Full-Speed Execution:');
  });
});
