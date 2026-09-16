import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, parseEvent, safeParseEvent } from './event.js';

const base = {
  id: 1,
  task_id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  seq: 0,
  created_at: '2026-09-16T10:00:00.000Z',
};

describe('parseEvent', () => {
  it('accepts an agent_text event', () => {
    const event = parseEvent({ ...base, kind: 'agent_text', payload: { text: 'hello' } });
    expect(event.kind).toBe('agent_text');
    if (event.kind === 'agent_text') expect(event.payload.text).toBe('hello');
  });

  it('accepts a browser_action event with an action label', () => {
    const event = parseEvent({
      ...base,
      kind: 'browser_action',
      payload: { action: 'click', label: 'Publish', url: 'https://example.com/wp-admin' },
    });
    if (event.kind === 'browser_action') expect(event.payload.label).toBe('Publish');
  });

  it('accepts a file_diff event', () => {
    const event = parseEvent({
      ...base,
      kind: 'file_diff',
      payload: { path: 'src/a.ts', additions: 3, deletions: 1, patch: '@@ -1 +1 @@' },
    });
    if (event.kind === 'file_diff') expect(event.payload.additions).toBe(3);
  });

  it('rejects an unknown kind', () => {
    expect(() => parseEvent({ ...base, kind: 'nonsense', payload: {} })).toThrow();
  });

  it('rejects a payload that does not match its kind', () => {
    expect(() => parseEvent({ ...base, kind: 'agent_text', payload: { text: 42 } })).toThrow();
  });

  it('rejects a negative sequence number', () => {
    expect(() => parseEvent({ ...base, seq: -1, kind: 'agent_text', payload: { text: 'x' } })).toThrow();
  });

  it('defines a payload schema for every declared kind', () => {
    for (const kind of EVENT_KINDS) {
      expect(() => safeParseEvent({ ...base, kind, payload: {} })).not.toThrow();
    }
  });
});

describe('safeParseEvent', () => {
  it('reports failure without throwing', () => {
    const result = safeParseEvent({ ...base, kind: 'agent_text', payload: { text: 42 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/text/);
  });
});
