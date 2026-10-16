/**
 * agy saves a tool result of about 4 KB or more (smallest seen: 4284 bytes; the largest seen kept
 * inline: 3629) to a file and gives the model only its path, which costs a whole extra turn to
 * open. Every result is held under this size so it stays inline.
 */
export const RESULT_MAX_BYTES = 3700;

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** `text` unchanged when it fits, else its leading lines (or characters) plus a line saying how to read the rest. */
export function fitResult(text: string, maxBytes: number = RESULT_MAX_BYTES): string {
  if (bytes(text) <= maxBytes) return text;
  const cutWords = (hidden: string): string => `… ${hidden} cut to keep this result short; narrow it (browser_find, desktop_snapshot filter, a smaller max_chars) or read on with offset`;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  // Reserve room for the closing line; long lines are cut on their own when a line alone is too big.
  const room = maxBytes - 160;
  for (const line of lines) {
    const need = bytes(line) + 1;
    if (used + need > room) break;
    kept.push(line);
    used += need;
  }
  if (kept.length === 0) {
    let head = text.slice(0, Math.max(0, room));
    while (head.length > 0 && bytes(head) > room) head = head.slice(0, Math.floor(head.length * 0.9));
    const last = head.charCodeAt(head.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
    return `${head}\n${cutWords('the rest of this text is')}`;
  }
  const hidden = lines.length - kept.length;
  return `${kept.join('\n')}\n${cutWords(`${hidden} more ${hidden === 1 ? 'line' : 'lines'}`)}`;
}
