import { describe, it, expect } from 'vitest';
import { EXTRACT_MAX_CHARS, extractWindow, renderExtract } from './extract.js';

const page = (text: string, more = false) => ({ title: 'T', url: 'https://x.test/a', text, more });

describe('extractWindow', () => {
  it('defaults to one capped window and never asks for more than the cap per call', () => {
    expect(extractWindow(undefined, undefined)).toEqual({ want: EXTRACT_MAX_CHARS, start: 0, limit: EXTRACT_MAX_CHARS });
    expect(extractWindow(20000, undefined).want).toBe(EXTRACT_MAX_CHARS);
    expect(extractWindow(100, undefined)).toEqual({ want: 100, start: 0, limit: 100 });
    expect(extractWindow(100, 500)).toEqual({ want: 100, start: 500, limit: 600 });
    expect(extractWindow(NaN, -5)).toEqual({ want: EXTRACT_MAX_CHARS, start: 0, limit: EXTRACT_MAX_CHARS });
  });
});

describe('renderExtract', () => {
  it('keeps the plain shape when the whole page fits', () => {
    expect(renderExtract(page('hello'), extractWindow(100, undefined))).toBe('T\nhttps://x.test/a\n\nhello');
  });

  it('names the next offset when the page has more, dropping the script\'s own ellipsis', () => {
    const win = extractWindow(10, undefined);
    const out = renderExtract(page('0123456789…', true), win);
    expect(out).toBe('T\nhttps://x.test/a\n\n0123456789\n… more text on this page: call browser_extract with offset=10');
  });

  it('serves a later window from the same text without repeating the url', () => {
    const win = extractWindow(5, 10);
    const out = renderExtract(page('0123456789abcdefghij…', true), win);
    expect(out).toBe('T\n(text from character 10)\n\nabcde\n… more text on this page: call browser_extract with offset=15');
  });

  it('says so when the offset is past the end', () => {
    const out = renderExtract(page('short'), extractWindow(100, 50));
    expect(out).toBe('T\n(text from character 50)\n\n(no more text on this page)');
  });

  it('keeps a window of wide characters under the byte budget and offers the rest', () => {
    const text = '日'.repeat(3000);
    const out = renderExtract(page(text), extractWindow(undefined, undefined));
    expect(Buffer.byteLength(out)).toBeLessThan(3700);
    const next = /offset=(\d+)/.exec(out)?.[1];
    expect(Number(next)).toBeGreaterThan(0);
    expect(Number(next)).toBeLessThan(3000);
  });

  it('never splits a surrogate pair at the window end', () => {
    const out = renderExtract(page('a😀b😀c😀d'), extractWindow(2, undefined));
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('shortens a very long url in the header', () => {
    const long = { ...page('x'), url: `https://x.test/${'q'.repeat(900)}` };
    const first = renderExtract(long, extractWindow(100, undefined)).split('\n')[1]!;
    expect(first.length).toBeLessThanOrEqual(401);
  });
});
