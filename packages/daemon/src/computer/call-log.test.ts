import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCallRecord, callLogPath, classifyError } from './call-log.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-calls-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('call log', () => {
  it('appends one JSON line per call with only the known fields', () => {
    appendCallRecord(home, { at: '2026-10-12T00:00:00.000Z', tool: 'browser_do', ms: 412.6, ok: false, kind: 'stale', url: 'https://secret.test', text: 'hunter2' } as any);
    const lines = fs.readFileSync(callLogPath(home), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ at: '2026-10-12T00:00:00.000Z', tool: 'browser_do', ms: 413, ok: false, kind: 'stale' });
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('hunter2');
  });

  it('classifies errors by shape, not by content', () => {
    expect(classifyError('error: tool call timed out after 90s')).toBe('timeout');
    expect(classifyError('Element [7]: page changed since the snapshot. Call browser_snapshot.')).toBe('stale');
    expect(classifyError('Index 4 is not on the page I last showed. Call browser_snapshot.')).toBe('stale');
    expect(classifyError('something else')).toBe('other');
  });

  it('never throws when the directory cannot be written', () => {
    const file = path.join(home, 'blocker');
    fs.writeFileSync(file, 'x');
    expect(() => appendCallRecord(path.join(file, 'nested'), { at: 'a', tool: 't', ms: 1, ok: true })).not.toThrow();
  });

  it('trims a large log to the newest lines', () => {
    const file = callLogPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const filler = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ at: String(i), tool: 'browser_do', ms: 1, ok: true })).join('\n');
    fs.writeFileSync(file, `${filler}\n${' '.repeat(200_000)}\n`);
    appendCallRecord(home, { at: 'last', tool: 'browser_do', ms: 1, ok: true });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(1000);
    expect(JSON.parse(lines.at(-1)!).at).toBe('last');
  });
});
