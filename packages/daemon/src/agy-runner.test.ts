import { describe, expect, it } from 'vitest';
import type { Task } from '@remote-hands/shared';
import { buildAgyArgs, parseAgyStreamLine, StaticAgentRunner } from './agy-runner.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: '11111111-1111-4111-8111-111111111111',
    machine_id: '22222222-2222-4222-8222-222222222222',
    prompt: 'Add a privacy policy page',
    kind: 'browser',
    workspace_path: '/Users/kushal/site',
    model: 'gemini-3.8-flash-low',
    effort: 'medium',
    mode: 'accept-edits',
    status: 'running',
    conversation_id: 'conversation-1',
    parent_task_id: null,
    result_summary: null,
    error: null,
    created_at: '2026-09-16T14:00:00.000Z',
    started_at: '2026-09-16T14:01:00.000Z',
    finished_at: null,
    ...overrides,
  };
}

describe('buildAgyArgs', () => {
  it('builds stream-json args without bypassing permissions', () => {
    const args = buildAgyArgs(task(), { agyCommand: 'agy' });

    expect(args).toEqual([
      'agy',
      '-p',
      'Add a privacy policy page',
      '--output-format',
      'stream-json',
      '--add-dir',
      '/Users/kushal/site',
      '--conversation',
      'conversation-1',
      '--mode',
      'accept-edits',
      '--model',
      'gemini-3.8-flash-low',
      '--effort',
      'medium',
    ]);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('omits optional args when the task does not request them', () => {
    const args = buildAgyArgs(
      task({ workspace_path: null, conversation_id: null, mode: 'default', model: null, effort: null }),
      { agyCommand: 'agy' },
    );

    expect(args).toEqual(['agy', '-p', 'Add a privacy policy page', '--output-format', 'stream-json']);
  });
});

describe('parseAgyStreamLine', () => {
  it('ignores empty, invalid and unknown stream lines', () => {
    expect(parseAgyStreamLine('')).toBeNull();
    expect(parseAgyStreamLine('{not-json')).toBeNull();
    expect(parseAgyStreamLine('{"type":"unknown"}')).toBeNull();
  });

  it('parses text stream records into agent events', () => {
    expect(parseAgyStreamLine('{"type":"text","text":"hi"}')).toEqual({
      kind: 'agent_text',
      payload: { text: 'hi' },
    });
  });

  it('parses result stream records into typed result events', () => {
    expect(
      parseAgyStreamLine(
        '{"type":"result","summary":"Published page","conversation_id":"conversation-2","duration_seconds":4.2}',
      ),
    ).toEqual({
      kind: 'result',
      payload: {
        summary: 'Published page',
        conversation_id: 'conversation-2',
        duration_seconds: 4.2,
      },
    });
  });
});

describe('StaticAgentRunner', () => {
  it('returns the configured result without launching a process', async () => {
    const runner = new StaticAgentRunner({
      events: [{ kind: 'agent_text', payload: { text: 'done' } }],
      summary: 'Done',
      conversationId: 'conversation-3',
    });

    await expect(runner.run(task())).resolves.toEqual({
      events: [{ kind: 'agent_text', payload: { text: 'done' } }],
      summary: 'Done',
      conversationId: 'conversation-3',
    });
  });
});

