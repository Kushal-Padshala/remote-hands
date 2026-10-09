import { describe, expect, it } from 'vitest';
import { type Approval, classifyRiskyAction, classifyRiskyKey, hasExpired, isPending, resolveDecision } from './approval.js';

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

describe('expiry boundary', () => {
  // All three instants are derived from the same deadline so the
  // millisecond offsets are unambiguous, rather than hand-written ISO
  // strings whose one-millisecond difference would be easy to miss.
  const deadline = approval().expires_at;
  const deadlineMs = Date.parse(deadline);
  const oneMsBefore = new Date(deadlineMs - 1);
  const atDeadline = at(deadline);
  const oneMsAfter = new Date(deadlineMs + 1);

  it('is still pending exactly at expires_at: the deadline has not yet passed', () => {
    const a = approval();
    expect(isPending(a, atDeadline)).toBe(true);
    expect(hasExpired(a, atDeadline)).toBe(false);
    expect(resolveDecision(a, atDeadline)).toBe('pending');
  });

  it('has expired one millisecond after expires_at', () => {
    const a = approval();
    expect(isPending(a, oneMsAfter)).toBe(false);
    expect(hasExpired(a, oneMsAfter)).toBe(true);
    expect(resolveDecision(a, oneMsAfter)).toBe('expired');
  });

  it('is still pending one millisecond before expires_at', () => {
    const a = approval();
    expect(isPending(a, oneMsBefore)).toBe(true);
    expect(hasExpired(a, oneMsBefore)).toBe(false);
    expect(resolveDecision(a, oneMsBefore)).toBe('pending');
  });

  it('agrees across isPending, hasExpired and resolveDecision at every boundary instant', () => {
    for (const now of [oneMsBefore, atDeadline, oneMsAfter]) {
      const a = approval();
      const pending = isPending(a, now);
      const expired = hasExpired(a, now);
      // Exact logical complements: never both true, never both false.
      expect(pending).toBe(!expired);
      expect(resolveDecision(a, now)).toBe(pending ? 'pending' : 'expired');
    }
  });
});

describe('classifyRiskyAction', () => {
  it('flags controls that take irreversible actions', () => {
    expect(classifyRiskyAction('Post')).toBe('publish');
    expect(classifyRiskyAction('Publish now')).toBe('publish');
    expect(classifyRiskyAction('Submit')).toBe('publish');
    expect(classifyRiskyAction('Send')).toBe('send');
    expect(classifyRiskyAction('Place your order')).toBe('pay');
    expect(classifyRiskyAction('Buy now')).toBe('pay');
    expect(classifyRiskyAction('Delete repository')).toBe('delete');
    expect(classifyRiskyAction('Merge pull request')).toBe('push');
  });

  it('leaves ordinary controls alone', () => {
    expect(classifyRiskyAction('Next')).toBeNull();
    expect(classifyRiskyAction('Posts')).toBeNull();
    expect(classifyRiskyAction('Search')).toBeNull();
    expect(classifyRiskyAction('')).toBeNull();
  });

  it('classifies destructive controls regardless of label length', () => {
    const label = 'Delete the entire repository including all of its pull requests and issues';
    expect(classifyRiskyAction(label)).toBe('delete');
    expect(classifyRiskyAction(label, { goal: true })).toBe('delete');
  });
});

describe('classifyRiskyKey', () => {
  it('flags send and delete shortcuts', () => {
    expect(classifyRiskyKey('cmd+enter')).toBe('send');
    expect(classifyRiskyKey('Command+Return')).toBe('send');
    expect(classifyRiskyKey('ctrl+enter')).toBe('send');
    expect(classifyRiskyKey('cmd+shift+d')).toBe('send');
    expect(classifyRiskyKey('cmd+delete')).toBe('delete');
    expect(classifyRiskyKey('cmd+backspace')).toBe('delete');
  });

  it('leaves ordinary keys alone', () => {
    expect(classifyRiskyKey('enter')).toBeNull();
    expect(classifyRiskyKey('return')).toBeNull();
    expect(classifyRiskyKey('cmd+s')).toBeNull();
    expect(classifyRiskyKey('cmd+d')).toBeNull();
    expect(classifyRiskyKey('delete')).toBeNull();
    expect(classifyRiskyKey('')).toBeNull();
  });
});
