import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HudCoordinator, isAutonomousGoal, formatContextualTaskPrompt, formatHudStatus } from './hud-coordinator.js';

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

  it('formats hud status from various agent stream events', () => {
    expect(
      formatHudStatus({ kind: 'tool_call', payload: { tool: 'desktop', input: { goal: 'Click Submit' } } })
    ).toEqual({
      status: 'EXECUTING',
      text: 'Using desktop: Click Submit',
      role: 'ACTION',
    });

    expect(
      formatHudStatus({ kind: 'thinking', payload: { text: 'Drafting ad copy\nSecond line' } })
    ).toEqual({
      status: 'THINKING',
      text: 'Drafting ad copy',
      role: 'THINK',
    });

    expect(
      formatHudStatus({ kind: 'status', payload: { status: 'running' } })
    ).toEqual({
      status: 'WORKING',
      text: 'Task status: running',
      role: 'STATUS',
    });

    expect(
      formatHudStatus({ kind: 'error', payload: { message: 'Network failed' } })
    ).toEqual({
      status: 'ERROR',
      text: 'Network failed',
      role: 'ERROR',
    });
  });

  it('opens interactive prompt on hotkey and streams live updates', async () => {
    let capturedListener: any;
    mockHudRunner.startListener.mockImplementation((cb: any) => {
      capturedListener = cb;
      return { stop: vi.fn() };
    });

    let submitHandler: any;
    mockHudRunner.openInteractivePrompt = vi.fn().mockImplementation((_app: any, onSubmit: any) => {
      submitHandler = onSubmit;
      return { close: vi.fn() };
    });

    const mockUpdates: Array<{ status: string; text: string }> = [];
    const dummySender = (status: string, text: string) => {
      mockUpdates.push({ status, text });
    };

    const mockStore = {
      createTask: vi.fn().mockResolvedValue({ id: 'task-live-1', status: 'queued' }),
    };

    const liveCoordinator = new HudCoordinator({
      hudRunner: mockHudRunner,
      intentResolver: mockIntentResolver,
      guidanceManager: mockGuidanceManager,
      macosDriver: mockMacOsDriver,
      store: mockStore as any,
    });

    liveCoordinator.startListening();
    expect(mockHudRunner.startListener).toHaveBeenCalled();

    await capturedListener({ event: 'hotkey', app: 'Safari' });
    expect(mockHudRunner.openInteractivePrompt).toHaveBeenCalledWith('Safari', expect.any(Function), expect.any(Function));

    await submitHandler({ query: 'start advertising campaign', app: 'Safari' }, dummySender);
    expect(mockStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'start advertising campaign',
        model: 'gemini-3.8-flash',
        effort: 'low',
      })
    );
    expect(mockUpdates).toContainEqual({
      status: 'THINKING',
      text: 'Analyzing context and initializing agent...',
    });
  });

  it('focuses window on browser task start and on tool call events', async () => {
    mockMacOsDriver.focusWindow = vi.fn().mockResolvedValue(undefined);
    const mockRunner = {
      run: vi.fn().mockImplementation(async (_task: any, onEvent: any) => {
        await onEvent({ kind: 'tool_call', payload: { tool: 'browser' } });
        await onEvent({ kind: 'tool_call', payload: { tool: 'desktop', input: { app: 'Notes' } } });
        return { status: 'success', summary: 'done' };
      }),
    };

    const mockStore = {
      claimNextTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
      markTaskRunning: vi.fn().mockResolvedValue({ id: 'task-1', kind: 'browser' }),
      appendEvent: vi.fn().mockResolvedValue(undefined),
      completeTask: vi.fn().mockResolvedValue(undefined),
    };

    const testCoordinator = new HudCoordinator({
      hudRunner: mockHudRunner,
      intentResolver: mockIntentResolver,
      guidanceManager: mockGuidanceManager,
      macosDriver: mockMacOsDriver,
      store: mockStore as any,
      runner: mockRunner as any,
    });

    await testCoordinator.executeTaskStandalone({ id: 'task-1', kind: 'browser' } as any);
    expect(mockMacOsDriver.focusWindow).toHaveBeenCalledWith('Google Chrome');
    expect(mockMacOsDriver.focusWindow).toHaveBeenCalledWith('Notes');
  });

  it('cancels running task and updates store when cancelActiveTask is invoked', async () => {
    let capturedSignal: AbortSignal | undefined;
    const mockRunner = {
      run: vi.fn().mockImplementation(async (_task: any, _onEvent: any, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ status: 'done', summary: 'Task cancelled by user' });
          });
        });
      }),
    };

    const mockStore = {
      claimNextTask: vi.fn().mockResolvedValue({ id: 'task-cancel-1' }),
      markTaskRunning: vi.fn().mockResolvedValue({ id: 'task-cancel-1' }),
      appendEvent: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue({ id: 'task-cancel-1', status: 'cancelled' }),
      completeTask: vi.fn(),
    };

    const cancelCoordinator = new HudCoordinator({
      hudRunner: mockHudRunner,
      intentResolver: mockIntentResolver,
      guidanceManager: mockGuidanceManager,
      macosDriver: mockMacOsDriver,
      store: mockStore as any,
      runner: mockRunner as any,
    });

    const executionPromise = cancelCoordinator.executeTaskStandalone({ id: 'task-cancel-1' } as any);
    expect(cancelCoordinator.hasActiveTask()).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    await cancelCoordinator.cancelActiveTask('User closed overlay');
    await executionPromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(mockStore.cancelTask).toHaveBeenCalledWith('task-cancel-1', 'User closed overlay');
    expect(mockStore.appendEvent).toHaveBeenCalledWith('task-cancel-1', {
      kind: 'status',
      payload: { status: 'cancelled' },
    });
    expect(mockStore.completeTask).not.toHaveBeenCalled();
    expect(cancelCoordinator.hasActiveTask()).toBe(false);
  });

  it('cancels active execution when user closes or cancels the HUD interactive prompt', async () => {
    let cancelCallback: any;
    let submitCallback: any;
    mockHudRunner.openInteractivePrompt = vi.fn().mockImplementation((_app: any, onSubmit: any, onCancel: any) => {
      submitCallback = onSubmit;
      cancelCallback = onCancel;
      return { close: vi.fn() };
    });

    let capturedSignal: AbortSignal | undefined;
    const mockRunner = {
      run: vi.fn().mockImplementation(async (_task: any, _onEvent: any, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ status: 'done', summary: 'Task cancelled by user' });
          });
        });
      }),
    };

    const mockStore = {
      createTask: vi.fn().mockResolvedValue({ id: 'task-prompt-cancel', status: 'queued' }),
      claimNextTask: vi.fn().mockResolvedValue({ id: 'task-prompt-cancel' }),
      markTaskRunning: vi.fn().mockResolvedValue({ id: 'task-prompt-cancel' }),
      appendEvent: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue({ id: 'task-prompt-cancel', status: 'cancelled' }),
      completeTask: vi.fn(),
    };

    const coordinator = new HudCoordinator({
      hudRunner: mockHudRunner,
      intentResolver: mockIntentResolver,
      guidanceManager: mockGuidanceManager,
      macosDriver: mockMacOsDriver,
      store: mockStore as any,
      runner: mockRunner as any,
      autoExecute: true,
    });

    const promptPromise = coordinator.triggerPrompt('Google Chrome');
    await submitCallback({ query: 'start ad campaign on facebook', app: 'Google Chrome' }, () => {});

    expect(coordinator.hasActiveTask()).toBe(true);

    cancelCallback();
    await promptPromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(mockStore.cancelTask).toHaveBeenCalledWith('task-prompt-cancel', expect.stringContaining('Spotlight HUD'));
    expect(coordinator.hasActiveTask()).toBe(false);
  });
});
