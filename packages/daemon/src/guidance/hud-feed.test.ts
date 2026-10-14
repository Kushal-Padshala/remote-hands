import { describe, it, expect } from 'vitest';
import { HudFeed, flattenResult, plainSummary } from './hud-feed.js';

function run(events: unknown[]) {
  const out: Array<{ status: string; text: string; role?: string }> = [];
  const feed = new HudFeed((status, text, role) => out.push({ status, text, ...(role ? { role } : {}) }));
  for (const e of events) feed.event(e);
  return out;
}
const mcp = (id: string, ToolName: string, Arguments: Record<string, unknown> = {}) => ({
  kind: 'tool_call', payload: { tool: 'call_mcp_tool', call_id: id, input: { ServerName: 'rh-computer', ToolName, Arguments } },
});
const done = (id: string, output: unknown, ok = true) => ({ kind: 'tool_result', payload: { call_id: id, ok, output } });
const envelope = (text: string, isError = false) => JSON.stringify({ isError, content: [{ type: 'text', text }] });
const lines = (out: ReturnType<typeof run>) => out.filter((u) => u.text).map((u) => u.text);
const text = (t: string) => ({ kind: 'agent_text', payload: { text: t } });

describe('HudFeed', () => {
  it('turns a streamed answer and its reasoning into one quiet status word each, never a line per fragment', () => {
    const out = run([
      { kind: 'thinking', payload: { text: 'Reasoned for 1.0s' } },
      { kind: 'thinking', payload: { text: 'more' } },
      ...['### Summary', ' of what', ' was done', '.'].map(text),
      { kind: 'status', payload: { status: 'running' } },
      { kind: 'result', payload: { summary: 'x' } },
    ]);
    expect(out).toEqual([{ status: 'THINKING', text: '' }, { status: 'WRITING', text: '' }]);
  });

  it('says what happened in plain words; what was typed and the field name are never shown', () => {
    const out = run([
      mcp('1', 'browser_open', { url: 'https://www.console.cloud.google.com/apis/credentials?project=x' }), done('1', 'opened https://x\nbrowser: Chrome'),
      mcp('2', 'browser_snapshot'), done('2', 'browser: Chrome · page: x'),
      mcp('3', 'browser_click', { index: 72 }), done('3', 'clicked [72] Android client 2\nchanged: page navigated'),
      mcp('4', 'browser_type', { index: 7, text: 'hunter2-secret' }), done('4', 'typed into [7] PRIVATE_DRAFT_123\nbrowser: Chrome'),
    ]);
    expect(lines(out)).toEqual(['Opened console.cloud.google.com', 'Clicked "Android client 2"', 'Typed into a field']);
    expect(JSON.stringify(out)).not.toMatch(/hunter2|PRIVATE_DRAFT/);
  });

  it('shows only the site name for any URL the agent opens, however it is written', () => {
    const open = (url: unknown) => lines(run([mcp('1', 'browser_open', { url }), done('1', 'opened')]))[0];
    expect(open('example.com/reset?token=SECRET')).toBe('Opened example.com');
    expect(open('https://user:pw@www.host.com:8443/a/b?x=SECRET#frag')).toBe('Opened host.com');
    expect(open('localhost:3000/admin?k=SECRET')).toBe('Opened localhost');
    for (const bad of ['javascript:alert(1)', 'data:text/html,SECRET', 'file:///Users/me/secret.txt', 'about:blank', 'not a url SECRET', '', 42, undefined, `https://${'a'.repeat(100)}.com`]) {
      expect(open(bad)).toBe('Opened a page');
    }
  });

  it('describes a batch by the steps the tool says it ran, not by the plan', () => {
    const out = run([
      mcp('1', 'browser_do', { steps: [{ op: 'type', target: 'Email', text: 'a' }, { op: 'type', index: 4, text: 'b' }, { op: 'check', index: 5, checked: true }, { op: 'click', index: 9 }] }),
      done('1', 'did: type, type, check, click'),
      mcp('2', 'browser_do', { steps: [{ op: 'click', target: 'Next' }] }), done('2', 'did: click'),
      mcp('3', 'browser_do', { steps: [{ op: 'wait', ms: 2000 }] }), done('3', 'did: wait'),
      mcp('4', 'browser_do', { steps: [{ op: 'click', index: 1 }, { op: 'type', index: 2, text: 'x' }, { op: 'click', index: 3 }] }),
      done('4', 'did: click\nstep 1 click ok but the page navigated; remaining steps not run\nbrowser: Chrome'),
    ]);
    expect(lines(out)).toEqual(['Filled in 3 fields and clicked 1 button', 'Clicked "Next"', 'Clicked 1 button']);
    expect(out.filter((u) => !u.text).map((u) => u.status)).toEqual(['FILLING', 'THINKING', 'CLICKING', 'THINKING', 'WAITING', 'THINKING', 'FILLING', 'THINKING']);
  });

  it('reads MCP result envelopes, so an error inside one is never reported as success', () => {
    const out = run([
      mcp('1', 'browser_click', { index: 5 }), done('1', envelope('error: Approval rejected by user: Stop now', true)),
      mcp('2', 'browser_click', { index: 6 }), done('2', envelope('clicked [6] Pay\nbrowser: Chrome')),
      mcp('3', 'browser_open', { url: 'https://a.com' }), done('3', envelope('error: Chrome is not running', true)),
    ]);
    expect(lines(out)).toEqual(["That action wasn't approved, so it was skipped.", 'Clicked "Pay"', "That didn't work."]);
    // something that did not work out is marked as a problem, not as a finished step
    expect(out.filter((u) => u.text).map((u) => u.role)).toEqual(['PROBLEM', 'ACTION', 'PROBLEM']);
    expect(flattenResult(true, { isError: true, content: [{ text: 'x' }] })).toEqual({ ok: false, output: 'x' });
    expect(flattenResult(true, 'plain {not json')).toEqual({ ok: true, output: 'plain {not json' });
    expect(flattenResult(true, envelope('boom', true))).toEqual({ ok: false, output: 'boom' });
    expect(flattenResult(true, undefined)).toEqual({ ok: true, output: '' });
  });

  it('tells apart a refused action, one that ran but is unconfirmed, a timeout and a plain failure', () => {
    const say = (output: string) => lines(run([mcp('1', 'browser_do', { steps: [{ op: 'click', index: 1 }] }), done('1', output, false)]))[0];
    expect(say('error: step 1 click failed: Approval rejected by user: no (no steps ok)')).toBe("That action wasn't approved, so it was skipped.");
    expect(say('error: step 1 click ran, but checking the page afterwards failed: x (step 1 ok)')).toBe("That step ran, but I couldn't confirm it worked.");
    expect(say('error: tool call timed out after 90s')).toBe('That took too long and was stopped.');
    expect(say('error: step 1 click failed: Element [1] changed')).toBe("That didn't work.");
  });

  it('does not repeat an identical line, and keeps quiet when a read or command fails', () => {
    const out = run([
      mcp('1', 'browser_click', { index: 1 }), done('1', 'error: x', false),
      mcp('2', 'browser_click', { index: 1 }), done('2', 'error: x', false),
      mcp('3', 'browser_click', { index: 2 }), done('3', 'clicked [2] Save'),
      mcp('4', 'browser_click', { index: 3 }), done('4', 'clicked [3] Save'),
      mcp('5', 'browser_snapshot'), done('5', 'error: nothing', false),
      { kind: 'tool_call', payload: { tool: 'run_command', call_id: '6', input: { CommandLine: 'false' } } }, done('6', 'exit 1', false),
      { kind: 'tool_call', payload: { tool: 'manage_task', call_id: '7', input: {} } }, done('7', 'x', false),
    ]);
    expect(lines(out)).toEqual(["That didn't work.", 'Clicked "Save"']);
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
    expect(JSON.stringify(out)).not.toMatch(/grep|gemini|secret\.txt|call_mcp_tool|manage_task|view_file|rh-computer/);
  });

  it('passes on a request for the person to act, but not ordinary narration or the final answer', () => {
    const out = run([
      text("I'll click Next now. "), text('Then I will read the page.'),
      mcp('1', 'browser_click', { index: 1 }), done('1', 'clicked [1] Next'),
      text('Please sign in to your '), text('account in the browser. I will wait until you finish.'),
      mcp('2', 'browser_snapshot'), done('2', 'page'),
      text('Please sign in to your account in the browser. I will wait until you finish.'),
      mcp('3', 'browser_snapshot'),
      ...['### Summary\n', 'Everything was done.'].map(text),
    ]);
    expect(out.filter((u) => u.role === 'ATTENTION')).toEqual([{ status: 'WORKING', text: 'Please sign in to your account in the browser.', role: 'ATTENTION' }]);
    expect(lines(out)).toEqual(['Clicked "Next"', 'Please sign in to your account in the browser.']);
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
    const events = [done('zzz', 'clicked [1] Save'), null, 'text', {}, { kind: 'tool_call' }];
    expect(() => run(events)).not.toThrow();
    expect(lines(run(events))).toEqual([]);
  });
});

