import { describe, it, expect } from 'vitest';
import { fitResult, RESULT_MAX_BYTES } from './result-budget.js';

const size = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('fitResult', () => {
  it('returns a short result untouched', () => {
    expect(fitResult('hello\nworld')).toBe('hello\nworld');
    const exact = 'a'.repeat(RESULT_MAX_BYTES);
    expect(fitResult(exact)).toBe(exact);
  });

  it('cuts at a line boundary, says how many lines went, and stays under the limit', () => {
    const text = Array.from({ length: 400 }, (_, i) => `[${i}] button "Item number ${i}"`).join('\n');
    const out = fitResult(text);
    expect(size(out)).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(out.startsWith('[0] button "Item number 0"\n[1] button')).toBe(true);
    expect(out).toMatch(/… \d+ more lines cut to keep this result short/);
    const kept = out.split('\n').filter((l) => l.startsWith('['));
    expect(kept.at(-1)).toBe(`[${kept.length - 1}] button "Item number ${kept.length - 1}"`);
    expect(out).toContain(`${400 - kept.length} more lines`);
  });

  it('cuts one huge line by characters without splitting a surrogate pair', () => {
    const out = fitResult('😀'.repeat(5000));
    expect(size(out)).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out).toContain('the rest of this text is cut');
  });

  it('measures bytes, not characters', () => {
    const lines = Array.from({ length: 300 }, () => '日本語のテキスト'.repeat(2)).join('\n');
    expect(size(fitResult(lines))).toBeLessThanOrEqual(RESULT_MAX_BYTES);
  });
});
