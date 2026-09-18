import { describe, expect, it } from 'vitest';
import {
  createApproval,
  decideApproval,
  expireApproval,
  evaluateApprovalDecision,
} from './approval-service.js';

describe('approval service lifecycle and timeout rules', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');

  it('creates an approval with default 10-minute timeout and pending status', () => {
    const approval = createApproval({
      ownerId: 'owner-1',
      taskId: 'task-1',
      actionKind: 'publish',
      summary: 'Publish privacy policy',
      risk: 'high',
      toolPayload: { path: '/wp-admin/publish' },
    }, now);

    expect(approval.decision).toBe('pending');
    expect(approval.owner_id).toBe('owner-1');
    expect(approval.task_id).toBe('task-1');
    expect(approval.created_at).toBe(now.toISOString());
    expect(approval.expires_at).toBe('2026-09-16T12:10:00.000Z');
  });

  it('decides an active approval', () => {
    const approval = createApproval({
      ownerId: 'owner-1',
      taskId: 'task-1',
      actionKind: 'publish',
      summary: 'Publish privacy policy',
      risk: 'high',
      toolPayload: {},
    }, now);

    const decideTime = new Date('2026-09-16T12:02:00.000Z');
    const decided = decideApproval(approval, 'approved', decideTime);

    expect(decided.decision).toBe('approved');
    expect(decided.decided_at).toBe(decideTime.toISOString());
  });

  it('records rejection decision with user feedback reason', () => {
    const approval = createApproval({
      ownerId: 'owner-1',
      taskId: 'task-1',
      actionKind: 'publish',
      summary: 'Post to X',
      risk: 'high',
      toolPayload: {},
    }, now);

    const decideTime = new Date('2026-09-16T12:02:00.000Z');
    const decided = decideApproval(approval, 'rejected', 'Needs more details', decideTime);

    expect(decided.decision).toBe('rejected');
    expect(decided.decided_at).toBe(decideTime.toISOString());
    expect(decided.rejection_reason).toBe('Needs more details');
    expect((decided.tool_payload as any).rejection_reason).toBe('Needs more details');
  });

  it('evaluates and expires an approval after deadline', () => {
    const approval = createApproval({
      ownerId: 'owner-1',
      taskId: 'task-1',
      actionKind: 'publish',
      summary: 'Publish privacy policy',
      risk: 'high',
      toolPayload: {},
    }, now);

    const afterDeadline = new Date('2026-09-16T12:10:01.000Z');
    expect(evaluateApprovalDecision(approval, afterDeadline)).toBe('expired');

    const expired = expireApproval(approval, afterDeadline);
    expect(expired.decision).toBe('expired');
  });

  it('rejects decisions on already resolved or expired approvals', () => {
    const approval = createApproval({
      ownerId: 'owner-1',
      taskId: 'task-1',
      actionKind: 'publish',
      summary: 'Publish privacy policy',
      risk: 'high',
      toolPayload: {},
    }, now);

    const decided = decideApproval(approval, 'approved', now);
    expect(() => decideApproval(decided, 'rejected', now)).toThrow(/already resolved/i);

    const afterDeadline = new Date('2026-09-16T12:11:00.000Z');
    expect(() => decideApproval(approval, 'approved', afterDeadline)).toThrow(/expired/i);
  });
});
