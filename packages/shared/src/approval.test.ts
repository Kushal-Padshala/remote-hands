import { describe, expect, it } from 'vitest';
import { type Approval, hasExpired, isPending, resolveDecision } from './approval.js';

const at = (iso: string) => new Date(iso);

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    task_id: '11111111-1111-4111-8111-111111111111',
    user_id: '22222222-2222-4222-8222-222222222222',
    action_kind: 'publish',
    summary: 'Click Publish on wp-admin post 412',
    risk: 'high',
    tool_payload: {},
    frame_path: null,
    decision: 'pending',
    decided_at: null,
    expires_at: '2026-09-16T10:10:00.000Z',
    created_at: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('isPending', () => {
  it('is true before the deadline', () => {
    expect(isPending(approval(), at('2026-09-16T10:05:00.000Z'))).toBe(true);
  });

  it('is false once the deadline passes', () => {
    expect(isPending(approval(), at('2026-09-16T10:11:00.000Z'))).toBe(false);
  });

  it('is false once a decision was recorded', () => {
    const decided = approval({ decision: 'approved', decided_at: '2026-09-16T10:02:00.000Z' });
    expect(isPending(decided, at('2026-09-16T10:03:00.000Z'))).toBe(false);
  });
});

describe('hasExpired', () => {
  it('does not expire an already-decided approval', () => {
    const decided = approval({ decision: 'approved', decided_at: '2026-09-16T10:02:00.000Z' });
    expect(hasExpired(decided, at('2026-09-16T11:00:00.000Z'))).toBe(false);
  });

  it('expires a pending approval past its deadline', () => {
    expect(hasExpired(approval(), at('2026-09-16T10:10:01.000Z'))).toBe(true);
  });
});

describe('resolveDecision', () => {
  it('returns the recorded decision when one exists', () => {
    const a = approval({ decision: 'approved', decided_at: '2026-09-16T10:02:00.000Z' });
    expect(resolveDecision(a, at('2026-09-16T11:00:00.000Z'))).toBe('approved');
  });

  it('denies by expiring when nobody answered in time', () => {
    expect(resolveDecision(approval(), at('2026-09-16T10:30:00.000Z'))).toBe('expired');
  });

  it('stays pending inside the window', () => {
    expect(resolveDecision(approval(), at('2026-09-16T10:01:00.000Z'))).toBe('pending');
  });
});
