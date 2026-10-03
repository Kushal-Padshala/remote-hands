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

  it('keeps zero-screenshot and zero-mouse rules', () => {
    expect(SLIM_COMPUTER_PROMPT).toMatch(/No screenshots/);
    expect(SLIM_COMPUTER_PROMPT).toMatch(/no physical mouse movement/);
  });
});
