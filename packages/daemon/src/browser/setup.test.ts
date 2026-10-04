import { describe, it, expect, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { BrowserAutomationError } from './applescript.js';
import { findBrowser } from './browsers.js';
import {
  ACCESSIBILITY_PANE_URL,
  AUTOMATION_PANE_URL,
  BrowserSetup,
  buildEscapeScript,
  buildFrontWindowIdScript,
  buildHelpSearchScript,
  buildLocateMenuItemScript,
  buildMouseClickSwift,
  buildMenuInfoOpenScript,
  buildMenuInfoScript,
  buildOpenMenuForUserScript,
  buildMenuStateScript,
  buildMenuToggleScript,
  buildTempWindowCloseScript,
  buildTempWindowOpenScript,
  buildWindowIdsScript,
  classifyToggleError,
  JS_MENU_ITEM,
  localStatePath,
  parseActiveProfiles,
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
    for (const lines of [buildMenuStateScript(), buildMenuToggleScript(), buildMenuInfoScript(), buildMenuInfoOpenScript(), buildTempWindowOpenScript(brave), buildTempWindowCloseScript(brave), buildHelpSearchScript(), buildOpenMenuForUserScript(), buildEscapeScript(), buildLocateMenuItemScript(), buildFrontWindowIdScript(brave), buildWindowIdsScript(brave)]) {
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
  const TEMP = { stdout: '12345' };
  const joined = (lines: string[]) => lines.join('\n');

  it('reads the menu state with the browser name as the only argument', async () => {
    const { run, calls } = scriptedRun([{ stdout: 'unchecked\n' }]);
    const res = await new BrowserSetup({ transport: fakeTransport(), run, sleep }).menuState(brave);
    expect(res).toEqual({ ok: true, state: 'unchecked' });
    expect(calls[0]!.argv).toEqual(['Brave Browser']);
    expect(calls[0]!.lines).toEqual(buildMenuStateScript());
  });

  it('enableJs trusts the probe: off, open a temp window, click once, verify by probe, close the window', async () => {
    const { run, calls } = scriptedRun([TEMP, { stdout: 'clicked' }]);
    const res = await new BrowserSetup({ transport: probeTransport(['off', 'on']), run, sleep }).enableJs(brave);
    expect(res).toEqual({ ok: true, changed: true, state: 'checked' });
    expect(calls.map((c) => joined(c.lines))).toEqual([
      joined(buildTempWindowOpenScript(brave)),
      joined(buildMenuToggleScript()),
      joined(buildTempWindowCloseScript(brave)),
    ]);
    expect(calls[1]!.argv).toEqual(['Brave Browser']);
    expect(calls[2]!.argv).toEqual(['12345']);
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
    const on = scriptedRun([TEMP, { stdout: 'clicked' }]);
    expect(await new BrowserSetup({ transport: probeTransport(['on', 'off']), run: on.run, sleep }).disableJs(brave)).toEqual({
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

  it('strategy 2: a real mouse click on the opened menu item is tried and verified', async () => {
    const { run, calls } = scriptedRun([TEMP, { stdout: 'clicked' }, { stdout: '640,200' }]);
    const clickAt = vi.fn(async () => true);
    // state check (off), 4 probes after the accessibility press (off), then the real click works.
    const res = await new BrowserSetup({ transport: probeTransport(['off', 'off', 'off', 'off', 'off', 'on']), run, sleep, clickAt }).enableJs(brave);
    expect(res).toEqual({ ok: true, changed: true, state: 'checked' });
    expect(clickAt).toHaveBeenCalledWith(640, 200);
    expect(calls.map((c) => joined(c.lines))).toEqual([
      joined(buildTempWindowOpenScript(brave)),
      joined(buildMenuToggleScript()),
      joined(buildLocateMenuItemScript()),
      joined(buildTempWindowCloseScript(brave)),
    ]);
  });

  it('strategy 3: the Help search is tried when the real click changed nothing', async () => {
    const { run, calls } = scriptedRun([TEMP, { stdout: 'clicked' }, { stdout: '640,200' }, { stdout: 'escaped' }, { stdout: 'searched' }]);
    const clickAt = vi.fn(async () => true);
    const answers: Array<'on' | 'off' | 'nowin'> = [...Array(10).fill('off'), 'on'];
    const res = await new BrowserSetup({ transport: probeTransport(answers), run, sleep, clickAt }).enableJs(brave);
    expect(res).toEqual({ ok: true, changed: true, state: 'checked' });
    expect(calls.map((c) => joined(c.lines))).toEqual([
      joined(buildTempWindowOpenScript(brave)),
      joined(buildMenuToggleScript()),
      joined(buildLocateMenuItemScript()),
      joined(buildEscapeScript()),
      joined(buildHelpSearchScript()),
      joined(buildTempWindowCloseScript(brave)),
    ]);
  });

  it('a click helper that fails or coordinates that do not parse never block the later strategies', async () => {
    const { run } = scriptedRun([TEMP, { stdout: 'clicked' }, { stdout: 'not coordinates' }, { stdout: 'escaped' }, { stdout: 'searched' }]);
    const clickAt = vi.fn(async () => {
      throw new Error('swift missing');
    });
    const answers: Array<'on' | 'off' | 'nowin'> = [...Array(10).fill('off'), 'on'];
    const res = await new BrowserSetup({ transport: probeTransport(answers), run, sleep, clickAt }).enableJs(brave);
    expect(res).toMatchObject({ ok: true });
    expect(clickAt).not.toHaveBeenCalled();
  });

  it('strategy 4: opens the menu for the user, tells them, and waits for the probe', async () => {
    const { run, calls } = scriptedRun([TEMP, { stdout: 'clicked' }, { stdout: '640,200' }, { stdout: 'escaped' }, { stdout: 'searched' }, { stdout: 'opened' }]);
    // state check + 4 + 5 + 6 probes off, one more off in the guide window, then the user clicks.
    const answers: Array<'on' | 'off' | 'nowin'> = [...Array(17).fill('off'), 'on'];
    const guide = vi.fn();
    const res = await new BrowserSetup({ transport: probeTransport(answers), run, sleep, clickAt: async () => true }).enableJs(brave, { onGuide: guide });
    expect(res).toEqual({ ok: true, changed: true, state: 'checked' });
    expect(guide).toHaveBeenCalledTimes(1);
    expect(guide.mock.calls[0]![0]).toContain('Click "Allow JavaScript from Apple Events"');
    expect(calls.some((c) => joined(c.lines) === joined(buildOpenMenuForUserScript()))).toBe(true);
  });

  it('gives manual steps when nothing worked, and closes the open menu and the temp window', async () => {
    const { run, calls } = scriptedRun([
      TEMP,
      { stdout: 'clicked' },
      { stdout: '640,200' },
      { stdout: 'escaped' },
      { stdout: 'searched' },
      { stdout: 'opened' },
    ]);
    const res = await new BrowserSetup({ transport: probeTransport(['off']), run, sleep, clickAt: async () => true }).enableJs(brave, { onGuide: () => {} });
    expect(res).toMatchObject({ ok: false, reason: 'script_error' });
    expect((res as { message: string }).message).toContain('View > Developer > Allow JavaScript from Apple Events');
    const last = calls.slice(-2).map((c) => joined(c.lines));
    expect(last).toEqual([joined(buildEscapeScript()), joined(buildTempWindowCloseScript(brave))]);
  });

  it('without a guide callback it does not open the menu for the user', async () => {
    const { run, calls } = scriptedRun([TEMP, { stdout: 'clicked' }, { stdout: '640,200' }, { stdout: 'escaped' }, { stdout: 'searched' }]);
    const res = await new BrowserSetup({ transport: probeTransport(['off']), run, sleep, clickAt: async () => false }).enableJs(brave);
    expect(res).toMatchObject({ ok: false });
    expect(calls.some((c) => joined(c.lines) === joined(buildOpenMenuForUserScript()))).toBe(false);
  });

  it('hard failures (System Events / Accessibility) stop immediately and close the temp window', async () => {
    const first = scriptedRun([TEMP, { stderr: 'Not authorized to send Apple events to System Events. (-1743)', status: 1 }]);
    expect(await new BrowserSetup({ transport: probeTransport(['off']), run: first.run, sleep }).enableJs(brave)).toMatchObject({
      ok: false,
      reason: 'system_events_denied',
    });
    expect(first.calls.map((c) => joined(c.lines))).toEqual([
      joined(buildTempWindowOpenScript(brave)),
      joined(buildMenuToggleScript()),
      joined(buildTempWindowCloseScript(brave)),
    ]);
    const second = scriptedRun([TEMP, { stderr: 'osascript is not allowed assistive access. (-25211)', status: 1 }]);
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

  it('the toggle script activates the browser, opens the menu path and restores focus', () => {
    const text = joined(buildMenuToggleScript());
    expect(text).toContain('tell application procName to activate');
    expect(text).toContain('click foundBar');
    expect(text).toContain('click foundMid');
    expect(text).toContain('click foundItem');
    expect(text.indexOf('click foundBar')).toBeLessThan(text.indexOf('click foundItem'));
    expect(text).toContain('set frontmost of process prevFront to true');
  });

  it('the Help-search script uses Cmd+Shift+/ and the item name, with the process name from argv', () => {
    const text = joined(buildHelpSearchScript());
    expect(text).toContain('keystroke "/" using {command down, shift down}');
    expect(text).toContain(`keystroke "${JS_MENU_ITEM}"`);
    expect(text).toContain('item 1 of argv');
    expect(text).toContain('exists process procName');
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

describe('BrowserSetup.diagnose', () => {
  const sleep = async () => {};
  it('is read-only unless click is requested', async () => {
    const { run, calls } = scriptedRun([
      { stdout: 'View|Developer|Allow JavaScript from Apple Events|enabled=true|mark=none\n' },
      { stdout: 'windows=1|enabled(before open)=false|enabled(menu open)=true|mark=none\n' },
    ]);
    const lines = await new BrowserSetup({ transport: probeTransport(['off']), run, sleep }).diagnose(brave, { click: false });
    expect(lines[0]).toBe('probe before: js_disabled');
    expect(lines[1]).toContain('before menu: View|Developer|Allow JavaScript from Apple Events|enabled=true|mark=none');
    expect(lines[2]).toContain('front+open menu: windows=1|enabled(before open)=false|enabled(menu open)=true');
    expect(calls.map((c) => c.lines)).toEqual([buildMenuInfoScript(), buildMenuInfoOpenScript()]);
  });

  it('with click: info, toggle, probe, info', async () => {
    const { run, calls } = scriptedRun([
      { stdout: 'View|Developer|X|enabled=true|mark=none' },
      { stdout: 'windows=1|enabled(before open)=false|enabled(menu open)=true|mark=none' },
      { stdout: 'clicked' },
      { stdout: 'View|Developer|X|enabled=true|mark=\u2713' },
    ]);
    const lines = await new BrowserSetup({ transport: probeTransport(['off', 'on']), run, sleep }).diagnose(brave, { click: true });
    expect(calls.map((c) => c.lines)).toEqual([buildMenuInfoScript(), buildMenuInfoOpenScript(), buildMenuToggleScript(), buildMenuInfoScript()]);
    expect(lines.join('\n')).toContain('click: clicked');
    expect(lines.join('\n')).toContain('probe after: ready');
  });

  it('reports script failures instead of throwing', async () => {
    const { run } = scriptedRun([{ stderr: 'Not authorized to send Apple events to System Events. (-1743)', status: 1 }]);
    const lines = await new BrowserSetup({ transport: probeTransport(['off']), run, sleep }).diagnose(brave, { click: false });
    expect(lines.join('\n')).toContain('system_events_denied');
  });
});

describe('BrowserSetup.diagnose per-window probes', () => {
  it('reports one probe per window using explicit tab targets', async () => {
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAutomationError('js_disabled', 'Brave Browser', 'off')) // probe before
      .mockResolvedValueOnce('1') // window 1
      .mockRejectedValueOnce(new BrowserAutomationError('js_disabled', 'Brave Browser', 'off')); // window 2
    const transport = {
      environment: async () => ({ frontmost: null, running: ['Brave Browser'] }),
      evaluate,
      listTabs: async () => [
        { windowId: 'w1', windowIndex: 1, tabKey: 't1', tabIndex: 1, title: '', url: '', active: true },
        { windowId: 'w1', windowIndex: 1, tabKey: 't2', tabIndex: 2, title: '', url: '', active: false },
        { windowId: 'w2', windowIndex: 2, tabKey: 't9', tabIndex: 1, title: '', url: '', active: true },
      ],
    };
    const { run } = scriptedRun([{ stdout: 'a' }, { stdout: 'b' }]);
    const lines = await new BrowserSetup({ transport: transport as any, run, sleep: async () => {} }).diagnose(brave, { click: false });
    expect(lines).toContain('window 1: ready');
    expect(lines).toContain('window 2: js_disabled');
    expect(evaluate.mock.calls[1]![1]).toEqual({ windowId: 'w1', tabKey: 't1' });
    expect(evaluate.mock.calls[2]![1]).toEqual({ windowId: 'w2', tabKey: 't9' });
  });
});

describe('temporary window', () => {
  it('scripts are guarded, never touch a closed browser and pass the id through argv', () => {
    const open = buildTempWindowOpenScript(brave).join('\n');
    expect(open).toContain('application "Brave Browser" is running');
    expect(open).toContain('make new window');
    expect(open).toContain('about:blank');
    const close = buildTempWindowCloseScript(brave).join('\n');
    expect(close).toContain('item 1 of argv');
    expect(close).toContain('close w');
  });

  it('is skipped for Safari', async () => {
    const run = scriptedRun([{ stdout: 'missing' }]);
    await new BrowserSetup({ transport: probeTransport(['nowin']), run: run.run, sleep: async () => {} }).enableJs(safari);
    expect(run.calls.some((c) => c.lines.join('\n') === buildTempWindowOpenScript(safari).join('\n'))).toBe(false);
  });

  it('a failed open is tolerated and no close is attempted', async () => {
    const failOpen = scriptedRun([{ stderr: 'boom', status: 1 }, { stdout: 'clicked' }]);
    const res = await new BrowserSetup({ transport: probeTransport(['off', 'on']), run: failOpen.run, sleep: async () => {} }).enableJs(brave);
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(failOpen.calls.some((c) => c.lines.join('\n') === buildTempWindowCloseScript(brave).join('\n'))).toBe(false);
  });
});

describe('real mouse click helper', () => {
  it('builds Swift with the coordinates as top-level literals and restores the pointer', () => {
    const src = buildMouseClickSwift(640.4, 200.6);
    expect(src).toContain('let px = 640\n');
    expect(src).toContain('let py = 201\n');
    expect(src).toContain('.leftMouseDown');
    expect(src).toContain('.leftMouseUp');
    expect(src).toContain('post(.mouseMoved, saved)');
  });

  const hasSwiftc = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).error === undefined;
  it.skipIf(!hasSwiftc)('type-checks with swiftc (nothing is executed)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rh-click-'));
    const file = path.join(dir, 'main.swift');
    writeFileSync(file, buildMouseClickSwift(10, 20));
    const res = spawnSync('swiftc', ['-typecheck', file], { encoding: 'utf-8' });
    expect(res.status, res.stderr).toBe(0);
  }, 60_000);

  it('the locate script opens the menu path and returns centre coordinates', () => {
    const text = buildLocateMenuItemScript().join('\n');
    expect(text).toContain('click foundBar');
    expect(text).toContain('position of foundItem');
    expect(text).toContain('size of foundItem');
    expect(text).not.toContain('click foundItem');
  });
});

describe('profiles', () => {
  const localState = JSON.stringify({
    profile: {
      last_used: 'Profile 4',
      last_active_profiles: ['Profile 4', 'Profile 5', 'Guest Profile'],
      info_cache: {
        'Profile 4': { name: 'kushal', user_name: 'k@example.com' },
        'Profile 5': { name: 'Work', user_name: '' },
        'Profile 8': { name: 'Unused', user_name: 'u@example.com' },
      },
    },
  });

  it('parseActiveProfiles keeps the last used and last active profiles, skips guest/system, and never throws', () => {
    expect(parseActiveProfiles(localState)).toEqual([
      { dir: 'Profile 4', name: 'kushal', email: 'k@example.com' },
      { dir: 'Profile 5', name: 'Work', email: '' },
    ]);
    expect(parseActiveProfiles('{nope')).toEqual([]);
    expect(parseActiveProfiles('{}')).toEqual([]);
  });

  it('localStatePath knows the Chromium browsers and nothing else', () => {
    expect(localStatePath(findBrowser('chrome')!, '/h')).toBe('/h/Library/Application Support/Google/Chrome/Local State');
    expect(localStatePath(findBrowser('brave')!, '/h')).toBe('/h/Library/Application Support/BraveSoftware/Brave-Browser/Local State');
    expect(localStatePath(findBrowser('safari')!, '/h')).toBeNull();
  });

  it('the front-window-id script is guarded and prints an id', () => {
    const text = buildFrontWindowIdScript(brave).join('\n');
    expect(text).toContain('application "Brave Browser" is running');
    expect(text).toContain('id of front window');
  });

  it('enableForActiveProfiles opens each profile window, flips only where the setting is off, and closes only what it created', async () => {
    const opened: string[] = [];
    // P4 already works; P5 is off, then the accessibility press works.
    const transport = probeTransport(['on', 'off', 'off', 'on']);
    const { run, calls } = scriptedRun([
      { stdout: '1\n' }, // P4 windows before
      { stdout: '1\n101\n' }, // P4 windows after: 101 is new
      { stdout: 'closed' },
      { stdout: '1\n101\n' }, // P5 windows before (user's 1 + a stray)
      { stdout: '1\n101\n102\n' }, // P5 after: 102 is new
      { stdout: 'clicked' },
    ]);
    const progress: string[] = [];
    const setup = new BrowserSetup({
      transport,
      run,
      sleep: async () => {},
      readLocalState: async () => localState,
      openProfileWindow: async (_b, dir) => void opened.push(dir),
    });
    const res = await setup.enableForActiveProfiles(brave, { onProgress: (m) => progress.push(m) });
    expect(opened).toEqual(['Profile 4', 'Profile 5']);
    expect(res.map((r) => [r.profile.dir, r.ok, r.changed])).toEqual([
      ['Profile 4', true, false],
      ['Profile 5', true, true],
    ]);
    expect(progress[0]).toContain('kushal (k@example.com)');
    const closes = calls.filter((c) => c.lines.join('\n') === buildTempWindowCloseScript(brave).join('\n'));
    expect(closes.map((c) => c.argv)).toEqual([['101'], ['102']]);
  });

  it('never closes a window it did not create: when the browser reused an existing window only the new about:blank tab is closed', async () => {
    const closeTab = vi.fn(async () => {});
    let listCall = 0;
    const tab = (windowId: string, tabKey: string, url: string) => ({ windowId, windowIndex: 1, tabKey, tabIndex: 1, title: '', url, active: false });
    const transport = {
      ...probeTransport(['on']),
      listTabs: async () => (listCall++ === 0 ? [tab('w1', 't1', 'https://example.com')] : [tab('w1', 't1', 'https://example.com'), tab('w1', 't9', 'about:blank')]),
      closeTab,
    };
    const { run, calls } = scriptedRun([{ stdout: '1\n' }, { stdout: '1\n' }]); // same window ids before and after
    const setup = new BrowserSetup({
      transport: transport as any,
      run,
      sleep: async () => {},
      readLocalState: async () => JSON.stringify({ profile: { last_used: 'Profile 4', info_cache: { 'Profile 4': { name: 'kushal' } } } }),
      openProfileWindow: async () => {},
    });
    const res = await setup.enableForActiveProfiles(brave);
    expect(res[0]).toMatchObject({ ok: true, changed: false });
    expect(closeTab).toHaveBeenCalledWith(expect.anything(), { windowId: 'w1', tabKey: 't9' });
    expect(calls.some((c) => c.lines.join('\n') === buildTempWindowCloseScript(brave).join('\n'))).toBe(false);
  });

  it('closes nothing when it cannot tell what it created', async () => {
    const closeTab = vi.fn(async () => {});
    const transport = { ...probeTransport(['on']), listTabs: async () => [], closeTab };
    const { run, calls } = scriptedRun([{ stdout: '1\n' }, { stdout: '1\n' }]);
    const setup = new BrowserSetup({
      transport: transport as any,
      run,
      sleep: async () => {},
      readLocalState: async () => JSON.stringify({ profile: { last_used: 'Profile 4', info_cache: {} } }),
      openProfileWindow: async () => {},
    });
    const res = await setup.enableForActiveProfiles(brave);
    expect(res[0]).toMatchObject({ ok: false, message: 'could not open a window for this profile' });
    expect(closeTab).not.toHaveBeenCalled();
    expect(calls.some((c) => c.lines.join('\n') === buildTempWindowCloseScript(brave).join('\n'))).toBe(false);
  });

  it('the temporary-window close script refuses to close a window that holds real tabs', () => {
    const text = buildTempWindowCloseScript(brave).join('\n');
    expect(text).toContain('if (count of tabs of w) is 1 then');
    expect(text).toContain('about:blank');
    expect(text).toContain('return "kept"');
  });

  it('reports a profile whose window cannot be opened and carries on', async () => {
    const setup = new BrowserSetup({
      transport: probeTransport(['on']),
      run: scriptedRun([{ stdout: '' }]).run,
      sleep: async () => {},
      readLocalState: async () => localState,
      openProfileWindow: async (_b, dir) => {
        if (dir === 'Profile 4') throw new Error('open failed');
      },
    });
    const res = await setup.enableForActiveProfiles(brave);
    expect(res[0]).toMatchObject({ ok: false });
    expect(res[1]).toMatchObject({ ok: false, message: 'could not open a window for this profile' });
  });

  it('returns nothing for browsers without a readable Local State', async () => {
    const setup = new BrowserSetup({ transport: probeTransport(['on']), readLocalState: async () => null });
    expect(await setup.enableForActiveProfiles(safari)).toEqual([]);
  });
});
