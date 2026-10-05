import { describe, expect, it, vi } from 'vitest';
import type { DoStep } from '../../browser/port.js';
import { BrowserPilotEnv, type PilotBrowser } from './env.js';

const FULL = [
  'browser: Google Chrome · page: Survey — https://x.test/s',
  'text: Question one ⏎ pick one',
  '[1] radio "Yes"',
  '[2] radio "No"',
  '[3] button "Next"',
  '[wait] wait "Wait for the page to update"',
].join('\n');

function fakeBrowser(doResponses: Array<string | Error> = []) {
  const doCalls: DoStep[][] = [];
  const browser: PilotBrowser = {
    browserSnapshot: vi.fn(async () => FULL),
    browserDo: vi.fn(async (steps: DoStep[]) => {
      doCalls.push(steps);
      const next = doResponses.shift();
      if (next instanceof Error) throw next;
      return next ?? 'page: Survey — https://x.test/s (same page)\nno visible change';
    }),
  };
  return { browser, doCalls };
}

describe('BrowserPilotEnv', () => {
  it('observes with page text and parses the table', async () => {
    const { browser } = fakeBrowser();
    const view = await new BrowserPilotEnv(browser).observe();
    expect(browser.browserSnapshot).toHaveBeenCalledWith({ text: true });
    expect(view.title).toBe('Survey');
    expect(view.text).toBe('Question one\npick one');
    expect(view.elements.map((e) => e.id)).toEqual(['1', '2', '3', 'wait']);
  });

  it.each([
    [{ op: 'click', id: '3' }, { op: 'click', index: 3 }],
    [{ op: 'type', id: '4', text: 'hello' }, { op: 'type', index: 4, text: 'hello' }],
    [{ op: 'type', id: '4', text: 'hi', submit: true }, { op: 'type', index: 4, text: 'hi', submit: true }],
    [{ op: 'select', id: '5', value: 'Spain' }, { op: 'select', index: 5, value: 'Spain' }],
    [{ op: 'check', id: '2', checked: true }, { op: 'check', index: 2, checked: true }],
    [{ op: 'scroll', delta: 560 }, { op: 'scroll', delta: 560 }],
    [{ op: 'wait', ms: 300 }, { op: 'wait', ms: 300 }],
  ] as const)('maps %j to exactly one browser_do step', async (action, step) => {
    const { browser, doCalls } = fakeBrowser();
    const env = new BrowserPilotEnv(browser);
    await env.observe();
    await env.act(action as never);
    expect(doCalls).toEqual([[step]]);
  });

  it('looks again with page text after the page navigated, because the engine omits text on navigation', async () => {
    const withText = [
      'browser: Google Chrome · page: Survey 2 — https://x.test/s2',
      'text: How concerned are you? ⏎ pick one',
      '[7] radio "Very concerned"',
      '[12] button "Next"',
    ].join('\n');
    const navigated = 'did: click\nchanged: page navigated or re-rendered\nbrowser: Google Chrome · page: Survey 2 — https://x.test/s2\n[7] radio "Very concerned"\n[12] button "Next"';
    const calls: Array<{ text?: boolean } | undefined> = [];
    const browser: PilotBrowser = {
      browserSnapshot: vi.fn(async (opts?: { text?: boolean }) => {
        calls.push(opts);
        return calls.length === 1 ? FULL : withText;
      }),
      browserDo: vi.fn(async () => navigated),
    };
    const env = new BrowserPilotEnv(browser);
    await env.observe();
    const view = await env.act({ op: 'click', id: '3' });
    expect(calls).toEqual([{ text: true }, { text: true }]);
    expect(view.text).toBe('How concerned are you?\npick one');
    expect(view.elements.map((e) => e.id)).toEqual(['7', '12']);
  });

  it('does not look again after a same-page delta', async () => {
    const { browser } = fakeBrowser(['page: Survey — https://x.test/s (same page)\n~ [1] radio "Yes" [checked]']);
    const env = new BrowserPilotEnv(browser);
    await env.observe();
    await env.act({ op: 'check', id: '1', checked: true });
    expect(browser.browserSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps the navigated view if the second look fails', async () => {
    const navigated = 'changed: page navigated or re-rendered\nbrowser: Google Chrome · page: P2 — https://x.test/p2\n[1] button "Go"';
    let n = 0;
    const browser: PilotBrowser = {
      browserSnapshot: vi.fn(async () => {
        if (n++ === 0) return FULL;
        throw new Error('tab closed');
      }),
      browserDo: vi.fn(async () => navigated),
    };
    const env = new BrowserPilotEnv(browser);
    await env.observe();
    const view = await env.act({ op: 'click', id: '3' });
    expect(view.title).toBe('P2');
    expect(view.elements.map((e) => e.id)).toEqual(['1']);
  });

  it('rejects a non-numeric element id before calling the browser', async () => {
    const { browser, doCalls } = fakeBrowser();
    const env = new BrowserPilotEnv(browser);
    await env.observe();
    await expect(env.act({ op: 'click', id: 'wait' })).rejects.toThrow('invalid element id "wait"');
    await expect(env.act({ op: 'type', id: '1; drop', text: 'x' })).rejects.toThrow('invalid element id');
    expect(doCalls).toEqual([]);
  });

  it('applies a delta response to the last view', async () => {
    const { browser } = fakeBrowser([
      'did: check\nbrowser: Google Chrome · page: Survey — https://x.test/s (same page)\n~ [1] radio "Yes" [checked]\n(3 unchanged)',
    ]);
    const env = new BrowserPilotEnv(browser);
    await env.observe();
    const view = await env.act({ op: 'check', id: '1', checked: true });
    expect(view.elements.find((e) => e.id === '1')?.checked).toBe(true);
    expect(view.elements.map((e) => e.id)).toEqual(['1', '2', '3', 'wait']);
    expect(view.text).toBe('Question one\npick one'); // text kept from the last full snapshot
  });

  it('keeps the view chain across several actions', async () => {
    const { browser } = fakeBrowser([
      'page: Survey — https://x.test/s (same page)\n~ [1] radio "Yes" [checked]',
      'page: Survey — https://x.test/s (same page)\n~ [2] radio "No" [checked]\n~ [1] radio "Yes"',
    ]);
    const env = new BrowserPilotEnv(browser);
    await env.observe();
    await env.act({ op: 'check', id: '1', checked: true });
    const view = await env.act({ op: 'check', id: '2', checked: true });
    expect(view.elements.find((e) => e.id === '1')?.checked).toBeUndefined();
    expect(view.elements.find((e) => e.id === '2')?.checked).toBe(true);
  });

  it('lets engine errors through unchanged, including approval rejections', async () => {
    const { browser } = fakeBrowser([new Error('step 1 click failed: Approval rejected by user: no (no steps ok)')]);
    const env = new BrowserPilotEnv(browser);
    await env.observe();
    await expect(env.act({ op: 'click', id: '3' })).rejects.toThrow('Approval rejected by user');
  });

  it('works without a prior observe (delta against an empty view)', async () => {
    const { browser } = fakeBrowser(['page: P — u (same page)\n+ [9] button "Go"']);
    const view = await new BrowserPilotEnv(browser).act({ op: 'wait', ms: 100 });
    expect(view.elements.map((e) => e.id)).toEqual(['9']);
  });
});