describe('plainSummary', () => {
  it('removes markdown the HUD cannot render and keeps the content and line breaks', () => {
    const md = '### Summary of Actions\n\n1. **Navigated to Credentials**:\n   - Accessed [Google Cloud](https://console.cloud.google.com) for `q-me`\n* Done\n\n\n\n```sh\nls\n```';
    expect(plainSummary(md)).toBe('Summary of Actions\n\n1. Navigated to Credentials:\n   • Accessed Google Cloud for q-me\n• Done\n\nls');
  });

  it('keeps code exactly as written, inline and fenced', () => {
    expect(plainSummary('Use `__init__` and `a__b__c`.')).toBe('Use __init__ and a__b__c.');
    expect(plainSummary('```python\n# Keep the record\nx = "**secret**"\n```')).toBe('# Keep the record\nx = "**secret**"');
  });

  it('handles links with parentheses, emphasis, strikethrough and tables', () => {
    expect(plainSummary('See [guide](https://example.com/a_(b)) now')).toBe('See guide now');
    expect(plainSummary('*important* and ~~cancelled~~ and **bold** and _x_')).toBe('important and cancelled and bold and _x_');
    expect(plainSummary('| Name | Role |\n| --- | :-: |\n| Ann | Admin |')).toBe('Name · Role\nAnn · Admin');
  });

  it('keeps ordinary text unchanged: math, snake_case, numbered lists, URLs, empty input', () => {
    expect(plainSummary('2 * 3 = 6 and a_b_c and snake_case_name')).toBe('2 * 3 = 6 and a_b_c and snake_case_name');
    expect(plainSummary('1. First\n2. Second')).toBe('1. First\n2. Second');
    expect(plainSummary('Open https://example.com/a_b?x=1&y=2 now')).toBe('Open https://example.com/a_b?x=1&y=2 now');
    expect(plainSummary('')).toBe('');
    expect(plainSummary('a'.repeat(5000)).length).toBe(4001);
  });

  it('stays fast on hostile input: unmatched delimiters, long runs of newlines and spaces', () => {
    const hostile = ['['.repeat(200_000), '\n'.repeat(200_000), '*'.repeat(200_000), '_'.repeat(200_000), '`'.repeat(200_000), '[a]('.repeat(60_000), ' \n'.repeat(100_000), '**a '.repeat(60_000)];
    const started = performance.now();
    for (const h of hostile) plainSummary(h);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  describe('reading a window by sight (the last resort)', () => {
    const NOTICE = "Reading this window by sight, because the app doesn't show its buttons. This takes a moment.";

    it('says it the moment the call starts, so the wait does not look like a hang', () => {
      const out = run([mcp('1', 'desktop_snapshot', { ocr: true })]);
      expect(out).toEqual([{ status: 'READING THE SCREEN', text: NOTICE, role: 'ACTION' }]);
    });

    it('a normal snapshot stays the quiet READING word with no sentence', () => {
      expect(run([mcp('1', 'desktop_snapshot', { app: 'Notes' })])).toEqual([{ status: 'READING', text: '' }]);
      expect(run([mcp('1', 'desktop_snapshot', { ocr: false })])).toEqual([{ status: 'READING', text: '' }]);
    });

    it('says it was read by sight once it is done, then goes back to thinking', () => {
      const out = run([mcp('1', 'desktop_snapshot', { ocr: true }), done('1', 'app: Game\nread by sight (OCR) of Game window: 3 text lines in 400 ms.')]);
      expect(lines(out)).toEqual([NOTICE, 'Read the window by sight']);
      expect(out[out.length - 1]).toEqual({ status: 'THINKING', text: '' });
    });

    it('asks for the Screen Recording switch when that is what is missing', () => {
      const out = run([mcp('1', 'desktop_snapshot', { ocr: true }), done('1', envelope('error: Reading this window by sight needs macOS permission to record the screen (Screen Recording).', true), false)]);
      expect(out.some((u) => u.role === 'PROBLEM' && /Screen Recording permission/.test(u.text))).toBe(true);
    });

    it('any other failure of the slow read is left to the agent to explain', () => {
      const out = run([mcp('1', 'desktop_snapshot', { ocr: true }), done('1', envelope('error: boom', true), false)]);
      expect(lines(out)).toEqual([NOTICE]);
    });

    it('a batch that contains the slow read says so up front too', () => {
      const out = run([{ kind: 'tool_call', payload: { tool: 'call_mcp_tool', call_id: 'b', input: { ServerName: 'rh-computer', ToolName: 'computer_batch', Arguments: { steps: [{ tool: 'desktop_key', args: { combo: 'tab' } }, { tool: 'desktop_snapshot', args: { ocr: true } }] } } } }]);
      expect(lines(out)).toEqual([NOTICE]);
    });

    it('does not repeat the notice twice in a row, but says it again for a later slow read', () => {
      const twice = run([mcp('1', 'desktop_snapshot', { ocr: true }), mcp('2', 'desktop_snapshot', { ocr: true })]);
      expect(lines(twice).filter((l) => l === NOTICE)).toHaveLength(1);
      const later = run([mcp('1', 'desktop_snapshot', { ocr: true }), done('1', 'x'), mcp('2', 'desktop_snapshot', { ocr: true })]);
      expect(lines(later).filter((l) => l === NOTICE)).toHaveLength(2);
    });

    it('a click on text read by sight is announced like any click, by its words', () => {
      const out = run([mcp('1', 'desktop_click', { index: 100003 }), done('1', 'clicked [100003] text "Play" (read by sight)\nread by sight (OCR) of Game window')]);
      expect(lines(out)).toEqual(['Clicked "Play"']);
    });
  });
});
