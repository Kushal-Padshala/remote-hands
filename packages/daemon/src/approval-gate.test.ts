import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ApprovalRow, RealtimeMessage } from '@remote-hands/shared';
import { CloudflareControlPlaneClient } from './cloudflare-client.js';
import { RealtimeClient } from './realtime-client.js';
import { ApprovalGate } from './approval-gate.js';

describe('ApprovalGate', () => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const approvalId = '22222222-2222-4222-8222-222222222222';
  const ownerId = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createMockClient(): CloudflareControlPlaneClient {
    return {
      createApproval: vi.fn(async (input) => {
        const row: ApprovalRow = {
          id: approvalId,
          task_id: input.task_id,
          owner_id: ownerId,
          action_kind: input.action_kind,
          summary: input.summary,
          risk: input.risk,
          tool_payload: input.tool_payload ?? {},
          frame_path: input.frame_path ?? null,
          decision: 'pending',
          decided_at: null,
          expires_at: new Date(Date.now() + 60000).toISOString(),
          created_at: new Date().toISOString(),
        };
        return row;
      }),
    } as unknown as CloudflareControlPlaneClient;
  }

  function createMockRealtime() {
    let handler: ((msg: RealtimeMessage) => void) | null = null;
    return {
      send: vi.fn(),
      onMessage: vi.fn((fn: (msg: RealtimeMessage) => void) => {
        handler = fn;
        return () => {
          handler = null;
        };
      }),
      triggerMessage: (msg: RealtimeMessage) => {
        if (handler) handler(msg);
      },
    };
  }

  it('creates approval and broadcasts request over realtime', async () => {
    const client = createMockClient();
    const realtime = createMockRealtime();
    const gate = new ApprovalGate({
      client,
      realtime: realtime as unknown as RealtimeClient,
    });

    const approval = await gate.requestApproval({
      taskId,
      actionKind: 'publish',
      summary: 'Publish new post',
      risk: 'high',
    });

    expect(client.createApproval).toHaveBeenCalledWith({
      task_id: taskId,
      action_kind: 'publish',
      summary: 'Publish new post',
      risk: 'high',
      tool_payload: {},
      frame_path: null,
      timeout_ms: undefined,
    });

    expect(realtime.send).toHaveBeenCalledWith({
      type: 'approval.requested',
      task_id: taskId,
      approval_id: approval.id,
    });
  });

  it('resolves approval decision when received over realtime', async () => {
    const client = createMockClient();
    const realtime = createMockRealtime();
    const gate = new ApprovalGate({
      client,
      realtime: realtime as unknown as RealtimeClient,
    });

    const decisionPromise = gate.waitForApprovalDecision(approvalId, 10000);

    realtime.triggerMessage({
      type: 'approval.decided',
      approval_id: approvalId,
      decision: 'approved',
    });

    const result = await decisionPromise;
    expect(result.status).toBe('approved');
    expect(result.approvalId).toBe(approvalId);
  });

  it('resolves as expired on timeout when unanswered', async () => {
    const client = createMockClient();
    const realtime = createMockRealtime();
    const gate = new ApprovalGate({
      client,
      realtime: realtime as unknown as RealtimeClient,
    });

    const decisionPromise = gate.waitForApprovalDecision(approvalId, 5000);

    await vi.advanceTimersByTimeAsync(5000);

    const result = await decisionPromise;
    expect(result.status).toBe('expired');
    expect(result.approvalId).toBe(approvalId);
  });

  it('convenience method resolveApprovalOrTimeout chains creation and decision', async () => {
    const client = createMockClient();
    const realtime = createMockRealtime();
    const gate = new ApprovalGate({
      client,
      realtime: realtime as unknown as RealtimeClient,
      defaultTimeoutMs: 5000,
    });

    const resultPromise = gate.resolveApprovalOrTimeout({
      taskId,
      actionKind: 'shell',
      summary: 'Run rm -rf',
      risk: 'critical',
    });

    await vi.advanceTimersByTimeAsync(10);

    realtime.triggerMessage({
      type: 'approval.decided',
      approval_id: approvalId,
      decision: 'rejected',
    });

    const result = await resultPromise;
    expect(result.status).toBe('rejected');
    expect(result.approvalId).toBe(approvalId);
  });
});
