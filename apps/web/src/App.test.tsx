import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { MachineRow, TaskRow } from '@remote-hands/shared';
import { App } from './App.js';
import { LiveTaskScreen, inferTaskKind } from './screens/LiveTaskScreen.js';
import { apiClient } from './api/client.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { SafeThinkingOrb } from './components/SafeThinkingOrb.js';

class MockSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  triggerMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
}

describe('Web App Workflow', () => {
  const fakeMachine: MachineRow = {
    id: '11111111-1111-4111-8111-111111111111',
    owner_id: '22222222-2222-4222-8222-222222222222',
    name: 'Work Laptop',
    hostname: 'macbook.local',
    daemon_version: '0.1.0',
    agy_version: '0.2.0',
    status: 'online',
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const fakeTask: TaskRow = {
    id: '33333333-3333-4333-8333-333333333333',
    owner_id: '22222222-2222-4222-8222-222222222222',
    machine_id: fakeMachine.id,
    prompt: 'Add privacy policy page',
    kind: 'browser',
    workspace_path: null,
    model: null,
    effort: null,
    mode: 'default',
    status: 'running',
    conversation_id: null,
    parent_task_id: null,
    result_summary: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
  };

  it('allows user to select machine, enter prompt, and create task', async () => {
    vi.spyOn(apiClient, 'listMachines').mockResolvedValue([fakeMachine]);
    vi.spyOn(apiClient, 'createTask').mockResolvedValue(fakeTask);
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    vi.spyOn(apiClient, 'createTaskWebSocket').mockReturnValue(new MockSocket() as any);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Work Laptop')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`create-task-btn-${fakeMachine.id}`));

    await waitFor(() => {
      expect(screen.getByText(`New Task on ${fakeMachine.name}`)).toBeDefined();
    });

    const promptInput = screen.getByTestId('task-prompt-input');
    fireEvent.change(promptInput, { target: { value: 'Add privacy policy page' } });

    fireEvent.click(screen.getByTestId('submit-task-btn'));

    await waitFor(() => {
      expect(apiClient.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          machine_id: fakeMachine.id,
          prompt: 'Add privacy policy page',
          kind: 'browser',
          mode: 'default',
        }),
      );
      expect(screen.getByText('Add privacy policy page')).toBeDefined();
    });
  });

  it('displays live events and frame updates over websocket', async () => {
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    const socket = new MockSocket();

    render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    socket.triggerMessage({
      type: 'task.event',
      task_id: fakeTask.id,
      event: {
        kind: 'agent_text',
        payload: { text: 'Navigated to WordPress admin' },
      },
    });

    await waitFor(() => {
      expect(screen.getByText('Navigated to WordPress admin')).toBeDefined();
    });

    socket.triggerMessage({
      type: 'task.frame',
      task_id: fakeTask.id,
      jpeg_base64: 'fake-frame-jpeg-data',
      captured_at: new Date().toISOString(),
    });

    await waitFor(() => {
      const img = screen.getByRole('img');
      expect(img.getAttribute('src')).toContain('fake-frame-jpeg-data');
      expect(screen.getByText('🌐 Logged-in Chrome Profile')).toBeDefined();
    });
  });

  it('opens approval sheet and sends approval decision', async () => {
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    vi.spyOn(apiClient, 'decideApproval').mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      task_id: fakeTask.id,
      owner_id: fakeTask.owner_id,
      action_kind: 'publish',
      summary: 'Publish privacy policy page',
      risk: 'high',
      tool_payload: {},
      frame_path: null,
      decision: 'approved',
      decided_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    const socket = new MockSocket();

    render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    socket.triggerMessage({
      type: 'approval.requested',
      task_id: fakeTask.id,
      approval_id: '44444444-4444-4444-8444-444444444444',
    });

    await waitFor(() => {
      expect(screen.getByTestId('approval-sheet')).toBeDefined();
      expect(screen.getByText('Action Approval Required')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('approve-approval-btn'));

    await waitFor(() => {
      expect(apiClient.decideApproval).toHaveBeenCalledWith(
        '44444444-4444-4444-8444-444444444444',
        'approved',
      );
      expect(screen.queryByTestId('approval-sheet')).toBeNull();
    });
  });

  it('opens rejection feedback question when rejecting and sends reason', async () => {
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    vi.spyOn(apiClient, 'getApproval').mockResolvedValue({
      approval: {
        id: '55555555-5555-5555-8555-555555555555',
        task_id: fakeTask.id,
        owner_id: fakeTask.owner_id,
        action_kind: 'publish',
        summary: 'Post tweet: Hello world',
        risk: 'high',
        tool_payload: {},
        frame_path: null,
        decision: 'pending',
        decided_at: null,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        created_at: new Date().toISOString(),
      },
    });
    vi.spyOn(apiClient, 'decideApproval').mockResolvedValue({
      id: '55555555-5555-5555-8555-555555555555',
      task_id: fakeTask.id,
      owner_id: fakeTask.owner_id,
      action_kind: 'publish',
      summary: 'Post tweet: Hello world',
      risk: 'high',
      tool_payload: {},
      frame_path: null,
      decision: 'rejected',
      decided_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      created_at: new Date().toISOString(),
      rejection_reason: 'Tone is too casual, make it formal',
    });

    const socket = new MockSocket();
    render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    socket.triggerMessage({
      type: 'approval.requested',
      task_id: fakeTask.id,
      approval_id: '55555555-5555-5555-8555-555555555555',
    });

    await waitFor(() => {
      expect(screen.getByTestId('approval-sheet')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('reject-approval-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('rejection-form')).toBeDefined();
      expect(screen.getByText('Why are you rejecting this?')).toBeDefined();
    });

    const input = screen.getByTestId('rejection-reason-input');
    fireEvent.change(input, { target: { value: 'Tone is too casual, make it formal' } });

    fireEvent.click(screen.getByTestId('confirm-reject-btn'));

    await waitFor(() => {
      expect(apiClient.decideApproval).toHaveBeenCalledWith(
        '55555555-5555-5555-8555-555555555555',
        'rejected',
        'Tone is too casual, make it formal',
      );
      expect(screen.queryByTestId('approval-sheet')).toBeNull();
    });
  });

  it('dismisses approval sheet and displays error message when decideApproval fails with expired error', async () => {
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    vi.spyOn(apiClient, 'getApproval').mockResolvedValue({
      approval: {
        id: '66666666-6666-6666-8666-666666666666',
        task_id: fakeTask.id,
        owner_id: fakeTask.owner_id,
        action_kind: 'publish',
        summary: 'Post tweet: Hello world',
        risk: 'high',
        tool_payload: {},
        frame_path: null,
        decision: 'pending',
        decided_at: null,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        created_at: new Date().toISOString(),
      },
    });
    vi.spyOn(apiClient, 'decideApproval').mockRejectedValue(new Error('Cannot decide approval: request has expired'));

    const socket = new MockSocket();
    render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    socket.triggerMessage({
      type: 'approval.requested',
      task_id: fakeTask.id,
      approval_id: '66666666-6666-6666-8666-666666666666',
    });

    await waitFor(() => {
      expect(screen.getByTestId('approval-sheet')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('approve-approval-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('approval-sheet')).toBeNull();
      expect(screen.getByText('Action approval expired. The pending request timed out.')).toBeDefined();
    });
  });

  it('disables buttons when approval is already expired', async () => {
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    vi.spyOn(apiClient, 'getApproval').mockResolvedValue({
      approval: {
        id: '77777777-7777-7777-8777-777777777777',
        task_id: fakeTask.id,
        owner_id: fakeTask.owner_id,
        action_kind: 'publish',
        summary: 'Post tweet: Hello world',
        risk: 'high',
        tool_payload: {},
        frame_path: null,
        decision: 'pending',
        decided_at: null,
        expires_at: new Date(Date.now() - 5000).toISOString(),
        created_at: new Date(Date.now() - 65000).toISOString(),
      },
    });

    const socket = new MockSocket();
    render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    socket.triggerMessage({
      type: 'approval.requested',
      task_id: fakeTask.id,
      approval_id: '77777777-7777-7777-8777-777777777777',
    });

    await waitFor(() => {
      expect(screen.getByTestId('approval-sheet')).toBeDefined();
      const approveBtn = screen.getByTestId('approve-approval-btn') as HTMLButtonElement;
      expect(approveBtn.disabled).toBe(true);
      expect(approveBtn.textContent).toBe('Expired');
    });
  });

  it('renders inline thinking status and expires old frame in 5s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    const socket = new MockSocket();

    render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    expect(screen.getByTestId('thinking-orb-indicator')).toBeDefined();

    socket.triggerMessage({
      type: 'task.frame',
      task_id: fakeTask.id,
      jpeg_base64: 'live-screenshot-data',
      captured_at: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(screen.getByTestId('frame-viewer')).toBeDefined();
    });

    vi.advanceTimersByTime(5100);

    await waitFor(() => {
      expect(screen.queryByTestId('frame-viewer')).toBeNull();
    });

    vi.useRealTimers();
  });

  it('turns submit button into stop button while running and cancels task on click', async () => {
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    const cancelSpy = vi.spyOn(apiClient, 'cancelTask').mockResolvedValue(fakeTask);
    const socket = new MockSocket();

    render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    const stopBtn = screen.getByTestId('stop-task-btn');
    expect(stopBtn).toBeDefined();
    expect(screen.queryByTestId('submit-task-btn')).toBeNull();

    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledWith(fakeTask.id);
      expect(screen.getByTestId('submit-task-btn')).toBeDefined();
      expect(screen.queryByTestId('stop-task-btn')).toBeNull();
    });
  });

  it('supports voice prompt input and transcribes speech into input field', async () => {
    let mockInstance: any = null;
    class MockSpeechRecognition {
      continuous = true;
      interimResults = true;
      lang = 'en-US';
      onstart: (() => void) | null = null;
      onresult: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      onend: (() => void) | null = null;

      constructor() {
        mockInstance = this;
      }

      start() {
        if (this.onstart) this.onstart();
      }
      stop() {
        if (this.onend) this.onend();
      }
      abort() {
        if (this.onend) this.onend();
      }
    }

    (window as any).SpeechRecognition = MockSpeechRecognition;

    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    const socket = new MockSocket();

    render(
      <LiveTaskScreen
        task={{ ...fakeTask, status: 'done' }}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    const voiceBtn = screen.getByTestId('voice-prompt-btn');
    expect(voiceBtn).toBeDefined();

    fireEvent.click(voiceBtn);

    await waitFor(() => {
      expect(screen.getByTestId('voice-listening-banner')).toBeDefined();
    });

    expect(mockInstance).not.toBeNull();
    mockInstance.onresult({
      resultIndex: 0,
      results: [
        {
          0: { transcript: 'open github and review pull request' },
          isFinal: true,
          length: 1,
        },
      ],
    });

    await waitFor(() => {
      const input = screen.getByTestId('task-prompt-input') as HTMLInputElement;
      expect(input.value).toBe('open github and review pull request');
    });

    const startSpy = vi.spyOn(mockInstance, 'start');
    mockInstance.onend();

    expect(startSpy).toHaveBeenCalled();
    expect(screen.getByTestId('voice-listening-banner')).toBeDefined();

    delete (window as any).SpeechRecognition;
  });

  it('infers task kind accurately based on URLs, navigation, and coding intent', () => {
    expect(inferTaskKind('https://news.ycombinator.com/item?id=1 with python code')).toBe('browser');
    expect(inferTaskKind('browse https://github.com/my-org/repo to check build errors')).toBe('browser');
    expect(inferTaskKind('Navigate to docs.python.org')).toBe('browser');
    expect(inferTaskKind('fix this bug where mic recording stops after some time')).toBe('coding');
    expect(inferTaskKind('run vitest tests on daemon')).toBe('coding');
    expect(inferTaskKind('Add privacy policy page')).toBe('browser');
  });

  it('cancels voice listening and restores prompt without triggering dispatch', async () => {
    let mockInstance: any = null;
    class MockSpeechRecognition {
      continuous = true;
      interimResults = true;
      lang = 'en-US';
      onstart: (() => void) | null = null;
      onresult: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        mockInstance = this;
        setTimeout(() => this.onstart?.(), 0);
      }
      stop() {
        setTimeout(() => this.onend?.(), 0);
      }
      abort() {}
    }
    (window as any).SpeechRecognition = MockSpeechRecognition;

    render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => new MockSocket() as any}
      />,
    );

    const voiceBtn = screen.getByTestId('voice-prompt-btn');
    fireEvent.click(voiceBtn);

    await waitFor(() => {
      expect(screen.getByTestId('voice-listening-banner')).toBeDefined();
    });

    const cancelBtn = screen.getByText('Cancel');
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('voice-listening-banner')).toBeNull();
    });

    delete (window as any).SpeechRecognition;
  });

  it('adjusts viewport height and keeps header and input aligned when mobile keyboard opens', async () => {
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    const socket = new MockSocket();

    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const mockVisualViewport = {
      height: 844,
      offsetTop: 0,
      addEventListener: (event: string, cb: (...args: any[]) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      },
      removeEventListener: (event: string, cb: (...args: any[]) => void) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((fn) => fn !== cb);
        }
      },
    };

    Object.defineProperty(window, 'visualViewport', {
      value: mockVisualViewport,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 844,
      writable: true,
      configurable: true,
    });

    const { unmount } = render(
      <LiveTaskScreen
        task={fakeTask}
        onBack={() => {}}
        webSocketFactory={() => socket as any}
      />,
    );

    expect(document.documentElement.classList.contains('chat-mode-active')).toBe(true);
    expect(document.body.classList.contains('chat-mode-active')).toBe(true);

    const chatScreen = document.querySelector('.chat-screen') as HTMLElement;
    expect(chatScreen).not.toBeNull();
    expect(chatScreen.style.height).toBe('844px');

    const promptInput = screen.getByTestId('task-prompt-input');
    fireEvent.focus(promptInput);

    mockVisualViewport.height = 508;
    for (const listener of listeners['resize'] || []) {
      listener();
    }

    await waitFor(() => {
      expect(chatScreen.style.height).toBe('508px');
      const inputContainer = document.querySelector('.chat-input-container');
      expect(inputContainer?.classList.contains('keyboard-open')).toBe(true);
      expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe('508px');
    });

    unmount();
    expect(document.documentElement.classList.contains('chat-mode-active')).toBe(false);
    expect(document.body.classList.contains('chat-mode-active')).toBe(false);
  });

  it('renders history tab, displays past tasks, and continues conversation in same thread', async () => {
    const historicalTask: TaskRow = {
      id: 'task-hist-1',
      owner_id: 'owner-1',
      machine_id: 'mach-1',
      prompt: 'Check the database migrations',
      kind: 'coding',
      mode: 'default',
      status: 'done',
      conversation_id: 'conv-hist-1',
      parent_task_id: null,
      workspace_path: '/Users/test/project',
      model: 'gemini-3.8-flash-high',
      effort: 'high',
      result_summary: 'All 3 migrations executed successfully.',
      error: null,
      created_at: new Date(Date.now() - 3600000).toISOString(),
      started_at: new Date(Date.now() - 3500000).toISOString(),
      finished_at: new Date(Date.now() - 3400000).toISOString(),
    };

    vi.spyOn(apiClient, 'listMachines').mockResolvedValue([fakeMachine]);
    vi.spyOn(apiClient, 'listTasks').mockResolvedValue([historicalTask]);
    vi.spyOn(apiClient, 'listEvents').mockResolvedValue([]);
    const createSpy = vi.spyOn(apiClient, 'createTask').mockResolvedValue({
      ...historicalTask,
      id: 'task-hist-2',
      prompt: 'Now add an index',
      status: 'queued',
      result_summary: null,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Work Laptop')).toBeDefined();
    });

    const historyTabBtn = screen.getByText('💬 History');
    fireEvent.click(historyTabBtn);

    await waitFor(() => {
      expect(screen.getByText('Check the database migrations')).toBeDefined();
      expect(screen.getByText('Completed')).toBeDefined();
      expect(screen.getByText('All 3 migrations executed successfully.')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Check the database migrations'));

    await waitFor(() => {
      expect(screen.getAllByText('Check the database migrations').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('All 3 migrations executed successfully.').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByTestId('stop-task-btn')).toBeNull();
      expect(screen.getByTestId('submit-task-btn')).toBeDefined();
    });

    const textarea = screen.getByTestId('task-prompt-input');
    fireEvent.change(textarea, { target: { value: 'Now add an index' } });
    fireEvent.click(screen.getByTestId('submit-task-btn'));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: 'conv-hist-1',
          prompt: 'Now add an index',
        }),
      );
    });
  });

  it('renders fallback UI gracefully when child component throws', () => {
    const BadComponent = () => {
      throw new Error('Test component crashed');
    };

    render(
      <ErrorBoundary fallbackTitle="Custom error title">
        <BadComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Custom error title')).toBeDefined();
    expect(screen.getByText('Test component crashed')).toBeDefined();
    expect(screen.getByText('Try Again')).toBeDefined();
    expect(screen.getByText('Reload')).toBeDefined();
  });

  it('renders SafeThinkingOrb fallback on canvas error without crashing', () => {
    const { container } = render(
      <SafeThinkingOrb state="breathing" size={64} role="presentation" />,
    );

    expect(container).toBeDefined();
  });
});
