import { describe, it, expect } from 'vitest';
import { SLIM_COMPUTER_PROMPT, computerPrompt } from './prompt.js';
import { buildComputerTools } from './tools.js';

describe('SLIM_COMPUTER_PROMPT', () => {
  it('mentions exactly the tool names produced by buildComputerTools', () => {
    const mentioned = new Set(SLIM_COMPUTER_PROMPT.match(/\b(?:desktop|browser)_[a-z]+\b|\bcomputer_batch\b/g) ?? []);
    const actual = new Set(buildComputerTools({} as any).map((t) => t.name));
    expect([...mentioned].sort()).toEqual([...actual].sort());
  });

  it('names every supported browser instead of "signed-in Chrome" and says selects/checkboxes need browser_do (fix pass 4)', () => {
    expect(SLIM_COMPUTER_PROMPT).not.toContain('signed-in Chrome');
    expect(SLIM_COMPUTER_PROMPT).toContain('signed-in browser (Chrome, Brave, Arc, Edge or Safari)');
    const rule = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('5. Browser')) ?? '';
    expect(rule).toMatch(/selects and checkboxes .*browser_do.*select.*check/i);
  });

  it('rule 5 teaches label targets, hover and Tab while staying concise', () => {
    const rule = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('5. Browser')) ?? '';
    expect(rule).toContain('`target`');
    expect(rule).toContain('hover');
    expect(rule).toContain('press Tab');
    expect(rule).toContain('Never run `rh browser setup` yourself');
    expect(rule.length).toBeLessThan(900);
  });

  it('tells the model to keep the desktop_click app consistent and re-snapshot on stale errors', () => {
    expect(SLIM_COMPUTER_PROMPT).toMatch(/same `app` as the latest `desktop_snapshot`/);
    expect(SLIM_COMPUTER_PROMPT).toMatch(/omit `app` on both/);
    expect(SLIM_COMPUTER_PROMPT).toContain('no longer present');
    expect(SLIM_COMPUTER_PROMPT).toContain('not in last snapshot');
    expect(SLIM_COMPUTER_PROMPT).toMatch(/call desktop_snapshot again/);
  });

  it('documents native Accessibility clicks and the note: fallback report', () => {
    expect(SLIM_COMPUTER_PROMPT).toContain('native Accessibility');
    expect(SLIM_COMPUTER_PROMPT).toContain('note:');
  });

  it('tells the model to pass the turn task id to rh approve', () => {
    const rule7 = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('8.')) ?? '';
    expect(rule7).toContain('rh approve');
    expect(rule7).toContain('--task=');
    expect(rule7).toMatch(/--task=<Task id from the turn>/);
    expect(rule7).toContain('do not run `rh approve` for them');
  });

  it('keeps zero-screenshot and zero-mouse rules', () => {
    expect(SLIM_COMPUTER_PROMPT).toMatch(/No screenshots/);
    expect(SLIM_COMPUTER_PROMPT).toMatch(/no physical mouse movement/);
    const rule3 = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('3.')) ?? '';
    expect(rule3).toContain('except the physical-click fallback that desktop_click reports in its result');
  });

  it('rule 3 names the blocked osascript paths and the desktop_key alternative', () => {
    const rule3 = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('3.')) ?? '';
    expect(rule3).toContain('Executing JavaScript through AppleScript is turned off');
    expect(rule3).toContain('not allowed to send keystrokes');
    expect(rule3).toContain('desktop_key');
    expect(rule3).toContain('except the physical-click fallback that desktop_click reports in its result');
  });

  it('has a concise browser rule block covering stable ids, no re-snapshot, browser_do/find/extract and the fallback note', () => {
    const rule = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('5. Browser')) ?? '';
    expect(rule).toMatch(/stable numbers/);
    expect(rule).toMatch(/never (call )?(browser_)?snapshot|never re-snapshot/i);
    expect(rule).toContain('browser_do');
    expect(rule).toMatch(/whole form in one call/);
    expect(rule).toContain('browser_find');
    expect(rule).toContain('browser_extract');
    expect(rule).toContain('note: fast browser path unavailable');
    expect(rule).toContain('rh browser setup');
    expect(rule.length).toBeLessThan(900);
  });

  it('numbers the rules contiguously and keeps desktop indexes distinct from stable browser ids', () => {
    const nums = SLIM_COMPUTER_PROMPT.split('\n')
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter(Boolean)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(SLIM_COMPUTER_PROMPT).not.toMatch(/\b4b\./);
    const rule1 = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('1.')) ?? '';
    expect(rule1).toMatch(/desktop indexes come from the latest/i);
    expect(rule1).toMatch(/browser ids are stable numbers/i);
    expect(rule1).not.toMatch(/^1\. .*Indexes come from the latest state only/);
  });
});

