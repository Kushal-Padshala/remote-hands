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
      focusWindow: vi.fn().mockResolvedValue(undefined),
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
    expect(callArgs.prompt).toContain('PRIORITIZED ACTIVE TARGET MANDATE:');
    expect(callArgs.prompt).toContain('NEVER switch to a different profile');
    expect(callArgs.prompt).toContain('Autonomous Research:');
    expect(callArgs.prompt).toContain('Full-Speed Execution:');
  });

  it('passes windowTitle to getActiveWindowContext when available in prompt result', async () => {
    mockMacOsDriver.getActiveWindowContext = vi.fn().mockResolvedValue({
      app: 'Google Chrome',
      title: 'College Pulse Survey - Guest',
      url: 'https://survey.example.com',
      isBrowser: true,
    });
    const mockStore = {
      createTask: vi.fn().mockResolvedValue({ id: 'task-guest-1' }),
    };

    const taskCoordinator = new HudCoordinator({
      hudRunner: mockHudRunner,
      intentResolver: mockIntentResolver,
      guidanceManager: mockGuidanceManager,
      macosDriver: mockMacOsDriver,
      store: mockStore as any,
    });

    await taskCoordinator.handleResult({
      query: 'complete this survey',
      app: 'Google Chrome',
      windowTitle: 'College Pulse Survey - Guest',
    });

    expect(mockMacOsDriver.getActiveWindowContext).toHaveBeenCalledWith('Google Chrome', 'College Pulse Survey - Guest');
    const created = (mockStore.createTask as any).mock.calls[0][0];
    expect(created.prompt).toContain('PRIORITIZED ACTIVE TARGET MANDATE:');
    expect(created.prompt).toContain('College Pulse Survey - Guest');
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

  it('execution mandate prefers the rh-computer MCP tools, keeps rh shell commands as fallback and the zero-screenshot/zero-mouse rule', () => {
    const formatted = formatContextualTaskPrompt('do it', { app: 'Arc', isBrowser: true });
    const rule5 = formatted.split('\n').find((l) => l.startsWith('5. '))!;
    expect(rule5).toContain('ZERO SCREENSHOTS & ZERO PHYSICAL MOUSE MOVEMENTS');
    for (const tool of ['browser_snapshot', 'browser_click', 'browser_type', 'desktop_snapshot', 'desktop_click', 'computer_batch']) {
      expect(rule5).toContain(tool);
    }
    expect(rule5).toMatch(/fallback/i);
    expect(rule5).toContain('`rh browser snapshot`');
    expect(rule5).toContain('`rh desktop ax-action <app> <index> [action]`');
    expect(rule5).toContain('Never take screenshots and never simulate physical mouse clicks');
  });

  it('formats rich contextual task prompt with user attached context', () => {
    const formatted = formatContextualTaskPrompt(
      'launch marketing campaign',
      {
        app: 'Arc',
        isBrowser: true,
      },
      [
        {
          type: 'browser_tab',
          id: 'tab-1',
          browser: 'Google Chrome',
          profile: 'Personal',
          title: 'Property Listing 101',
          url: 'https://example.com/prop/101',
          tabIndex: 2,
        },
        {
          type: 'local_file',
          id: 'file-1',
          name: 'ad-banner.png',
          path: '/mock/ad-banner.png',
        },
      ],
    );

    expect(formatted).toContain('User Attached Context:');
    expect(formatted).toContain('Property Listing 101');
    expect(formatted).toContain('https://example.com/prop/101');
    expect(formatted).toContain('ad-banner.png');
    expect(formatted).toContain('Target Mandate:');
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
    expect(mockHudRunner.openInteractivePrompt).toHaveBeenCalledWith('Safari', expect.any(Function), expect.any(Function), expect.any(Function));

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

  it('focuses window on browser task start once and does not steal focus on tool call events', async () => {
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
    expect(mockMacOsDriver.focusWindow).toHaveBeenCalledTimes(1);
    expect(mockMacOsDriver.focusWindow).toHaveBeenCalledWith('Google Chrome');
    expect(mockMacOsDriver.focusWindow).not.toHaveBeenCalledWith('Notes');
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

  it('stops running task via stopActiveTask without clearing conversation continuity', async () => {
    let capturedSignal: AbortSignal | undefined;
    const mockRunner = {
      run: vi.fn().mockImplementation(async (_task: any, _onEvent: any, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ status: 'done', summary: 'Task stopped' });
          });
        });
      }),
    };

    const mockStore = {
      claimNextTask: vi.fn().mockResolvedValue({ id: 'task-stop-1' }),
      markTaskRunning: vi.fn().mockResolvedValue({ id: 'task-stop-1' }),
      appendEvent: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue({ id: 'task-stop-1', status: 'cancelled' }),
      completeTask: vi.fn(),
    };

    const stopCoordinator = new HudCoordinator({
      hudRunner: mockHudRunner,
      intentResolver: mockIntentResolver,
      guidanceManager: mockGuidanceManager,
      macosDriver: mockMacOsDriver,
      store: mockStore as any,
      runner: mockRunner as any,
    });

    const executionPromise = stopCoordinator.executeTaskStandalone({ id: 'task-stop-1' } as any);
    expect(stopCoordinator.hasActiveTask()).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    const updateSender = vi.fn();
    await stopCoordinator.stopActiveTask('User pressed stop', updateSender);
    await executionPromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(mockStore.cancelTask).toHaveBeenCalledWith('task-stop-1', 'User pressed stop');
    expect(updateSender).toHaveBeenCalledWith('STOPPED', 'User pressed stop', 'STATUS');
    expect(stopCoordinator.hasActiveTask()).toBe(false);
  });

  it('preserves conversation_id across follow-up prompts in the same HUD session', async () => {
    let submitCallback: any;
    mockHudRunner.openInteractivePrompt = vi.fn().mockImplementation((_app: any, onSubmit: any) => {
      submitCallback = onSubmit;
      return { close: vi.fn() };
    });

    const createdTasks: any[] = [];
    const mockStore = {
      createTask: vi.fn().mockImplementation(async (input: any) => {
        const t = { id: `task-${createdTasks.length + 1}`, ...input };
        createdTasks.push(t);
        return t;
      }),
      markTaskRunning: vi.fn().mockImplementation(async (id: string) => ({ id, status: 'running' })),
      appendEvent: vi.fn().mockResolvedValue(undefined),
      completeTask: vi.fn().mockResolvedValue(undefined),
    };

    const mockRunner = {
      run: vi.fn()
        .mockResolvedValueOnce({ status: 'done', summary: 'Found 3 items', conversationId: 'conv-hud-99' })
        .mockResolvedValueOnce({ status: 'done', summary: 'Added to cart', conversationId: 'conv-hud-99' }),
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

    coordinator.startListening();
    const hotkeyCb = mockHudRunner.startListener.mock.calls[0]![0];
    await hotkeyCb({ event: 'hotkey', app: 'Google Chrome' });

    await submitCallback({ query: 'search laptops on amazon', app: 'Google Chrome' }, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(createdTasks[0].conversation_id).toBeNull();

    await submitCallback({ query: 'click the first result and add to cart', app: 'Google Chrome' }, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(createdTasks[1].conversation_id).toBe('conv-hud-99');
  });

  it('allows stopping active process and executing follow-up instructions in the same chat session', async () => {
    let submitCallback: any;
    let stopCallback: any;
    mockHudRunner.openInteractivePrompt = vi.fn().mockImplementation((_app: any, onSubmit: any, _onCancel: any, onStop: any) => {
      submitCallback = onSubmit;
      stopCallback = onStop;
      return { close: vi.fn() };
    });

    const createdTasks: any[] = [];
    const mockStore = {
      createTask: vi.fn().mockImplementation(async (input: any) => {
        const t = { id: `task-chain-${createdTasks.length + 1}`, ...input };
        createdTasks.push(t);
        return t;
      }),
      claimNextTask: vi.fn().mockImplementation(async () => createdTasks[createdTasks.length - 1]),
      markTaskRunning: vi.fn().mockImplementation(async (id: string) => ({ id, status: 'running' })),
      appendEvent: vi.fn().mockResolvedValue(undefined),
      completeTask: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    };

    let firstAborted = false;
    const mockRunner = {
      run: vi.fn()
        .mockImplementationOnce((_task: any, _onEvent: any, signal?: AbortSignal) => {
          return new Promise((resolve) => {
            signal?.addEventListener('abort', () => {
              firstAborted = true;
              resolve({ status: 'done', summary: 'Cancelled', conversationId: 'conv-chain-1' });
            });
          });
        })
        .mockImplementationOnce((_task: any, _onEvent: any, signal?: AbortSignal) => {
          return Promise.resolve({
            status: 'done',
            summary: 'Downloaded files successfully',
            conversationId: 'conv-chain-1',
          });
        }),
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

    coordinator.startListening();
    const hotkeyCb = mockHudRunner.startListener.mock.calls[0]![0];
    await hotkeyCb({ event: 'hotkey', app: 'Google Chrome' });

    const updateSender = vi.fn();
    await submitCallback({ query: 'open brightspace and start lab 3', app: 'Google Chrome' }, updateSender);
    await new Promise((r) => setTimeout(r, 10));
    expect(coordinator.hasActiveTask()).toBe(true);

    await stopCallback(updateSender);
    await new Promise((r) => setTimeout(r, 10));

    expect(firstAborted).toBe(true);
    expect(coordinator.hasActiveTask()).toBe(false);
    expect(updateSender).toHaveBeenCalledWith('STOPPED', expect.any(String), 'STATUS');

    await submitCallback({ query: 'download CS 350 lab 3 handouts instead', app: 'Google Chrome' }, updateSender);
    await new Promise((r) => setTimeout(r, 20));

    expect(createdTasks.length).toBe(2);
    expect(createdTasks[1].goal).toBe('download CS 350 lab 3 handouts instead');
    expect(updateSender).toHaveBeenCalledWith('COMPLETE', 'Downloaded files successfully', 'DONE');
  });

  it('classifies complex instructional requests as autonomous goals and executes via agent', async () => {
    expect(
      isAutonomousGoal('can you please teach me how to change the color of the overlay which i have added here')
    ).toBe(true);

    const createdTasks: any[] = [];
    const mockStore = {
      createTask: vi.fn().mockImplementation(async (input: any) => {
        const task = {
          id: 'task-teach-1',
          prompt: input.prompt,
          goal: input.goal,
          kind: input.kind,
          status: 'queued',
        };
        createdTasks.push(task);
        return task;
      }),
      appendEvent: vi.fn(),
      completeTask: vi.fn(),
    };

    const mockRunner = {
      run: vi.fn().mockResolvedValue({
        status: 'done',
        summary: 'To change the color in Bambu Studio, click the filament swatch under Project Filaments.',
      }),
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

    const updateSender = vi.fn();
    const result = await coordinator.handleResult(
      { query: 'can you please teach me how to change the color of the overlay which i have added here', app: 'Bambu Studio' },
      updateSender
    );

    await new Promise((r) => setTimeout(r, 20));

    expect(result).toBe(true);
    expect(mockStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'can you please teach me how to change the color of the overlay which i have added here',
      })
    );
    expect(mockRunner.run).toHaveBeenCalled();
    expect(updateSender).toHaveBeenCalledWith(
      'COMPLETE',
      'To change the color in Bambu Studio, click the filament swatch under Project Filaments.',
      'DONE'
    );
  });
});

describe('HudCoordinator default warm runner lifecycle', () => {
  function makeDeps() {
    const hudRunner: any = {
      openPrompt: vi.fn(),
      startListener: vi.fn().mockReturnValue({ stop: vi.fn() }),
      openInteractivePrompt: vi.fn().mockReturnValue({ close: vi.fn() }),
    };
    const fakeRunner = {
      run: vi.fn(),
      prewarm: vi.fn(),
      newConversation: vi.fn(),
      stop: vi.fn(),
    };
    const defaultRunnerFactory = vi.fn(() => fakeRunner as any);
    const deps = {
      hudRunner,
      intentResolver: { resolve: vi.fn() } as any,
      guidanceManager: { startSession: vi.fn() } as any,
      macosDriver: { getActiveWindowContext: vi.fn(), focusWindow: vi.fn() } as any,
      store: {} as any,
      defaultRunnerFactory,
    };
    return { hudRunner, fakeRunner, defaultRunnerFactory, deps };
  }

  it('prewarms the default runner on startListening and stops it on stop()', () => {
    const { fakeRunner, defaultRunnerFactory, deps } = makeDeps();
    const listener = new HudCoordinator(deps).startListening();
    expect(defaultRunnerFactory).toHaveBeenCalledTimes(1);
    expect(fakeRunner.prewarm).toHaveBeenCalledTimes(1);
    expect(fakeRunner.prewarm).toHaveBeenCalledWith({ mode: 'autonomous' });
    expect(fakeRunner.stop).not.toHaveBeenCalled();
    listener.stop();
    expect(fakeRunner.stop).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh warm conversation on a new hotkey session and on cancel', async () => {
    const { hudRunner, fakeRunner, deps } = makeDeps();
    const coordinator = new HudCoordinator(deps);
    coordinator.startListening();
    const cb = hudRunner.startListener.mock.calls[0]![0];
    await cb({ event: 'hotkey', app: 'Google Chrome' });
    expect(fakeRunner.newConversation).toHaveBeenCalledTimes(1);
    expect(fakeRunner.newConversation).toHaveBeenCalledWith({ mode: 'autonomous' });
    await coordinator.cancelActiveTask();
    expect(fakeRunner.newConversation).toHaveBeenCalledTimes(2);
  });

  it('dispose stops the default runner and is idempotent', () => {
    const { fakeRunner, deps } = makeDeps();
    const coordinator = new HudCoordinator(deps);
    coordinator.startListening();
    coordinator.dispose();
    coordinator.dispose();
    expect(fakeRunner.stop).toHaveBeenCalledTimes(1);
  });

  it('whenIdle resolves only after auto-executed tasks finish', async () => {
    let finishRun!: (v: any) => void;
    const runner = { run: vi.fn(() => new Promise((resolve) => { finishRun = resolve; })) };
    const created: any[] = [];
    const store = {
      createTask: vi.fn(async (input: any) => {
        const t = { id: 'task-idle', ...input };
        created.push(t);
        return t;
      }),
      claimNextTask: vi.fn(async () => created[0]),
      markTaskRunning: vi.fn(async (id: string) => ({ id, status: 'running', ...created[0] })),
      appendEvent: vi.fn().mockResolvedValue(undefined),
      completeTask: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const { deps } = makeDeps();
    const coordinator = new HudCoordinator({ ...deps, store: store as any, runner: runner as any, autoExecute: true });
    deps.intentResolver.resolve.mockResolvedValue({ type: 'task' });
    deps.macosDriver.getActiveWindowContext.mockResolvedValue({ app: 'Mail', title: 'Inbox', isBrowser: false });
    await coordinator.handleResult({ query: 'open mail', app: 'Mail' } as any, () => {});
    let idle = false;
    const idlePromise = coordinator.whenIdle().then(() => { idle = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.run).toHaveBeenCalled();
    expect(idle).toBe(false);
    finishRun({ status: 'done', summary: 'ok', conversationId: 'c' });
    await idlePromise;
    expect(idle).toBe(true);
  });

  it('dispose is a no-op when a runner was injected or none was created', () => {
    const { fakeRunner, deps } = makeDeps();
    expect(() => new HudCoordinator(deps).dispose()).not.toThrow();
    expect(() => new HudCoordinator({ ...deps, runner: { run: vi.fn() } as any }).dispose()).not.toThrow();
    expect(fakeRunner.stop).not.toHaveBeenCalled();
  });

  it('does not create or prewarm a default runner when a runner is injected', () => {
    const { hudRunner, fakeRunner, defaultRunnerFactory, deps } = makeDeps();
    const injected = { run: vi.fn() };
    const listener = new HudCoordinator({ ...deps, runner: injected as any }).startListening();
    expect(hudRunner.startListener).toHaveBeenCalled();
    listener.stop();
    expect(defaultRunnerFactory).not.toHaveBeenCalled();
    expect(fakeRunner.prewarm).not.toHaveBeenCalled();
    expect(fakeRunner.stop).not.toHaveBeenCalled();
  });
});
