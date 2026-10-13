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

  it('rotates a large log by renaming it, so old lines stay intact and new records start a fresh file', () => {
    const file = callLogPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ at: String(i), tool: 'browser_do', ms: 1, ok: true })).join('\n');
    fs.writeFileSync(file, `${old}\n${JSON.stringify({ at: 'pad', tool: 'x', ms: 1, ok: true, pad: 'y'.repeat(200_000) })}\n`);
    appendCallRecord(home, { at: 'newest', tool: 'browser_do', ms: 1, ok: true });
    const rotated = fs.readFileSync(`${file}.1`, 'utf8').split('\n').filter(Boolean);
    expect(rotated).toHaveLength(3002);
    expect(rotated.every((l) => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
    expect(JSON.parse(rotated.at(-1)!).at).toBe('newest');
    expect(fs.existsSync(file)).toBe(false);
    appendCallRecord(home, { at: 'after', tool: 'browser_do', ms: 1, ok: true });
    expect(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).at)).toEqual(['after']);
  });

  it('starts a record on a fresh line after a torn write, so the next record stays readable', () => {
    const file = callLogPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"at":"partia');
    appendCallRecord(home, { at: 'after', tool: 'browser_do', ms: 1, ok: true });
    appendCallRecord(home, { at: 'again', tool: 'browser_do', ms: 1, ok: true });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!).at).toBe('after');
    expect(JSON.parse(lines[2]!).at).toBe('again');
  });
});
