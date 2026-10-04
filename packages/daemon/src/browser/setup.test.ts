import { describe, it, expect, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { BrowserAutomationError } from './applescript.js';
import { findBrowser } from './browsers.js';
import {
  ACCESSIBILITY_PANE_URL,
  AUTOMATION_PANE_URL,
  BrowserSetup,
  buildMenuStateScript,
  buildMenuToggleScript,
  classifyToggleError,
  JS_MENU_ITEM,
  readSetupState,
  recordDecision,
  shouldOffer,
  type SetupFs,
} from './setup.js';

const brave = findBrowser('brave')!;
const safari = findBrowser('safari')!;

type Run = (lines: string[], argv: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; status: number | null }>;

function fakeTransport(opts: { running?: string[]; evaluate?: () => Promise<string> } = {}) {
  return {
    environment: vi.fn(async () => ({ frontmost: 'Finder', running: opts.running ?? ['Brave Browser'] })),
    evaluate: vi.fn(opts.evaluate ?? (async () => '1')),
  };
}

function scriptedRun(answers: Array<{ stdout?: string; stderr?: string; status?: number | null }>) {
  const calls: Array<{ lines: string[]; argv: string[] }> = [];
  const run: Run = async (lines, argv) => {
    calls.push({ lines, argv });
    const a = answers.shift() ?? { stdout: '', stderr: '', status: 0 };
    return { stdout: a.stdout ?? '', stderr: a.stderr ?? '', status: a.status === undefined ? 0 : a.status };
  };
  return { run, calls };
}

describe('menu scripts', () => {
  it('search for the exact menu item, read the check mark and never interpolate a browser name', () => {
    const state = buildMenuStateScript().join('\n');
    const toggle = buildMenuToggleScript().join('\n');
    for (const text of [state, toggle]) {
      expect(text).toContain('on run argv');
      expect(text).toContain('item 1 of argv');
      expect(text).toContain(`"${JS_MENU_ITEM}"`);
      expect(text).toContain('exists process procName');
      expect(text).toContain('rh:not_running');
      for (const b of ['Brave', 'Chrome', 'Safari', 'Arc', 'Edge']) expect(text).not.toContain(b);
    }
    expect(state).toContain('AXMenuItemMarkChar');
    expect(state).not.toContain('click');
    expect(toggle).toContain('click foundItem');
    expect(toggle).toContain('rh:menu_missing');
  });

  const hasOsacompile = spawnSync('osacompile', ['-h']).error === undefined && process.platform === 'darwin';
  it.skipIf(!hasOsacompile)('both scripts compile (syntax only, nothing is executed)', () => {
    for (const lines of [buildMenuStateScript(), buildMenuToggleScript()]) {
      const args = ['-o', `/tmp/rh-setup-compile-${process.pid}.scpt`];
      for (const l of lines) args.push('-e', l);
      expect(() => execFileSync('osacompile', args, { stdio: 'pipe' })).not.toThrow();
    }
  });
});

describe('classifyToggleError', () => {
  it('maps the known failures', () => {
    expect(classifyToggleError(brave, 'execution error: rh:not_running (-2700)', 1).reason).toBe('not_running');
    expect(classifyToggleError(brave, '1:2: execution error: rh:menu_missing (-2700)', 1).reason).toBe('menu_missing');
    expect(classifyToggleError(brave, 'osascript is not allowed assistive access. (-25211)', 1).reason).toBe('accessibility_denied');
    expect(classifyToggleError(brave, 'execution error: Not authorized to send Apple events to System Events. (-1743)', 1).reason).toBe(
      'system_events_denied',
    );
    expect(classifyToggleError(brave, '', null).reason).toBe('script_error');
    const odd = classifyToggleError(brave, 'weird\n'.repeat(100), 1);
    expect(odd.reason).toBe('script_error');
    expect(odd.message.length).toBeLessThan(400);
  });

  it('does not let page-like text change the class', () => {
    const t = 'execution error: Can’t make {"rh:menu_missing (-2700)"} into type text. (-1700)';
    expect(classifyToggleError(brave, t, 1).reason).toBe('script_error');
  });
});

describe('BrowserSetup.inspect', () => {
  it('never probes a browser that is not running', async () => {
    const transport = fakeTransport({ running: ['Google Chrome'] });
    const res = await new BrowserSetup({ transport }).inspect(brave);
    expect(res.status).toBe('not_running');
    expect(transport.evaluate).not.toHaveBeenCalled();
  });

  it('is ready when the probe works', async () => {
    const res = await new BrowserSetup({ transport: fakeTransport() }).inspect(brave);
    expect(res).toMatchObject({ browser: 'Brave Browser', status: 'ready' });
  });

  it.each([
    ['js_disabled', 'js_disabled'],
    ['automation_denied', 'automation_denied'],
    ['no_window', 'no_window'],
  ] as const)('maps %s', async (code, status) => {
    const transport = fakeTransport({
      evaluate: async () => {
        throw new BrowserAutomationError(code, 'Brave Browser', `msg ${code}`);
      },
    });
    const res = await new BrowserSetup({ transport }).inspect(brave);
    expect(res.status).toBe(status);
    expect(res.message).toBe(`msg ${code}`);
  });

  it('reports other failures as error', async () => {
    const transport = fakeTransport({
      evaluate: async () => {
        throw new BrowserAutomationError('script_error', 'Brave Browser', 'boom');
      },
    });
    expect((await new BrowserSetup({ transport }).inspect(brave)).status).toBe('error');
  });
});

/** A transport whose probe answers come from a queue ('on' | 'off' | 'nowin'); the last answer repeats. */
function probeTransport(answers: Array<'on' | 'off' | 'nowin'>) {
  const t = {
    environment: vi.fn(async () => ({ frontmost: 'Finder', running: ['Brave Browser', 'Safari'] })),
    evaluate: vi.fn(async () => {
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (a === 'on') return '1';
      if (a === 'off') throw new BrowserAutomationError('js_disabled', 'Brave Browser', 'off');
      throw new BrowserAutomationError('no_window', 'Brave Browser', 'no window');
    }),
  };
  return t;
}

describe('BrowserSetup menu toggling', () => {
  const sleep = async () => {};

  it('reads the menu state with the browser name as the only argument', async () => {
    const { run, calls } = scriptedRun([{ stdout: 'unchecked\n' }]);
    const res = await new BrowserSetup({ transport: fakeTransport(), run, sleep }).menuState(brave);
    expect(res).toEqual({ ok: true, state: 'unchecked' });
    expect(calls[0]!.argv).toEqual(['Brave Browser']);
    expect(calls[0]!.lines).toEqual(buildMenuStateScript());
  });

  it('enableJs trusts the probe: off, click once, verify by probe', async () => {
    const { run, calls } = scriptedRun([{ stdout: 'clicked' }]);
    const transport = probeTransport(['off', 'off', 'on']);
    const res = await new BrowserSetup({ transport, run, sleep }).enableJs(brave);
    expect(res).toEqual({ ok: true, changed: true, state: 'checked' });
    expect(calls.map((c) => c.lines)).toEqual([buildMenuToggleScript()]);
    expect(calls[0]!.argv).toEqual(['Brave Browser']);
  });

  it('enableJs never clicks when the probe already works', async () => {
    const { run, calls } = scriptedRun([]);
    const res = await new BrowserSetup({ transport: probeTransport(['on']), run, sleep }).enableJs(brave);
    expect(res).toEqual({ ok: true, changed: false, state: 'checked' });
    expect(calls).toHaveLength(0);
  });

  it('disableJs clicks only when the probe says it is on, and verifies by probe', async () => {
    const off = scriptedRun([]);
    expect(await new BrowserSetup({ transport: probeTransport(['off']), run: off.run, sleep }).disableJs(brave)).toEqual({
      ok: true,
      changed: false,
      state: 'unchecked',
    });
    expect(off.calls).toHaveLength(0);
    const on = scriptedRun([{ stdout: 'clicked' }]);
    expect(await new BrowserSetup({ transport: probeTransport(['on', 'on', 'off']), run: on.run, sleep }).disableJs(brave)).toEqual({
      ok: true,
      changed: true,
      state: 'unchecked',
    });
  });

  it('falls back to the menu check mark only when the probe cannot tell', async () => {
    const checked = scriptedRun([{ stdout: 'checked' }]);
    expect(await new BrowserSetup({ transport: probeTransport(['nowin']), run: checked.run, sleep }).enableJs(brave)).toEqual({
      ok: true,
      changed: false,
      state: 'checked',
    });
    expect(checked.calls).toHaveLength(1);
    const unchecked = scriptedRun([{ stdout: 'unchecked' }, { stdout: 'clicked' }, { stdout: 'checked' }]);
    expect(await new BrowserSetup({ transport: probeTransport(['nowin']), run: unchecked.run, sleep }).enableJs(brave)).toEqual({
      ok: true,
      changed: true,
      state: 'checked',
    });
  });

  it('reports a missing menu item with browser-specific help and never clicks', async () => {
    const a = scriptedRun([{ stdout: 'missing' }]);
    const resSafari = await new BrowserSetup({ transport: probeTransport(['nowin']), run: a.run, sleep }).enableJs(safari);
    expect(resSafari).toMatchObject({ ok: false, reason: 'menu_missing' });
    expect((resSafari as { message: string }).message).toContain('Show features for web developers');
    expect(a.calls).toHaveLength(1);

    const b = scriptedRun([{ stdout: 'missing' }]);
    const resBrave = await new BrowserSetup({ transport: probeTransport(['nowin']), run: b.run, sleep }).enableJs(brave);
    expect((resBrave as { message: string }).message).toContain('non-English');
  });

  it('fails with manual steps when the click never changes the probe', async () => {
    const { run } = scriptedRun([{ stdout: 'clicked' }]);
    const transport = probeTransport(['off']);
    const res = await new BrowserSetup({ transport, run, sleep }).enableJs(brave);
    expect(res).toMatchObject({ ok: false, reason: 'script_error' });
    expect((res as { message: string }).message).toContain('Turn it on yourself');
    // currentState probe + 8 verification probes
    expect(transport.evaluate.mock.calls.length).toBe(9);
  });

  it('classifies osascript failures from the click step', async () => {
    const first = scriptedRun([{ stderr: 'Not authorized to send Apple events to System Events. (-1743)', status: 1 }]);
    expect(await new BrowserSetup({ transport: probeTransport(['off']), run: first.run, sleep }).enableJs(brave)).toMatchObject({
      ok: false,
      reason: 'system_events_denied',
    });
    const second = scriptedRun([{ stderr: 'osascript is not allowed assistive access. (-25211)', status: 1 }]);
    expect(await new BrowserSetup({ transport: probeTransport(['off']), run: second.run, sleep }).enableJs(brave)).toMatchObject({
      ok: false,
      reason: 'accessibility_denied',
    });
  });

  it('handles an unexpected menu answer and a throwing runner', async () => {
    const odd = scriptedRun([{ stdout: 'banana' }]);
    expect(await new BrowserSetup({ transport: fakeTransport(), run: odd.run, sleep }).menuState(brave)).toMatchObject({
      ok: false,
      reason: 'script_error',
    });
    const throwing: Run = async () => {
      throw new Error('secret command line');
    };
    const res = await new BrowserSetup({ transport: fakeTransport(), run: throwing, sleep }).menuState(brave);
    expect(res).toMatchObject({ ok: false, reason: 'script_error' });
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('the toggle script brings the browser forward, opens the menu path and restores focus', () => {
    const text = buildMenuToggleScript().join('\n');
    expect(text).toContain('set frontmost to true');
    expect(text).toContain('click foundBar');
    expect(text).toContain('click foundMid');
    expect(text).toContain('click foundItem');
    expect(text.indexOf('click foundBar')).toBeLessThan(text.indexOf('click foundItem'));
    expect(text).toContain('set frontmost of process prevFront to true');
  });
});

describe('System Settings panes', () => {
  it('opens the Automation and Accessibility panes', async () => {
    const open = vi.fn(async () => {});
    const setup = new BrowserSetup({ transport: fakeTransport(), open });
    await setup.openAutomationPane();
    await setup.openAccessibilityPane();
    expect(open.mock.calls).toEqual([[AUTOMATION_PANE_URL], [ACCESSIBILITY_PANE_URL]]);
    expect(AUTOMATION_PANE_URL).toContain('Privacy_Automation');
    expect(ACCESSIBILITY_PANE_URL).toContain('Privacy_Accessibility');
  });
});

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const log: string[] = [];
  const fs: SetupFs = {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFile: async (p, d) => {
      log.push(`write ${p}`);
      files.set(p, d);
    },
    rename: async (a, b) => {
      log.push(`rename ${a} -> ${b}`);
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    mkdir: async (p) => {
      log.push(`mkdir ${p}`);
    },
  };
  return { fs, files, log };
}

describe('setup state', () => {
  const file = '/state/browser-setup.json';

  it('treats a missing or invalid file as empty', async () => {
    expect(await readSetupState(memoryFs().fs, file)).toEqual({ browsers: {} });
    expect(await readSetupState(memoryFs({ [file]: '{nope' }).fs, file)).toEqual({ browsers: {} });
    expect(await readSetupState(memoryFs({ [file]: '{"browsers":{"X":{"decision":"nope","at":1}}}' }).fs, file)).toEqual({ browsers: {} });
  });

  it('records a decision atomically and keeps the other entries', async () => {
    const m = memoryFs({ [file]: JSON.stringify({ browsers: { Arc: { decision: 'declined', at: '2026-01-01T00:00:00.000Z' } } }) });
    await recordDecision(m.fs, file, 'Brave Browser', 'enabled', () => new Date('2026-10-03T12:00:00.000Z'));
    const saved = JSON.parse(m.files.get(file)!);
    expect(saved.browsers.Arc).toEqual({ decision: 'declined', at: '2026-01-01T00:00:00.000Z' });
    expect(saved.browsers['Brave Browser']).toEqual({ decision: 'enabled', at: '2026-10-03T12:00:00.000Z' });
    expect(m.log.some((l) => l.startsWith('write ') && l.endsWith('.tmp'))).toBe(true);
    expect(m.log.some((l) => l.startsWith('rename ') && l.endsWith(`-> ${file}`))).toBe(true);
  });

  it('shouldOffer is true only for browsers with no recorded decision', async () => {
    const state = { browsers: { Arc: { decision: 'declined' as const, at: 'x' } } };
    expect(shouldOffer(state, 'Arc')).toBe(false);
    expect(shouldOffer(state, 'Safari')).toBe(true);
  });
});
