import { describe, it, expect } from 'vitest';
import { findBrowser } from './browsers.js';
import {
  BrowserAutomationError,
  buildCloseScript,
  buildEvalScript,
  buildFocusScript,
  buildOpenScript,
  buildRunningScript,
  buildTabsScript,
} from './applescript.js';
import { AppleScriptTransport, normalizeTimeout, osascriptResult, type RunOsascript } from './transport.js';

const brave = findBrowser('brave')!;
const safari = findBrowser('safari')!;

interface Call {
  lines: string[];
  argv: string[];
  timeoutMs: number;
}

function fake(result: { stdout?: string; stderr?: string; status?: number | null }): {
  run: RunOsascript;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: RunOsascript = async (lines, argv, timeoutMs) => {
    calls.push({ lines, argv, timeoutMs });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status === undefined ? 0 : result.status,
    };
  };
  return { run, calls };
}

describe('AppleScriptTransport.environment', () => {
  it('parses the frontmost app and running browsers', async () => {
    const f = fake({ stdout: 'Finder\nGoogle Chrome\nBrave Browser\n' });
    const t = new AppleScriptTransport({ run: f.run });
    expect(await t.environment()).toEqual({ frontmost: 'Finder', running: ['Google Chrome', 'Brave Browser'] });
    expect(f.calls[0]!.lines).toEqual(buildRunningScript());
    expect(f.calls[0]!.argv).toEqual([]);
  });

  it('reports a null frontmost when the first line is empty', async () => {
    const f = fake({ stdout: '\nSafari\n' });
    const t = new AppleScriptTransport({ run: f.run });
    expect(await t.environment()).toEqual({ frontmost: null, running: ['Safari'] });
  });
});

