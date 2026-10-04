import { describe, it, expect, vi } from 'vitest';
import { browserSetupCommand, offerBrowserSetupOnce, offerForContext, type BrowserSetupLike } from './browser-setup.js';

type InspectStatus = 'ready' | 'js_disabled' | 'automation_denied' | 'no_window' | 'not_running' | 'error';

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    fs: {
      readFile: async (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
      writeFile: async (p: string, d: string) => void files.set(p, d),
      rename: async (a: string, b: string) => {
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      mkdir: async () => {},
    },
  };
}

interface Script {
  inspect?: Record<string, InspectStatus[]>;
  enable?: Record<string, any>;
  menu?: Record<string, any>;
  disable?: Record<string, any>;
  request?: Record<string, string[]>;
  resetOk?: boolean;
  diagnose?: string[];
  windows?: Array<{ windowIndex: number; status: string }[]> | Array<{ windowIndex: number; status: string }>;
  profiles?: Array<{ profile: { dir: string; name: string; email: string }; ok: boolean; changed: boolean; message?: string }>;
}

function fakeSetup(script: Script = {}) {
  const calls: string[] = [];
  const setup: BrowserSetupLike = {
    inspect: vi.fn(async (b: any) => {
      calls.push(`inspect:${b.name}`);
      const queue = script.inspect?.[b.name] ?? ['ready'];
      const status = (queue.length > 1 ? queue.shift() : queue[0]) as InspectStatus;
      return { browser: b.name, status, message: `msg-${status}` };
    }) as any,
    menuState: vi.fn(async (b: any) => script.menu?.[b.name] ?? { ok: true, state: 'checked' }) as any,
    enableJs: vi.fn(async (b: any) => {
      calls.push(`enable:${b.name}`);
      return script.enable?.[b.name] ?? { ok: true, changed: true, state: 'checked' };
    }) as any,
    disableJs: vi.fn(async (b: any) => {
      calls.push(`disable:${b.name}`);
      return script.disable?.[b.name] ?? { ok: true, changed: true, state: 'unchecked' };
    }) as any,
    requestAutomation: vi.fn(async (b: any) => {
      calls.push(`request:${b.name}`);
      const queue = script.request?.[b.name] ?? ['granted'];
      return (queue.length > 1 ? queue.shift() : queue[0]) as any;
    }) as any,
    resetAutomationConsent: vi.fn(async () => {
      calls.push('reset');
      return script.resetOk ?? true;
    }) as any,
    openAutomationPane: vi.fn(async () => void calls.push('open:automation')) as any,
    openAccessibilityPane: vi.fn(async () => void calls.push('open:accessibility')) as any,
    windowStatuses: vi.fn(async () => {
      const w = script.windows ?? [];
      if (Array.isArray(w[0])) {
        const queue = w as Array<{ windowIndex: number; status: string }[]>;
        return (queue.length > 1 ? queue.shift() : queue[0]) ?? [];
      }
      return w as Array<{ windowIndex: number; status: string }>;
    }) as any,
    enableForActiveProfiles: vi.fn(async () => {
      calls.push('profiles');
      return script.profiles ?? [];
    }) as any,
    diagnose: vi.fn(async (b: any, o: any) => {
      calls.push(`diagnose:${b.name}:${o.click}`);
      return script.diagnose ?? ['probe before: js_disabled'];
    }) as any,
  };
  return { setup, calls };
}

