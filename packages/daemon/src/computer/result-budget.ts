/**
 * agy saves a tool result of about 4 KB or more (smallest seen: 4284 bytes; the largest seen kept
 * inline: 3629) to a file and gives the model only its path, which costs a whole extra turn to
 * open. Every result is held under this size so it stays inline.
 */
export const RESULT_MAX_BYTES = 3700;

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** The longest start of `s` that fits in `max` bytes, without splitting a surrogate pair. */
function headBytes(s: string, max: number): string {
  if (max <= 0) return '';
  let head = s.slice(0, max);
  while (head.length > 0 && bytes(head) > max) head = head.slice(0, Math.floor(head.length * 0.9));
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head;
}

/** `text` unchanged when it fits, else its leading lines (or characters) plus a line saying how to read the rest. */
export function fitResult(text: string, maxBytes: number = RESULT_MAX_BYTES): string {
  if (bytes(text) <= maxBytes) return text;
  const note = (hidden: string): string =>
    `… ${hidden} cut to keep this result short; narrow it (browser_find, desktop_snapshot filter, a smaller max_chars) or read on with offset`;
  // Longest note is the character one; if even that leaves no room, the text alone is cut to size.
  const reserve = bytes(note('the rest of this text is')) + 1;
  if (maxBytes < reserve + 40) return headBytes(text, maxBytes);
  const room = maxBytes - reserve;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  let partial = '';
  for (const line of lines) {
    const need = bytes(line) + 1;
    if (used + need <= room) {
      kept.push(line);
      used += need;
      continue;
    }
    // A line too big for what is left: when little has been kept (a header and then one huge body
    // line), keep the start of that line rather than nothing.
    if (used < room / 2) partial = headBytes(line, room - used - 1);
    break;
  }
  if (partial) {
    return `${[...kept, partial].join('\n')}\n${note('the rest of this text is')}`;
  }
  const hidden = lines.length - kept.length;
  return `${kept.join('\n')}\n${note(`${hidden} more ${hidden === 1 ? 'line' : 'lines'}`)}`;
}
