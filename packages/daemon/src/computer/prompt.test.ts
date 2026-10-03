import { describe, it, expect } from 'vitest';
import { SLIM_COMPUTER_PROMPT } from './prompt.js';
import { buildComputerTools } from './tools.js';

describe('SLIM_COMPUTER_PROMPT', () => {
  it('mentions exactly the tool names produced by buildComputerTools', () => {
    const mentioned = new Set(SLIM_COMPUTER_PROMPT.match(/\b(?:desktop|browser)_[a-z]+\b|\bcomputer_batch\b/g) ?? []);
    const actual = new Set(buildComputerTools({} as any).map((t) => t.name));
    expect([...mentioned].sort()).toEqual([...actual].sort());
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
  });

  it('keeps zero-screenshot and zero-mouse rules', () => {
    expect(SLIM_COMPUTER_PROMPT).toMatch(/No screenshots/);
    expect(SLIM_COMPUTER_PROMPT).toMatch(/no physical mouse movement/);
    const rule3 = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('3.')) ?? '';
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
    expect(rule).toContain('rh browser doctor');
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
