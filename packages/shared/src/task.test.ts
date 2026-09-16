import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, TASK_STATUSES } from './task.js';

describe('canTransition', () => {
  it('lets a queued task be claimed', () => {
    expect(canTransition('queued', 'claimed')).toBe(true);
  });

  it('refuses to skip claiming', () => {
    expect(canTransition('queued', 'running')).toBe(false);
  });

  it('lets a running task pause for approval and resume', () => {
    expect(canTransition('running', 'awaiting_approval')).toBe(true);
    expect(canTransition('awaiting_approval', 'running')).toBe(true);
  });

  it('allows cancellation from every non-terminal status', () => {
    for (const s of ['queued', 'claimed', 'running', 'awaiting_approval'] as const) {
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });

  it('refuses every transition out of a terminal status', () => {
    for (const from of ['done', 'failed', 'cancelled'] as const) {
      for (const to of TASK_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('refuses a transition to itself', () => {
    expect(canTransition('running', 'running')).toBe(false);
  });
});

describe('isTerminal', () => {
  it('classifies each status', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('awaiting_approval')).toBe(false);
  });
});
