import { clean } from './render.js';

/**
 * agy saves any tool result of about 4 KB or more to a file and hands the model only the path, so
 * reading it costs a whole extra turn. One extract call therefore returns at most this much text
 * (the model reads on with `offset`), which keeps title, url and a continuation line under that size.
 */
export const EXTRACT_MAX_CHARS = 3000;
/** Bytes for the whole response (header, text, continuation line); under the 3700 every result is held to. */
const EXTRACT_RESPONSE_BYTES = 3500;
const TAIL_RESERVE_BYTES = 120;
const MIN_BODY_BYTES = 400;
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
  const raw = more && full.endsWith('\u2026') ? full.slice(0, -1) : full;
  // An offset that lands inside a surrogate pair starts at the pair.
  let start = win.start;
  const first = raw.charCodeAt(start);
  if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start -= 1;
  const title = clean(str(o.title), HEADER_TITLE_CHARS);
  const head =
    start === 0
      ? `${title}\n${clean(str(o.url), HEADER_URL_CHARS)}\n\n`
      : `${title}\n(text from character ${start})\n\n`;
  const bodyBytes = Math.max(MIN_BODY_BYTES, EXTRACT_RESPONSE_BYTES - Buffer.byteLength(head, 'utf8') - TAIL_RESERVE_BYTES);
  let end = Math.min(raw.length, start + win.want);
  let slice = raw.slice(start, end);
  while (slice.length > 0 && Buffer.byteLength(slice, 'utf8') > bodyBytes) {
    slice = slice.slice(0, Math.max(0, Math.floor(slice.length * 0.9)));
  }
  const last = slice.charCodeAt(slice.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
  end = start + slice.length;
  if (slice === '' && start > 0) return `${head}(no more text on this page)`;
  const hasMore = more || raw.length > end;
  const tail = hasMore ? `\n… more text on this page: call browser_extract with offset=${end}` : '';
  return `${head}${slice}${tail}`;
}
