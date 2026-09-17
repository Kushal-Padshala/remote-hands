import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { MachineRow, TaskRow } from '@remote-hands/shared';
import { App } from './App.js';
import { LiveTaskScreen } from './screens/LiveTaskScreen.js';
import { apiClient } from './api/client.js';

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
});

