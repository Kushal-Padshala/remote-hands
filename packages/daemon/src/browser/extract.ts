import { clean } from './render.js';

/**
 * agy saves any tool result of about 4 KB or more to a file and hands the model only the path, so
 * reading it costs a whole extra turn. One extract call therefore returns at most this much text
 * (the model reads on with `offset`), which keeps title, url and a continuation line under that size.
 */
export const EXTRACT_MAX_CHARS = 3000;
const EXTRACT_MAX_BYTES = 3000;
const HEADER_TITLE_CHARS = 150;
const HEADER_URL_CHARS = 400;

/** How much page text the page script must collect to serve the window [offset, offset + maxChars). */
export function extractWindow(maxChars: number | undefined, offset: number | undefined): { want: number; start: number; limit: number } {
  const asked = Number.isFinite(maxChars) && (maxChars as number) > 0 ? Math.floor(maxChars as number) : EXTRACT_MAX_CHARS;
  const want = Math.min(asked, EXTRACT_MAX_CHARS);
  const start = Number.isFinite(offset) && (offset as number) > 0 ? Math.floor(offset as number) : 0;
  return { want, start, limit: start + want };
}

function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}

/** Model-facing text of an extract script result for the window it was asked for. */
export function renderExtract(o: Record<string, unknown>, win: { want: number; start: number }): string {
  const more = o.more === true;
  // The script marks a cut with a trailing ellipsis of its own; the window logic replaces it.
  const full = str(o.text);
  const raw = more && full.endsWith('…') ? full.slice(0, -1) : full;
  let end = Math.min(raw.length, win.start + win.want);
  let slice = raw.slice(win.start, end);
  while (slice.length > 0 && Buffer.byteLength(slice, 'utf8') > EXTRACT_MAX_BYTES) {
    slice = slice.slice(0, Math.max(0, Math.floor(slice.length * 0.9)));
  }
  end = win.start + slice.length;
  const last = slice.charCodeAt(slice.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    slice = slice.slice(0, -1);
    end -= 1;
  }
  const hasMore = more || raw.length > end;
  const head =
    win.start === 0
      ? `${clean(str(o.title), HEADER_TITLE_CHARS)}\n${clean(str(o.url), HEADER_URL_CHARS)}\n\n`
      : `${clean(str(o.title), HEADER_TITLE_CHARS)}\n(text from character ${win.start})\n\n`;
  if (slice === '' && win.start > 0) return `${head}(no more text on this page)`;
  const tail = hasMore ? `\n… more text on this page: call browser_extract with offset=${end}` : '';
  return `${head}${slice}${tail}`;
}
