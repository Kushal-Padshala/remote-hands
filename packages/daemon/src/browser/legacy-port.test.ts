import { describe, it, expect, vi } from 'vitest';
import { LegacyBrowserPort, type LegacyBrowserDriver } from './legacy-port.js';

function makeDriver(over: Partial<LegacyBrowserDriver> = {}) {
  return {
    listTabs: vi.fn().mockResolvedValue([
      { id: 't1', title: 'Inbox', url: 'https://mail.example', active: true, windowIndex: 1, tabIndex: 2 },
      { id: 't2', title: 'Docs', url: 'https://docs.example', active: false, windowIndex: 2, tabIndex: 1 },
    ]),
    focusTab: vi.fn().mockResolvedValue({ success: true, tab: { title: 'Inbox', url: 'https://mail.example' } }),
    openUrl: vi.fn().mockResolvedValue({ success: true, url: 'https://x.test' }),
    snapshot: vi.fn().mockResolvedValue({
      url: 'u',
      title: 't',
      elements: [],
      formattedTable: '[e1] button   Go\n[e2] textbox  Email\n[e3] link     Sign in with Google',
    }),
    clickIndex: vi.fn().mockResolvedValue({ success: true, label: 'Go' }),
    typeIndex: vi.fn().mockResolvedValue({ success: true, label: 'Email' }),
    ...over,
  };
}

const STATE = '[e1] button   Go\n[e2] textbox  Email\n[e3] link     Sign in with Google';

function port(driver = makeDriver()) {
  return new LegacyBrowserPort({ driver, settleMs: 0, sleep: async () => {} });
}

describe('LegacyBrowserPort (previous ComputerSession behaviour)', () => {
  it('lists tabs as [wN-tM] (active) title - url', async () => {
    expect(await port().tabs()).toBe('[w1-t2] (active) Inbox - https://mail.example\n[w2-t1] Docs - https://docs.example');
  });

  it('click and type return the action line plus the page state', async () => {
    const d = makeDriver();
    const p = port(d);
    expect(await p.click(1)).toBe(`clicked [1] Go\n${STATE}`);
    expect(d.clickIndex).toHaveBeenCalledWith(1);
    expect(await p.type(2, 'a@b.c')).toBe(`typed into [2] Email\n${STATE}`);
    expect(d.typeIndex).toHaveBeenCalledWith(2, 'a@b.c');
  });

  it('still reports the action when the follow-up snapshot fails', async () => {
    const d = makeDriver({ snapshot: vi.fn().mockRejectedValue(new Error('cdp gone')) });
    expect(await port(d).click(1)).toBe('clicked [1] Go\n(state unavailable: cdp gone; call browser_snapshot)');
  });

  it('caps snapshots at 120 lines', async () => {
    const table = Array.from({ length: 300 }, (_, i) => `[${i}] link "l${i}"`).join('\n');
    const d = makeDriver({ snapshot: vi.fn().mockResolvedValue({ url: 'u', title: 't', elements: [], formattedTable: table }) });
    const out = await port(d).snapshot();
    expect(out.split('\n')).toHaveLength(121);
    expect(out).toContain('… 180 more lines hidden');
  });

  it('focus and open prefix the snapshot', async () => {
    const d = makeDriver();
    expect(await port(d).focus('inbox')).toBe(`focused Inbox - https://mail.example\n${STATE}`);
    expect(d.focusTab).toHaveBeenCalledWith('inbox');
    expect(await port(d).open('https://x.test')).toBe(`opened https://x.test\n${STATE}`);
  });

  it('open refuses unsafe schemes', async () => {
    const d = makeDriver();
    await expect(port(d).open('javascript:alert(1)')).rejects.toThrow('Refusing to open javascript: URLs');
    await expect(port(d).open('java\tscript:alert(1)')).rejects.toThrow('whitespace or control characters');
    expect(d.openUrl).not.toHaveBeenCalled();
  });

  it('find filters the snapshot lines', async () => {
    expect((await port().find('zz\nqq')).split('\n')[0]).toBe('no match for "zz qq"; first 3 of 3 elements:');
    expect(await port().find('sign in')).toBe('found 1 of 3 elements for "sign in":\n[e3] link     Sign in with Google');
    expect(await port().find('zzz', 1)).toBe('no match for "zzz"; first 1 of 3 elements:\n[e1] button   Go');
  });

  it('extract uses executeScript when available', async () => {
    const executeScript = vi.fn().mockResolvedValue(JSON.stringify({ title: 'T', url: 'https://x/', text: 'body' }));
    expect(await port(makeDriver({ executeScript })).extract(50)).toBe('T\nhttps://x/\n\nbody');
    expect(executeScript.mock.calls[0]![0]).toContain('const max = 50;');
    await expect(port().extract()).rejects.toThrow('extract is not supported on the legacy path');
  });

  it('type with submit needs executeScript', async () => {
    const d = makeDriver();
    await expect(port(d).type(2, 'x', { submit: true })).rejects.toThrow('submit is not supported on the legacy path');
    expect(d.typeIndex).not.toHaveBeenCalled();
    const executeScript = vi.fn().mockResolvedValue(JSON.stringify({ ok: true }));
    const out = await port(makeDriver({ executeScript })).type(2, 'x', { submit: true });
    expect(out.split('\n')[0]).toBe('typed into [2] Email');
    expect(executeScript.mock.calls[0]![0]).toContain('"key":"Enter"');
  });

  it('do runs click/type/wait in order and stops at the first failure', async () => {
    const d = makeDriver();
    const out = await port(d).do([
      { op: 'type', index: 2, text: 'a' },
      { op: 'wait', ms: 10 },
      { op: 'click', index: 1 },
    ]);
    expect(out).toBe(`did: type, wait, click\n${STATE}`);
    expect(d.snapshot).toHaveBeenCalledTimes(1);

    const bad = makeDriver({ clickIndex: vi.fn().mockRejectedValue(new Error('Index 9 not found')) });
    await expect(
      port(bad).do([
        { op: 'type', index: 2, text: 'a' },
        { op: 'click', index: 9 },
        { op: 'type', index: 2, text: 'b' },
      ]),
    ).rejects.toThrow('step 2 click failed: Index 9 not found (step 1 ok)');
    expect(bad.typeIndex).toHaveBeenCalledTimes(1);
  });

  it('do rejects steps the legacy path cannot run before running any', async () => {
    const d = makeDriver();
    await expect(port(d).do([{ op: 'click', index: 1 }, { op: 'select', index: 3, value: 'x' }])).rejects.toThrow(
      'step 2 select invalid: not supported on the legacy path. No steps were run.',
    );
    await expect(port(d).do([{ op: 'type', index: 1 }])).rejects.toThrow('step 1 type invalid: text is required. No steps were run.');
    expect(d.clickIndex).not.toHaveBeenCalled();
  });
});
