import { describe, it, expect } from 'vitest';
import { HudFeed, plainSummary } from './hud-feed.js';

function run(events: unknown[]) {
  const out: Array<{ status: string; text: string; role?: string }> = [];
  const feed = new HudFeed((status, text, role) => out.push({ status, text, ...(role ? { role } : {}) }));
  for (const e of events) feed.event(e);
  return out;
}
const mcp = (id: string, ToolName: string, Arguments: Record<string, unknown> = {}) => ({
  kind: 'tool_call', payload: { tool: 'call_mcp_tool', call_id: id, input: { ServerName: 'rh-computer', ToolName, Arguments } },
});
const done = (id: string, output: string, ok = true) => ({ kind: 'tool_result', payload: { call_id: id, ok, output } });
const lines = (out: ReturnType<typeof run>) => out.filter((u) => u.text).map((u) => u.text);

describe('HudFeed', () => {
  it('turns a streamed answer and its reasoning into one quiet status word each, never a line per fragment', () => {
    const out = run([
      { kind: 'thinking', payload: { text: 'Reasoned for 1.0s' } },
      { kind: 'thinking', payload: { text: 'more' } },
      ...['### Summary', ' of what', ' was done', '.'].map((text) => ({ kind: 'agent_text', payload: { text } })),
      { kind: 'status', payload: { status: 'running' } },
      { kind: 'result', payload: { summary: 'x' } },
    ]);
    expect(out).toEqual([{ status: 'THINKING', text: '' }, { status: 'WRITING', text: '' }]);
  });

  it('says what happened in plain words, using the names the page showed', () => {
    const out = run([
      mcp('1', 'browser_open', { url: 'https://www.console.cloud.google.com/apis/credentials?project=x' }), done('1', 'opened https://x\nbrowser: Chrome'),
      mcp('2', 'browser_snapshot'), done('2', 'browser: Chrome · page: x'),
      mcp('3', 'browser_click', { index: 72 }), done('3', 'clicked [72] Android client 2\nchanged: page navigated'),
      mcp('4', 'browser_type', { index: 7, text: 'hunter2-secret' }), done('4', 'typed into [7] Email\nbrowser: Chrome'),
    ]);
    expect(lines(out)).toEqual(['Opened console.cloud.google.com', 'Clicked "Android client 2"', 'Typed into "Email"']);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('summarises a batch of steps and names a single labelled step', () => {
    const out = run([
      mcp('1', 'browser_do', { steps: [{ op: 'type', target: 'Email', text: 'a' }, { op: 'type', index: 4, text: 'b' }, { op: 'check', index: 5, checked: true }, { op: 'click', index: 9 }] }),
      done('1', 'did: type, type, check, click'),
      mcp('2', 'browser_do', { steps: [{ op: 'click', target: 'Next' }] }), done('2', 'did: click'),
      mcp('3', 'browser_do', { steps: [{ op: 'wait', ms: 2000 }] }), done('3', 'did: wait'),
    ]);
    expect(lines(out)).toEqual(['Filled in 3 fields and clicked 1 button', 'Clicked "Next"']);
    expect(out.filter((u) => !u.text).map((u) => u.status)).toEqual(['FILLING', 'THINKING', 'CLICKING', 'THINKING', 'WAITING', 'THINKING']);
  });

  it('shows a failure once, plainly, and does not repeat an identical line', () => {
    const out = run([
      mcp('1', 'browser_click', { index: 1 }), done('1', 'error: Element [1] changed', false),
      mcp('2', 'browser_click', { index: 1 }), done('2', 'error: Element [1] changed', false),
      mcp('3', 'browser_click', { index: 2 }), done('3', 'clicked [2] Save'),
      mcp('4', 'browser_click', { index: 3 }), done('4', 'clicked [3] Save'),
    ]);
    expect(lines(out)).toEqual(["That didn't work. Trying another way.", 'Clicked "Save"']);
  });

  it('describes desktop tools, commands and file edits without exposing raw commands or tool names', () => {
    const out = run([
      { kind: 'tool_call', payload: { tool: 'run_command', call_id: 'a', input: { CommandLine: 'grep -roh "[0-9A-F]{40,}" ~/.gemini' } } }, done('a', 'abc'),
      { kind: 'tool_call', payload: { tool: 'view_file', call_id: 'b', input: { AbsolutePath: '/Users/me/secret.txt' } } }, done('b', '12 lines'),
      { kind: 'tool_call', payload: { tool: 'write_to_file', call_id: 'c', input: { TargetFile: '/Users/me/notes/todo.md' } } }, done('c', 'ok'),
      mcp('d', 'desktop_open', { app: 'Notes' }), done('d', 'opened Notes\n...'),
      mcp('e', 'desktop_click', { index: 3 }), done('e', 'clicked [3] Button "Save"\n...'),
      mcp('f', 'desktop_key', { combo: 'cmd+s' }), done('f', 'pressed cmd+s'),
      { kind: 'tool_call', payload: { tool: 'manage_task', call_id: 'g', input: {} } }, done('g', 'x'),
    ]);
    expect(lines(out)).toEqual(['Ran a command on your computer', 'Edited todo.md', 'Opened Notes', 'Clicked "Save"', 'Pressed cmd+s']);
    const all = JSON.stringify(out);
    expect(all).not.toMatch(/grep|gemini|secret\.txt|call_mcp_tool|manage_task|view_file|rh-computer/);
  });

  it('shows an agent error once, trimmed to one short line', () => {
    const out = run([
      { kind: 'error', payload: { message: `Rate limited\n${'x'.repeat(400)}` } },
      { kind: 'error', payload: { message: `Rate limited\n${'x'.repeat(400)}` } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('ERROR');
    expect(out[0]!.text.length).toBeLessThanOrEqual(140);
    expect(out[0]!.text).not.toContain('\n');
  });

  it('ignores a result it never saw the call for, and malformed events', () => {
    expect(() => run([done('zzz', 'clicked [1] Save'), null, 'text', {}, { kind: 'tool_call' }])).not.toThrow();
    expect(lines(run([done('zzz', 'clicked [1] Save'), null, 'text', {}, { kind: 'tool_call' }]))).toEqual([]);
  });
});

describe('plainSummary', () => {
  it('removes markdown the HUD cannot render and keeps the content and line breaks', () => {
    const md = '### Summary of Actions\n\n1. **Navigated to Credentials**:\n   - Accessed [Google Cloud](https://console.cloud.google.com) for `q-me`\n* Done\n\n\n\n```sh\nls\n```';
    expect(plainSummary(md)).toBe('Summary of Actions\n\n1. Navigated to Credentials:\n   • Accessed Google Cloud for q-me\n• Done\n\nls');
  });

  it('keeps plain text unchanged, handles empty input, and caps very long text', () => {
    expect(plainSummary('Opened the page.')).toBe('Opened the page.');
    expect(plainSummary('')).toBe('');
    expect(plainSummary('a'.repeat(5000)).length).toBe(4001);
    expect(plainSummary('2 * 3 = 6 and a_b_c')).toBe('2 * 3 = 6 and a_b_c');
  });
});