function harness(opts: { running?: string[]; script?: Script; answers?: string[]; isTTY?: boolean; state?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const { setup, calls } = fakeSetup(opts.script);
  const mem = memFs(opts.state);
  const options = {
    stdout: (m: string) => void out.push(m),
    stderr: (m: string) => void err.push(m),
    setup,
    transport: { environment: async () => ({ frontmost: 'Finder', running: opts.running ?? ['Brave Browser'] }) },
    ask: async (q: string) => {
      asked.push(q);
      return answers.shift() ?? '';
    },
    isTTY: opts.isTTY ?? true,
    fs: mem.fs,
    statePath: '/state/browser-setup.json',
    now: () => new Date('2026-10-03T12:00:00.000Z'),
  };
  const state = () => (mem.files.has('/state/browser-setup.json') ? JSON.parse(mem.files.get('/state/browser-setup.json')!) : null);
  return { options, out, err, asked, calls, state };
}

describe('rh browser setup', () => {
  it('prints usage for --help without touching anything', async () => {
    const h = harness();
    expect(await browserSetupCommand(['--help'], h.options)).toBe(0);
    expect(h.out.join('\n')).toContain('Usage: rh browser setup');
    expect(h.calls).toEqual([]);
  });

  it('rejects unknown flags and unknown browsers', async () => {
    const a = harness();
    expect(await browserSetupCommand(['--wat'], a.options)).toBe(1);
    expect(a.err.join('\n')).toContain('Usage');
    const b = harness();
    expect(await browserSetupCommand(['--browser', 'firefox'], b.options)).toBe(1);
    expect(b.err.join('\n')).toContain('Unknown browser');
    expect(b.calls).toEqual([]);
  });

  it('skips browsers that are not running without probing them', async () => {
    const h = harness({ running: ['Google Chrome'], script: { inspect: { 'Google Chrome': ['ready'] } } });
    expect(await browserSetupCommand([], h.options)).toBe(0);
    expect(h.calls).toEqual(['request:Google Chrome', 'inspect:Google Chrome']);
  });

  it('says so when no supported browser is running', async () => {
    const h = harness({ running: [] });
    expect(await browserSetupCommand([], h.options)).toBe(0);
    expect(h.out.join('\n')).toContain('No supported browser is running');
    expect(h.calls).toEqual([]);
  });

  it('reports a ready browser and remembers it', async () => {
    const h = harness();
    await browserSetupCommand([], h.options);
    expect(h.out.join('\n')).toContain('✔ Brave Browser');
    expect(h.state().browsers['Brave Browser'].decision).toBe('enabled');
    expect(h.asked).toEqual([]);
  });

  it('asks before enabling, enables on yes (default) and verifies', async () => {
    const h = harness({ script: { inspect: { 'Brave Browser': ['js_disabled', 'ready'] } }, answers: [''] });
    expect(await browserSetupCommand([], h.options)).toBe(0);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('Enable it in Brave Browser now? [Y/n]');
    expect(h.out.join('\n')).toContain('any app that macOS lets control your browser');
    expect(h.calls).toEqual(['request:Brave Browser', 'inspect:Brave Browser', 'request:System Events', 'enable:Brave Browser', 'inspect:Brave Browser']);
    expect(h.out.join('\n')).toContain('✔ Brave Browser  fast path is on');
    expect(h.state().browsers['Brave Browser'].decision).toBe('enabled');
  });

  it('does not ask with --yes', async () => {
    const h = harness({ script: { inspect: { 'Brave Browser': ['js_disabled', 'ready'] } } });
    await browserSetupCommand(['--yes'], h.options);
    expect(h.asked).toEqual([]);
    expect(h.calls).toContain('enable:Brave Browser');
  });

  it('does not enable on no and remembers the decline', async () => {
    const h = harness({ script: { inspect: { 'Brave Browser': ['js_disabled'] } }, answers: ['n'] });
    expect(await browserSetupCommand([], h.options)).toBe(0);
    expect(h.calls).not.toContain('enable:Brave Browser');
    expect(h.state().browsers['Brave Browser'].decision).toBe('declined');
    expect(h.out.join('\n')).toContain('rh browser setup');
  });

  it('never changes anything without a terminal unless --yes', async () => {
    const h = harness({ script: { inspect: { 'Brave Browser': ['js_disabled'] } }, isTTY: false });
    await browserSetupCommand([], h.options);
    expect(h.asked).toEqual([]);
    expect(h.calls).not.toContain('enable:Brave Browser');
    expect(h.out.join('\n')).toContain('nothing was changed');
    expect(h.state()).toBeNull();
  });

  it('asks macOS for permission up front, with no Enter prompt, and checks right after', async () => {
    const h = harness({ script: { request: { 'Brave Browser': ['granted'] } }, answers: [] });
    await browserSetupCommand([], h.options);
    expect(h.calls.slice(0, 2)).toEqual(['request:Brave Browser', 'inspect:Brave Browser']);
    expect(h.out.join('\n')).toContain('click Allow');
    expect(h.asked).toEqual([]);
  });

  it('when macOS remembers a "Don\'t Allow" it resets this terminal\'s answer and asks again, still with no Enter prompt', async () => {
    const h = harness({ script: { request: { 'Brave Browser': ['denied', 'granted'] } }, answers: [] });
    await browserSetupCommand([], h.options);
    expect(h.calls.slice(0, 4)).toEqual(['request:Brave Browser', 'reset', 'request:Brave Browser', 'inspect:Brave Browser']);
    expect(h.asked).toEqual([]);
    expect(h.out.join('\n')).toContain('✔ Brave Browser');
  });

  it('never blocks: still denied after the reset means skip with a clear next step', async () => {
    const h = harness({ script: { request: { 'Brave Browser': ['denied'] } }, answers: [] });
    expect(await browserSetupCommand([], h.options)).toBe(0);
    expect(h.calls).toContain('open:automation');
    expect(h.calls).not.toContain('inspect:Brave Browser');
    expect(h.asked).toEqual([]);
    expect(h.out.join('\n')).toMatch(/Skipped|skipped/);
  });

  it('does not reset anything when not interactive', async () => {
    const h = harness({ script: { request: { 'Brave Browser': ['denied'] } }, answers: [], isTTY: false });
    await browserSetupCommand([], h.options);
    expect(h.calls).not.toContain('reset');
  });

  it('opens the Automation pane when macOS denied access and re-checks once', async () => {
    const h = harness({ script: { inspect: { 'Brave Browser': ['automation_denied', 'ready'] } }, answers: [''] });
    await browserSetupCommand([], h.options);
    expect(h.calls).toContain('open:automation');
    expect(h.asked[0]).toContain('press Enter');
    expect(h.out.join('\n')).toContain('✔ Brave Browser');
  });
  it('handles accessibility and System Events denials with the matching pane', async () => {
    const a = harness({
      script: { inspect: { 'Brave Browser': ['js_disabled'] }, enable: { 'Brave Browser': { ok: false, reason: 'accessibility_denied', message: 'AX denied' } } },
      answers: ['y'],
    });
    await browserSetupCommand([], a.options);
    expect(a.calls).toContain('open:accessibility');
    expect(a.out.join('\n')).toContain('Accessibility');

    const b = harness({
      script: { inspect: { 'Brave Browser': ['js_disabled'] }, enable: { 'Brave Browser': { ok: false, reason: 'system_events_denied', message: 'SE denied' } } },
      answers: ['y'],
    });
    await browserSetupCommand([], b.options);
    expect(b.calls).toContain('open:automation');
    expect(b.out.join('\n')).toContain('System Events');
  });

  it('guides the user when the menu item is greyed out and retries', async () => {
    const h = harness({
      script: { inspect: { 'Brave Browser': ['js_disabled', 'ready'] } },
      answers: ['y', ''],
    });
    const enable = h.options.setup.enableJs as any;
    enable
      .mockResolvedValueOnce({ ok: false, reason: 'menu_disabled', message: 'greyed out' })
      .mockResolvedValueOnce({ ok: true, changed: true, state: 'checked' });
    expect(await browserSetupCommand([], h.options)).toBe(0);
    expect(enable).toHaveBeenCalledTimes(2);
    expect(h.asked[1]).toContain('Bring a normal Brave Browser window to the front');
    expect(h.out.join('\n')).toContain('greyed out');
    expect(h.out.join('\n')).toContain('✔ Brave Browser  fast path is on');
  });

  it('stops retrying when the user types n', async () => {
    const h = harness({ script: { inspect: { 'Brave Browser': ['js_disabled'] } }, answers: ['y', 'n'] });
    (h.options.setup.enableJs as any).mockResolvedValue({ ok: false, reason: 'menu_disabled', message: 'greyed out' });
    await browserSetupCommand([], h.options);
    expect(h.options.setup.enableJs).toHaveBeenCalledTimes(1);
    expect(h.out.join('\n')).toContain('greyed out');
  });

  it('switches it on for every profile in use when some window still has it off', async () => {
    const h = harness({
      script: {
        inspect: { 'Brave Browser': ['js_disabled', 'ready'] },
        windows: [
          [{ windowIndex: 1, status: 'ready' }, { windowIndex: 2, status: 'js_disabled' }],
          [{ windowIndex: 1, status: 'ready' }, { windowIndex: 2, status: 'ready' }],
        ],
        profiles: [
          { profile: { dir: 'Profile 4', name: 'kushal', email: 'k@example.com' }, ok: true, changed: false },
          { profile: { dir: 'Profile 5', name: 'Work', email: '' }, ok: true, changed: true },
        ],
      },
      answers: ['y'],
    });
    expect(await browserSetupCommand([], h.options)).toBe(0);
    expect(h.calls).toContain('profiles');
    const text = h.out.join('\n');
    expect(text).toContain('keeps this setting per profile');
    expect(text).toContain('✔ kushal (k@example.com)  already on');
    expect(text).toContain('✔ Work  switched on');
    expect(text).not.toContain('still have it off');
  });

  it('does the per-profile pass for an already-ready browser too, and says what is left over', async () => {
    const h = harness({
      script: {
        windows: [{ windowIndex: 3, status: 'js_disabled' }],
        profiles: [{ profile: { dir: 'Profile 8', name: 'rey', email: '' }, ok: false, changed: false, message: 'could not open a window for this profile' }],
      },
    });
    await browserSetupCommand([], h.options);
    const text = h.out.join('\n');
    expect(h.calls).toContain('profiles');
    expect(text).toContain('✖ rey  could not open a window for this profile');
    expect(text).toContain('(3) still has it off');
  });

  it('does not touch other profiles without a terminal or --yes', async () => {
    const h = harness({ isTTY: false, script: { windows: [{ windowIndex: 2, status: 'js_disabled' }] } });
    await browserSetupCommand([], h.options);
    expect(h.calls).not.toContain('profiles');
    expect(h.out.join('\n')).toContain('Run "rh browser setup" in a terminal');
  });

  it('does nothing extra when every window already works', async () => {
    const h = harness({ script: { windows: [{ windowIndex: 1, status: 'ready' }] } });
    await browserSetupCommand([], h.options);
    expect(h.calls).not.toContain('profiles');
  });

  it('records manual when the menu item is missing', async () => {
    const h = harness({
      script: { inspect: { 'Brave Browser': ['js_disabled'] }, enable: { 'Brave Browser': { ok: false, reason: 'menu_missing', message: 'no menu' } } },
      answers: ['y'],
    });
    await browserSetupCommand([], h.options);
    expect(h.state().browsers['Brave Browser'].decision).toBe('manual');
  });

  it('--disable reports what changed per browser', async () => {
    const h = harness({
      running: ['Brave Browser', 'Google Chrome'],
      script: {
        disable: {
          'Brave Browser': { ok: true, changed: true, state: 'unchecked' },
          'Google Chrome': { ok: true, changed: false, state: 'unchecked' },
        },
      },
    });
    expect(await browserSetupCommand(['--disable'], h.options)).toBe(0);
    expect(h.calls).toEqual(['disable:Google Chrome', 'disable:Brave Browser']);
    const text = h.out.join('\n');
    expect(text).toContain('✔ Brave Browser  turned off');
    expect(text).toContain('– Google Chrome  already off');
  });

  it('--debug prints diagnostics and never changes anything; --yes adds one click attempt', async () => {
    const a = harness({ script: { diagnose: ['probe before: js_disabled', 'before menu: View|Developer|X|enabled=true|mark=none'] } });
    expect(await browserSetupCommand(['--debug'], a.options)).toBe(0);
    expect(a.calls).toEqual(['diagnose:Brave Browser:false']);
    expect(a.out.join('\n')).toContain('--- Brave Browser');
    expect(a.out.join('\n')).toContain('before menu: View|Developer');
    expect(a.asked).toEqual([]);
    const b = harness();
    await browserSetupCommand(['--debug', '--yes'], b.options);
    expect(b.calls).toEqual(['diagnose:Brave Browser:true']);
  });

  it('--browser limits the run and returns 1 when that browser cannot be made ready', async () => {
    const h = harness({
      running: ['Brave Browser', 'Google Chrome'],
      script: { inspect: { 'Google Chrome': ['error'] } },
    });
    expect(await browserSetupCommand(['--browser', 'chrome'], h.options)).toBe(1);
    expect(h.calls).toEqual(['request:Google Chrome', 'inspect:Google Chrome']);
  });
});

describe('offerBrowserSetupOnce', () => {
  it('does nothing without a terminal (no probe, no prompt, no state write)', async () => {
    const h = harness({ isTTY: false, script: { inspect: { 'Brave Browser': ['js_disabled'] } } });
    await offerBrowserSetupOnce(h.options);
    expect(h.calls).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.state()).toBeNull();
  });

  it('offers once per browser and never re-asks a decided browser', async () => {
    const first = harness({ script: { inspect: { 'Brave Browser': ['js_disabled'] } }, answers: ['n'] });
    await offerBrowserSetupOnce(first.options);
    expect(first.asked).toHaveLength(1);
    expect(first.state().browsers['Brave Browser'].decision).toBe('declined');

    const again = harness({
      state: { '/state/browser-setup.json': JSON.stringify(first.state()) },
      script: { inspect: { 'Brave Browser': ['js_disabled'] } },
    });
    await offerBrowserSetupOnce(again.options);
    expect(again.calls).toEqual([]);
    expect(again.asked).toEqual([]);
  });

  it('never throws and reports a one-line warning', async () => {
    const h = harness();
    (h.options.transport as any).environment = async () => {
      throw new Error('osascript exploded');
    };
    await expect(offerBrowserSetupOnce(h.options)).resolves.toBeUndefined();
    expect(h.err.join('\n')).toContain('Browser setup skipped');
  });
});

describe('offerForContext', () => {
  it('uses an injected offer and swallows its failures', async () => {
    const offer = vi.fn(async () => {
      throw new Error('nope');
    });
    const stderr = vi.fn();
    await expect(offerForContext({ browserSetupOffer: offer, stderr })).resolves.toBeUndefined();
    expect(offer).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Browser setup skipped'));
  });
});
