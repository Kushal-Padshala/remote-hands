import type { View } from './ax-model.js';

/**
 * Reading a window by sight is the last resort for a window that shows almost nothing through Accessibility
 * (games, canvas editors, some Electron and remote-desktop windows). The helper takes one picture of that one window
 * and reads its text with Vision; this module turns the answer into what the model reads: one short line per piece of
 * text, with an id that only desktop_click accepts. Pure functions, no I/O.
 */

/** Ids of text read by sight start here, far above any accessibility id, so the two can never be mistaken for each other. */
export const OCR_ID_BASE = 100_000;

/** The first words of the block: what the HUD feed and the tests recognise it by. */
export const OCR_HEADER = 'read by sight (OCR)';

/** What the helper answers to the ocr request. Boxes are in screen points, origin at the top left of the main display. */
export interface OcrReading {
  ok: true;
  app: { name: string; pid: number; bundle?: string };
  window: { title: string; x: number; y: number; width: number; height: number };
  lines: Array<{ text: string; x: number; y: number; width: number; height: number }>;
  truncated: boolean;
  captureMs: number;
  ocrMs: number;
  elapsedMs: number;
}

export interface OcrItem {
  id: number;
  text: string;
  /** The point a click goes to: the middle of the text. */
  x: number;
  y: number;
}

export interface OcrView {
  text: string;
  items: OcrItem[];
  byId: Map<number, OcrItem>;
}

const MAX_LINES = 120;
const MAX_TEXT = 80;

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

const clipText = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1).trimEnd()}…` : one;
};

/**
 * Whether Accessibility shows this window as good as nothing: no control the model could press or type into, apart from
 * the menu bar and the window's own close/minimise/zoom buttons. Strict on purpose: a small dialog with two buttons is
 * not blind.
 */
export function looksBlind(view: View): boolean {
  const chrome = /^(close|minimi[sz]e|zoom|full[- ]?screen)( button)?$/i;
  return !view.items.some((item) => item.interactive && item.role !== 'menu' && !chrome.test(item.label.trim()));
}

/** The note added to a snapshot of a blind window. */
export const BLIND_NOTE =
  'note: this window shows almost nothing to Accessibility. If what you need is not listed, call desktop_snapshot with ocr=true to read the window by sight (slower).';

/** Text Accessibility already shows at a place: reading it again by sight would only repeat it. */
function coveredByAccessibility(text: string, x: number, y: number, view: View | null): boolean {
  if (!view) return false;
  const wanted = normalize(text);
  if (!wanted) return false;
  for (const item of view.items) {
    const f = item.frame;
    if (!f || x < f.x || x > f.x + f.width || y < f.y || y > f.y + f.height) continue;
    const have = normalize(item.label);
    if (have && (have === wanted || (wanted.length >= 3 && have.includes(wanted)))) return true;
  }
  return false;
}

export function buildOcrView(reading: OcrReading, opts: { filter?: string; axView?: View | null } = {}): OcrView {
  const win = reading.window;
  const filter = opts.filter ? normalize(opts.filter) : '';
  const items: OcrItem[] = [];
  const shown: string[] = [];
  let hiddenByFilter = 0;
  let repeated = 0;
  let cut = 0;
  let id = OCR_ID_BASE;
  for (const line of reading.lines) {
    const text = clipText(line.text);
    if (!text) continue;
    const x = Math.round(line.x + line.width / 2);
    const y = Math.round(line.y + line.height / 2);
    if (coveredByAccessibility(text, x, y, opts.axView ?? null)) {
      repeated += 1;
      continue;
    }
    if (filter && !normalize(text).includes(filter)) {
      hiddenByFilter += 1;
      continue;
    }
    if (items.length >= MAX_LINES) {
      cut += 1;
      continue;
    }
    id += 1;
    items.push({ id, text, x, y });
    const px = win.width > 0 ? Math.round(((x - win.x) / win.width) * 100) : 0;
    const py = win.height > 0 ? Math.round(((y - win.y) / win.height) * 100) : 0;
    shown.push(`[${id}] "${text.replace(/"/g, "'")}" @${Math.max(0, Math.min(100, px))},${Math.max(0, Math.min(100, py))}`);
  }
  const title = win.title ? ` "${clipText(win.title).replace(/"/g, "'")}"` : '';
  const head =
    `${OCR_HEADER} of ${reading.app.name || 'the app'} window${title}: ${items.length} text line${items.length === 1 ? '' : 's'} in ${Math.max(1, reading.elapsedMs)} ms. ` +
    'These ids can only be clicked with desktop_click (they are not Accessibility elements, so no typing, scrolling or reading by id); @x,y is the place in the window in percent from its top left. ' +
    'They stay valid until the next action.';
  const tail: string[] = [];
  if (cut > 0 || reading.truncated) tail.push(`… ${cut > 0 ? `${cut} more lines` : 'more lines'} not shown (use filter to search them)`);
  if (hiddenByFilter > 0) tail.push(`(${hiddenByFilter} lines hidden by the filter)`);
  if (repeated > 0) tail.push(`(${repeated} lines are already listed above by Accessibility)`);
  if (reading.lines.length === 0) tail.push('(no text found in the window)');
  return { text: [head, ...shown, ...tail].join('\n'), items, byId: new Map(items.map((item) => [item.id, item])) };
}