describe('computerPrompt', () => {
  it('is the Mac prompt on a Mac, unchanged', () => {
    expect(computerPrompt('darwin')).toBe(SLIM_COMPUTER_PROMPT);
  });

  it('offers a browser-only prompt on Windows that names exactly the tools Windows has', () => {
    const win = computerPrompt('win32');
    const mentioned = new Set(win.match(/\b(?:desktop|browser)_[a-z]+\b|\bcomputer_batch\b/g) ?? []);
    const actual = new Set(buildComputerTools({} as any, { platform: 'win32' }).map((t) => t.name));
    expect([...mentioned].sort()).toEqual([...actual].sort());
    expect(win).not.toMatch(/desktop_|Mac|osascript|Cmd\+Shift/);
    expect(win).toContain('Windows');
    expect(win).toContain('Only the web browser can be controlled on Windows for now');
    // the browser and approval rules are the Mac ones
    expect(win).toContain('Use browser_do to fill and submit a whole form in one call');
    expect(win).toContain('wait for the user\'s approval on their phone by themselves');
    expect(win).toContain('Never run `rh browser setup` yourself');
  });
});

describe('reading a window by sight in the prompts', () => {
  it('is taught on the Mac as the last resort, after the fast ways', () => {
    expect(SLIM_COMPUTER_PROMPT).toMatch(/LAST resort/);
    expect(SLIM_COMPUTER_PROMPT).toMatch(/ocr=true/);
    expect(SLIM_COMPUTER_PROMPT).toMatch(/Never use ocr=true when Accessibility already lists the control/);
  });

  it('is not mentioned where there are no desktop tools', () => {
    expect(computerPrompt('win32')).not.toMatch(/ocr/i);
    expect(computerPrompt('win32')).not.toMatch(/by sight/i);
  });

  it('the tool descriptions say it is slower and a last resort', () => {
    const tools = buildComputerTools({} as any, { platform: 'darwin' });
    const snapshot = tools.find((t) => t.name === 'desktop_snapshot')!;
    expect(snapshot.description).toMatch(/LAST RESORT/);
    expect(snapshot.description).toMatch(/slower/);
    expect(Object.keys(snapshot.inputSchema)).toContain('ocr');
    expect(tools.find((t) => t.name === 'desktop_click')!.description).toMatch(/1000001 and up/);
  });
});

describe('buildComputerTools off the Mac', () => {
  it('offers no desktop tool, and the batch tool cannot run one', async () => {
    const tools = buildComputerTools({} as any, { platform: 'win32' });
    expect(tools.some((t) => t.name.startsWith('desktop_'))).toBe(false);
    expect(tools.map((t) => t.name)).toContain('browser_open');
    const batch = tools.find((t) => t.name === 'computer_batch')!;
    expect(batch.description).not.toMatch(/desktop/i);
    await expect(batch.handler({ steps: [{ tool: 'desktop_click', args: { index: 1 } }] })).rejects.toThrow(/unknown or nested tool/);
  });

  it('keeps every tool on the Mac', () => {
    expect(buildComputerTools({} as any, { platform: 'darwin' }).filter((t) => t.name.startsWith('desktop_'))).toHaveLength(10);
  });
});