describe('AppleScriptTransport.evaluate', () => {
  it('passes js, windowId and tabKey as argv to the eval script', async () => {
    const f = fake({ stdout: '  42 \n\n' });
    const t = new AppleScriptTransport({ run: f.run });
    const out = await t.evaluate(brave, { windowId: '7', tabKey: '9' }, 'document.title');
    expect(out).toBe('  42 \n');
    expect(f.calls[0]!.argv).toEqual(['document.title', '7', '9']);
    expect(f.calls[0]!.lines).toEqual(buildEvalScript(brave));
  });

  it('sends empty window and tab for a null target and forwards the timeout', async () => {
    const f = fake({ stdout: 'x\n' });
    const t = new AppleScriptTransport({ run: f.run });
    expect(await t.evaluate(safari, null, '1', 1234)).toBe('x');
    expect(f.calls[0]!.argv).toEqual(['1', '', '']);
    expect(f.calls[0]!.lines).toEqual(buildEvalScript(safari));
    expect(f.calls[0]!.timeoutMs).toBe(1234);
  });

  it('passes hostile JavaScript unchanged', async () => {
    const js = 'const a = "q\'uote" + `tick ${x}` + "\\\\back\\nslash";\nlet e = "😀</script>";\n-x';
    const f = fake({ stdout: '' });
    const t = new AppleScriptTransport({ run: f.run });
    await t.evaluate(brave, null, js);
    expect(f.calls[0]!.argv[0]).toBe(js);
    expect(f.calls[0]!.lines.join('\n')).not.toContain('tick');
  });

  it('rejects with the classified error on failure', async () => {
    const f = fake({
      stderr: 'execution error: Brave Browser got an error: Executing JavaScript through AppleScript is turned off. (12)',
      status: 1,
    });
    const t = new AppleScriptTransport({ run: f.run });
    const err = await t.evaluate(brave, null, '1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserAutomationError);
    expect((err as BrowserAutomationError).code).toBe('js_disabled');
  });

  it('rejects with timeout when the process was killed', async () => {
    const f = fake({ status: null });
    const t = new AppleScriptTransport({ run: f.run });
    const err = await t.evaluate(brave, null, '1').catch((e: unknown) => e);
    expect((err as BrowserAutomationError).code).toBe('timeout');
  });
});

describe('AppleScriptTransport tab operations', () => {
  it('parses the tab listing including quotes and empty titles', async () => {
    const stdout =
      '11\t1\t101\t1\tfalse\tSay "hi" \'there\'\thttps://a.test/?q=1\n' +
      '11\t1\t102\t2\ttrue\t\tabout:blank\n' +
      '22\t2\t201\t1\ttrue\tB\thttps://b.test/\n';
    const f = fake({ stdout });
    const t = new AppleScriptTransport({ run: f.run });
    const tabs = await t.listTabs(brave);
    expect(f.calls[0]!.lines).toEqual(buildTabsScript(brave));
    expect(f.calls[0]!.argv).toEqual([]);
    expect(tabs).toEqual([
      { windowId: '11', windowIndex: 1, tabKey: '101', tabIndex: 1, title: 'Say "hi" \'there\'', url: 'https://a.test/?q=1', active: false },
      { windowId: '11', windowIndex: 1, tabKey: '102', tabIndex: 2, title: '', url: 'about:blank', active: true },
      { windowId: '22', windowIndex: 2, tabKey: '201', tabIndex: 1, title: 'B', url: 'https://b.test/', active: true },
    ]);
  });

  it('returns no tabs for empty output', async () => {
    const t = new AppleScriptTransport({ run: fake({ stdout: '\n' }).run });
    expect(await t.listTabs(brave)).toEqual([]);
  });

  it('focusTab, openUrl and closeTab pass argv to their scripts', async () => {
    const f = fake({ stdout: '' });
    const t = new AppleScriptTransport({ run: f.run });
    await t.focusTab(brave, { windowId: '11', tabKey: '102' });
    await t.openUrl(brave, 'https://x.test/?a="b"');
    await t.openUrl(safari, 'https://y.test/', '5');
    await t.closeTab(safari, { windowId: '5', tabKey: '3' });
    expect(f.calls.map((c) => c.argv)).toEqual([
      ['11', '102'],
      ['https://x.test/?a="b"', ''],
      ['https://y.test/', '5'],
      ['5', '3'],
    ]);
    expect(f.calls[0]!.lines).toEqual(buildFocusScript(brave));
    expect(f.calls[1]!.lines).toEqual(buildOpenScript(brave));
    expect(f.calls[2]!.lines).toEqual(buildOpenScript(safari));
    expect(f.calls[3]!.lines).toEqual(buildCloseScript(safari));
  });

  it('rejects tab operations with classified errors', async () => {
    const t = new AppleScriptTransport({ run: fake({ stderr: 'execution error: rh:no_tab (-2700)', status: 1 }).run });
    const err = await t.focusTab(brave, { windowId: '1', tabKey: '2' }).catch((e: unknown) => e);
    expect((err as BrowserAutomationError).code).toBe('no_tab');
    const err2 = await t.listTabs(brave).catch((e: unknown) => e);
    expect((err2 as BrowserAutomationError).code).toBe('no_tab');
  });
});

describe('fix round 1: transport hardening', () => {
  const secretJs = 'window.secretToken = "abc123-SECRET"';

  it('never leaks the runner error message (command line) into the error', async () => {
    const run: RunOsascript = async () => {
      throw new Error(`Command failed: osascript -e on run argv -- ${secretJs}`);
    };
    const t = new AppleScriptTransport({ run });
    const err = await t.evaluate(brave, null, secretJs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserAutomationError);
    expect((err as BrowserAutomationError).code).toBe('script_error');
    expect((err as BrowserAutomationError).message).not.toContain('SECRET');
  });

  it('maps an execFile failure with empty stderr to a fixed message', () => {
    const e = Object.assign(new Error(`Command failed: osascript -e x -- ${secretJs}`), { code: 2 });
    expect(osascriptResult(e, '', '')).toEqual({ stdout: '', stderr: '', status: 2 });
    const spawnErr = Object.assign(new Error(`spawn osascript ENOENT ${secretJs}`), { code: 'ENOENT' });
    const r = osascriptResult(spawnErr, '', '');
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('SECRET');
    expect(osascriptResult(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL', code: null }), '', '').status).toBeNull();
  });

  it('does not let a non-positive or non-finite timeout disable the timeout', async () => {
    expect(normalizeTimeout(0)).toBe(8000);
    expect(normalizeTimeout(-5)).toBe(8000);
    expect(normalizeTimeout(Number.NaN)).toBe(8000);
    expect(normalizeTimeout(Number.POSITIVE_INFINITY)).toBe(8000);
    expect(normalizeTimeout(250)).toBe(250);
    const f = fake({ stdout: '' });
    const t = new AppleScriptTransport({ run: f.run });
    await t.evaluate(brave, null, '1', 0);
    expect(f.calls[0]!.timeoutMs).toBe(8000);
  });
});

describe('Arc JSON-encoded results', () => {
  it('unwraps exactly one JSON string level for Arc only', async () => {
    const { AppleScriptTransport } = await import('./transport.js');
    const { findBrowser } = await import('./browsers.js');
    const run = async () => ({ stdout: '"{\\"a\\":1,\\"s\\":\\"q\\\\\\"x\\"}"\n', stderr: '', status: 0 });
    const t = new AppleScriptTransport({ run });
    const viaArc = await t.evaluate(findBrowser('arc')!, null, 'x');
    expect(JSON.parse(viaArc)).toEqual({ a: 1, s: 'q"x' });
    const viaBrave = await t.evaluate(findBrowser('brave')!, null, 'x');
    expect(viaBrave.startsWith('"')).toBe(true);
  });

  it('leaves non-JSON-string output alone', async () => {
    const { AppleScriptTransport } = await import('./transport.js');
    const { findBrowser } = await import('./browsers.js');
    const t = new AppleScriptTransport({ run: async () => ({ stdout: '42\n', stderr: '', status: 0 }) });
    expect(await t.evaluate(findBrowser('arc')!, null, 'x')).toBe('42');
    const u = new AppleScriptTransport({ run: async () => ({ stdout: '"not closed\n', stderr: '', status: 0 }) });
    expect(await u.evaluate(findBrowser('arc')!, null, 'x')).toBe('"not closed');
  });
});
