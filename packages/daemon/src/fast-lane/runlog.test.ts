import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRunRecord, readRunSummary, runLogPath, type FastLaneRunRecord } from './runlog.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-runlog-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const rec = (over: Partial<FastLaneRunRecord> = {}): FastLaneRunRecord => ({ at: '2026-10-04T12:00:00.000Z', lane: 'skill', result: 'handled', elapsedMs: 1000, ...over });

describe('run log', () => {
  it('summarises nothing when there is no log', () => {
    expect(readRunSummary(home)).toEqual({ total: 0, handled: 0, continued: 0, stopped: 0, medianHandledMs: null });
    expect(runLogPath(home)).toBe(path.join(home, '.remote-hands', 'fast-lane', 'runs.jsonl'));
  });

  it('counts outcomes and reports the median time of handled requests', () => {
    appendRunRecord(home, rec({ elapsedMs: 900 }));
    appendRunRecord(home, rec({ elapsedMs: 1200 }));
    appendRunRecord(home, rec({ elapsedMs: 3000, lane: 'pilot', steps: 4 }));
    appendRunRecord(home, rec({ lane: 'brain', result: 'continued', elapsedMs: 250 }));
    appendRunRecord(home, rec({ lane: 'skill', result: 'stopped', elapsedMs: 50 }));
    expect(readRunSummary(home)).toEqual({ total: 5, handled: 3, continued: 1, stopped: 1, medianHandledMs: 1200 });
  });

  it('only looks at the most recent records', () => {
    for (let i = 0; i < 10; i++) appendRunRecord(home, rec({ result: 'continued', lane: 'brain' }));
    for (let i = 0; i < 3; i++) appendRunRecord(home, rec());
    expect(readRunSummary(home, 3)).toMatchObject({ total: 3, handled: 3, continued: 0 });
  });

  it('skips corrupt lines instead of failing', () => {
    appendRunRecord(home, rec());
    fs.appendFileSync(runLogPath(home), 'not json\n{"half":\n');
    appendRunRecord(home, rec({ result: 'continued', lane: 'brain' }));
    expect(readRunSummary(home)).toMatchObject({ total: 2, handled: 1, continued: 1 });
  });

  it('never writes request text or typed values: only the fields of a record', () => {
    appendRunRecord(home, { ...rec(), query: 'send my password hunter2', facts: { password: 'hunter2' } } as unknown as FastLaneRunRecord);
    const raw = fs.readFileSync(runLogPath(home), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(Object.keys(JSON.parse(raw.trim())).sort()).toEqual(['at', 'elapsedMs', 'lane', 'result']);
  });

  it('keeps the file small by trimming the oldest records', () => {
    for (let i = 0; i < 1100; i++) appendRunRecord(home, rec({ elapsedMs: i }));
    const lines = fs.readFileSync(runLogPath(home), 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(1000);
    expect(JSON.parse(lines.at(-1)!).elapsedMs).toBe(1099);
  });

  it('never throws, even when it cannot write', () => {
    const blocker = path.join(home, '.remote-hands');
    fs.writeFileSync(blocker, 'a file where a folder should be');
    expect(() => appendRunRecord(home, rec())).not.toThrow();
    expect(readRunSummary(home).total).toBe(0);
  });
});
