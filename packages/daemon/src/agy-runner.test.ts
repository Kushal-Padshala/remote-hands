import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Task } from '@remote-hands/shared';
import {
  buildAgyArgs,
  parseAgyStreamLine,
  StaticAgentRunner,
  ProcessAgentRunner,
  DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT,
  DEFAULT_REMOTE_HANDS_REMINDER,
} from './agy-runner.js';
import { HermesBrain } from './hermes-brain.js';

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
      '--print-timeout',
      '60m',
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

    expect(args).toEqual([
      'agy',
      '-p',
      'Add a privacy policy page',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '60m',
    ]);
  });

  it('defaults effort to low instead of high to minimize startup latency', () => {
    const args = buildAgyArgs(
      task({ workspace_path: null, conversation_id: null, effort: undefined }),
      { agyCommand: 'agy' },
    );
    expect(args).toContain('--effort');
    const effortIndex = args.indexOf('--effort');
    expect(args[effortIndex + 1]).toBe('low');
  });

  it('prepends systemPrompt on initial conversation turn', () => {
    const args = buildAgyArgs(
      task({ conversation_id: null }),
      { agyCommand: 'agy', systemPrompt: '[System Context]' },
    );

    expect(args).toContain('[System Context]\n\nAdd a privacy policy page');
  });

  it('prepends reminder prompt on follow-up conversation turn', () => {
    const args = buildAgyArgs(
      task({ conversation_id: 'conv-123' }),
      { agyCommand: 'agy', systemPrompt: '[System Context]' },
    );

    const promptIdx = args.indexOf('-p');
    expect(args[promptIdx + 1]).toContain('Context Reminder');
    expect(args[promptIdx + 1]).toContain('Add a privacy policy page');
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

  it('parses error result stream records into failure result events', () => {
    expect(
      parseAgyStreamLine(
        '{"event":"result","result":{"conversation_id":"conv-1","status":"ERROR","response":"","error":"quota exceeded"}}',
      ),
    ).toEqual({
      kind: 'result',
      payload: {
        summary: 'quota exceeded',
        conversation_id: 'conv-1',
        duration_seconds: undefined,
      },
    });
  });

  it('parses step_update error messages into error events', () => {
    expect(
      parseAgyStreamLine(
        '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":3,"state":"DONE","step_type":"error_message","error":"tool failed"}}',
      ),
    ).toEqual({
      kind: 'error',
      payload: {
        message: 'tool failed',
        fatal: false,
      },
    });
  });

  it('marks tool results as not ok when tool step has error', () => {
    expect(
      parseAgyStreamLine(
        '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"DONE","step_type":"tool","error":"denied","tool_info":{"name":"run_command"}}}',
      ),
    ).toEqual({
      kind: 'tool_result',
      payload: {
        call_id: '2',
        ok: false,
        output: 'denied',
      },
    });
  });

  it('parses planner_response step updates with content into agent text', () => {
    expect(
      parseAgyStreamLine(
        '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":5,"state":"DONE","step_type":"planner_response","content":"Task completed successfully."}}',
      ),
    ).toEqual({
      kind: 'agent_text',
      payload: {
        text: 'Task completed successfully.',
      },
    });
  });

  it('parses raw PLANNER_RESPONSE log objects into agent text', () => {
    expect(
      parseAgyStreamLine(
        '{"type":"PLANNER_RESPONSE","content":"Final summary report"}',
      ),
    ).toEqual({
      kind: 'agent_text',
      payload: {
        text: 'Final summary report',
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

describe('ProcessAgentRunner with HermesBrain', () => {
  it('uses hermes brain to resolve workspace path, effort, and pass augmented prompt', async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hermes-test-'));
    const testRepoDir = path.join(memoryDir, 'test-repo');
    fs.mkdirSync(testRepoDir, { recursive: true });

    const capturedArgsFile = path.join(memoryDir, 'captured-args.txt');
    const fakeBin = path.join(memoryDir, 'fake-agy');
    fs.writeFileSync(
      fakeBin,
      `#!/bin/sh\nprintf "%s\\n" "$@" > "${capturedArgsFile}"\necho '{"type":"text","text":"ok"}'\necho '{"type":"result","summary":"done"}'\nexit 0\n`,
      'utf-8',
    );
    fs.chmodSync(fakeBin, 0o755);

    const brain = new HermesBrain(memoryDir);
    await brain.ensureInitialized({
      name: 'test-repo',
      path: testRepoDir,
      aliases: ['test-repo'],
    });

    const runner = new ProcessAgentRunner(fakeBin, undefined, brain);
    const testTask = task({
      prompt: 'in test-repo fix header',
      workspace_path: null,
      effort: null,
    });

    const res = await runner.run(testTask);
    expect(res.status).toBe('done');
    expect(testTask.workspace_path).toBe(testRepoDir);
    expect(testTask.effort).toBe('medium');

    const capturedArgs = fs.readFileSync(capturedArgsFile, 'utf-8');
    expect(capturedArgs).toContain('-p');
    expect(capturedArgs).toContain('[Hermes Memory:');
    expect(capturedArgs).toContain('Target workspace:');
    expect(capturedArgs).toContain('in test-repo fix header');

    const memoryContent = await brain.loadMemory();
    expect(memoryContent).toContain('in test-repo fix header');

    fs.rmSync(memoryDir, { recursive: true, force: true });
  });
});

describe('remote hands system prompt and reminder', () => {
  it('includes indexed browser commands and browser-harness in DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT', () => {
    expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('rh browser open "<url>"');
    expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('rh browser snapshot');
    expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('rh browser click <index>');
    expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('rh browser type <index> "<text>"');
    expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain("browser-harness <<'PY' ... PY");
  });

  it('includes indexed browser shortcuts in DEFAULT_REMOTE_HANDS_REMINDER', () => {
    expect(DEFAULT_REMOTE_HANDS_REMINDER).toContain('rh browser snapshot');
    expect(DEFAULT_REMOTE_HANDS_REMINDER).toContain('rh browser click <index>');
  });
});
