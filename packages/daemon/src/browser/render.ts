/**
 * Model-facing rendering of fast-engine page snapshots. Ids are the snapshot's stable
 * per-element `node` numbers (pseudo actions keep their string ids); the positional
 * snapshot ids (e1, e2, ...) are never used.
 */

export interface PageElement {
  id: number | string;
  node?: number;
  role: string;
  label: string;
  kind: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  /** Dropdown choices the page script did not list (very long dropdowns). */
  optionsOmitted?: number;
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  /** Actions the snapshot dropped beyond its 250-action cap. */
  omitted?: number;
  /** Browser the page was read from (shown in the header). */
  browser?: string;
  /** Visible frames the page script cannot read (cross-origin or sandboxed). */
  blockedFrames?: number;
  /** The page script stopped early (very large page): some nested content was not read. */
  scanTruncated?: boolean;
}

export interface RenderOpts {
  text: boolean;
  maxLines?: number;
  textChars?: number;
}

const ARROW = ' → ';
const MAX_LABEL = 80;
const MAX_OPTIONS = 8;
const DEFAULT_MAX_LINES = 120;
const DEFAULT_TEXT_CHARS = 1200;
/** Page text a delta (or a full render after a change) carries: only what is new, so a short cap is enough. */
const DELTA_TEXT_CHARS = 600;
/** The url in the header of a same-page delta: the model has the full one already. */
const SAME_PAGE_URL_CHARS = 100;
const HEADER_URL_CHARS = 300;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function framesNote(n: number): string {
  return `note: ${n} embedded ${n === 1 ? 'frame' : 'frames'} cannot be read here (other website, sandboxed or nested too deeply); use desktop_snapshot for that part`;
}

const SCAN_TRUNCATED_NOTE = 'note: this page is very large; some nested content was not read';

/** The notes a page state carries (unreadable frames, incomplete read), for any rendering of it. */
export function stateNotes(state: PageState): string[] {
  return [
    ...(state.blockedFrames ? [framesNote(state.blockedFrames)] : []),
    ...(state.scanTruncated ? [SCAN_TRUNCATED_NOTE] : []),
  ];
}

function baseLabel(label: string): string {
  const i = label.lastIndexOf(ARROW);
  return i >= 0 ? label.slice(0, i) : label;
}

function optionLabel(label: string): string {
  const i = label.lastIndexOf(ARROW);
  return i >= 0 ? label.slice(i + ARROW.length) : label;
}

export function normalizeSnapshot(raw: unknown): PageState {
  if (!raw || typeof raw !== 'object') return { url: '', title: '', text: '', elements: [] };
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.actions) ? obj.actions : Array.isArray(obj.elements) ? obj.elements : [];
  const elements: PageElement[] = [];
  const byNode = new Map<number, PageElement>();
  for (const item of list as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const kind = str(a.kind);
    const label = str(a.label);
    if (typeof a.node !== 'number') {
      // Pseudo actions (scroll_down, scroll_up, wait) keep their string ids.
      if (typeof a.id === 'string' && kind) elements.push({ id: a.id, role: kind, label, kind });
      continue;
    }
    const node = a.node;
    const existing = byNode.get(node);
    if (kind === 'select') {
      if (existing) {
        existing.options?.push(optionLabel(label));
        continue;
      }
      const current = str(a.current_value);
      const el: PageElement = { id: node, node, role: 'select', label: baseLabel(label), kind: 'select', value: current };
      el.options = current ? [current, optionLabel(label)] : [optionLabel(label)];
      if (typeof a.options_omitted === 'number' && a.options_omitted > 0) el.optionsOmitted = Math.floor(a.options_omitted);
      byNode.set(node, el);
      elements.push(el);
      continue;
    }
    // Editable fields also emit an 'Open <label>' click action on the same node: drop it.
    if (existing) continue;
    const el: PageElement = { id: node, node, role: str(a.role) || 'element', label, kind };
    if (typeof a.value === 'string') el.value = a.value;
    if (a.checked !== undefined && a.checked !== null) el.checked = a.checked === true || a.checked === 'true';
    byNode.set(node, el);
    elements.push(el);
  }
  const state: PageState = { url: str(obj.url), title: str(obj.title), text: str(obj.text), elements };
  if (typeof obj.omitted_actions === 'number' && obj.omitted_actions > 0) state.omitted = obj.omitted_actions;
  if (typeof obj.frames_blocked === 'number' && Number.isFinite(obj.frames_blocked) && obj.frames_blocked >= 1) {
    state.blockedFrames = Math.floor(obj.frames_blocked);
  }
  if (obj.scan_truncated === true) state.scanTruncated = true;
  return state;
}

/** Single line: control characters and newlines become spaces, whitespace collapses. */
export function clean(s: string, max = MAX_LABEL): string {
  // eslint-disable-next-line no-control-regex
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  let end = max;
  const last = one.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${one.slice(0, end)}…`;
}

function quote(s: string): string {
  return `"${clean(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function showsValue(el: PageElement): boolean {
  if (el.value === undefined) return false;
  if (el.kind === 'select') return true;
  return el.value !== '' && (el.kind === 'fill' || el.role === 'combobox');
}

export function renderElement(el: PageElement, maxOptions = MAX_OPTIONS): string {
  let line = `[${el.id}] ${el.role} ${quote(el.label)}`;
  if (showsValue(el)) line += ` = ${quote(el.value ?? '')}`;
  if (el.checked === true) line += ' [checked]';
  if (el.options && el.options.length > 0) {
    const shown = el.options.slice(0, maxOptions).map((o) => clean(o));
    const more = el.options.length - shown.length + (el.optionsOmitted ?? 0);
    line += ` options: ${shown.join(' | ')}${more > 0 ? ` | …(+${more})` : ''}`;
  }
  return line;
}

function header(state: PageState, urlChars = HEADER_URL_CHARS): string {
  const browser = state.browser ? `browser: ${clean(state.browser, 60)} · ` : '';
  return `${browser}page: ${clean(state.title, 200)} — ${clean(state.url, urlChars)}`;
}

function textLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** The lines of `next` that `prev` did not have (repeats count), and the lines of `prev` that went away. */
export function textChange(prev: string, next: string): { fresh: string[]; gone: string[] } {
  const take = (from: string[], against: string[]): string[] => {
    const left = new Map<string, number>();
    for (const l of against) left.set(l, (left.get(l) ?? 0) + 1);
    const out: string[] = [];
    for (const l of from) {
      const n = left.get(l) ?? 0;
      if (n > 0) left.set(l, n - 1);
      else out.push(l);
    }
    return out;
  };
  const before = textLines(prev);
  const after = textLines(next);
  return { fresh: take(after, before), gone: take(before, after) };
}

/** The `text:` line for what changed on a page: new lines, else what disappeared; null when neither. */
function changeTextLine(prev: string, next: string, chars: number): string | null {
  const { fresh, gone } = textChange(prev, next);
  if (fresh.length > 0) return textLine(fresh.join('\n'), chars);
  if (gone.length > 0) {
    const line = textLine(gone.join('\n'), Math.min(chars, 160));
    return line ? `text gone:${line.slice('text:'.length)}` : null;
  }
  return null;
}

function textLine(text: string, chars: number): string | null {
  if (!text.trim()) return null;
  const cut = text.length > chars ? `${text.slice(0, chars)}…` : text;
  // eslint-disable-next-line no-control-regex
  return `text: ${cut.replace(/\r?\n/g, ' ⏎ ').replace(/[\u0000-\u001f\u007f]/g, ' ')}`;
}

export function renderFull(state: PageState, opts: RenderOpts): string {
  const lines = [header(state)];
  if (opts.text) {
    const t = textLine(state.text, opts.textChars ?? DEFAULT_TEXT_CHARS);
    if (t) lines.push(t);
  }
  const max = opts.maxLines ?? DEFAULT_MAX_LINES;
  if (state.elements.length === 0) lines.push('(no interactive elements)');
  for (const el of state.elements.slice(0, max)) lines.push(renderElement(el));
  if (state.elements.length > max) {
    lines.push(`… ${state.elements.length - max} more elements hidden; use browser_find`);
  }
  if (state.omitted) {
    lines.push(`(${state.omitted} more elements not listed: only the first 250 are captured; use browser_find or scroll)`);
  }
  lines.push(...stateNotes(state));
  return lines.join('\n');
}

export function renderDelta(prev: PageState | null, next: PageState, opts: RenderOpts = { text: false }): string {
  const textChars = opts.textChars ?? DELTA_TEXT_CHARS;
  const full = (): string => {
    // A new page or a mostly new screen (a dialog opening): what it says matters as much as its controls.
    const sameDoc = prev !== null && prev.url === next.url;
    const body = sameDoc ? { ...next, text: textChange(prev!.text, next.text).fresh.join('\n') } : next;
    return `changed: page navigated or re-rendered\n${renderFull(body, { ...opts, text: true, textChars })}`;
  };
  if (!prev || prev.url !== next.url || prev.title !== next.title) return full();
  const before = new Map(prev.elements.map((e) => [String(e.id), e]));
  const after = new Set(next.elements.map((e) => String(e.id)));
  const added: string[] = [];
  const changed: string[] = [];
  const lines: string[] = [];
  let unchanged = 0;
  for (const el of next.elements) {
    const old = before.get(String(el.id));
    const line = renderElement(el);
    if (!old) {
      added.push(line);
      lines.push(`+ ${line}`);
    } else if (renderElement(old) !== line) {
      changed.push(line);
      lines.push(`~ ${line}`);
    } else {
      unchanged += 1;
    }
  }
  const removed = prev.elements.filter((e) => !after.has(String(e.id)));
  for (const el of removed) lines.push(`- [${el.id}] ${quote(el.label)}`);
  const union = new Set([...before.keys(), ...after]).size;
  if (added.length + changed.length + removed.length > union / 2) return full();
  const textLineNow = prev.text !== next.text ? changeTextLine(prev.text, next.text, textChars) : null;
  // An unreadable frame that appeared (or changed count) is news the agent must hear even when
  // nothing else moved; one that went away needs no announcement.
  const framesChanged = (next.blockedFrames ?? 0) > 0 && next.blockedFrames !== prev.blockedFrames;
  const framesGone = (prev.blockedFrames ?? 0) > 0 && !next.blockedFrames;
  const scanChanged = Boolean(next.scanTruncated) !== Boolean(prev.scanTruncated);
  const out = [`${header(next, SAME_PAGE_URL_CHARS)} (same page)`];
  if (lines.length === 0 && !textLineNow && !framesChanged && !framesGone && !scanChanged) return `${out[0]}\nno visible change`;
  if (textLineNow) out.push(textLineNow);
  const news = [
    ...(framesChanged ? [framesNote(next.blockedFrames!)] : []),
    ...(framesGone ? ['note: the frames that could not be read are gone'] : []),
    ...(scanChanged ? [next.scanTruncated ? SCAN_TRUNCATED_NOTE : 'note: the whole page is being read again'] : []),
  ];
  return [...out, ...lines, `(${unchanged} unchanged)`, ...news].join('\n');
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Elements matching `query`, best first: exact label match, then elements whose label,
 * value or role contain every query token (as word prefixes), then partial matches.
 */
export function findElements(state: PageState, query: string, limit: number): PageElement[] {
  const tokens = words(query);
  if (tokens.length === 0) return [];
  const exact = query.trim().toLowerCase();
  const scored: Array<{ el: PageElement; score: number; i: number }> = [];
  state.elements.forEach((el, i) => {
    const hay = words(`${el.label} ${el.value ?? ''} ${el.role} ${(el.options ?? []).join(' ')}`);
    const hits = tokens.filter((t) => hay.some((w) => w.startsWith(t))).length;
    if (hits === 0) return;
    let score = hits;
    if (hits === tokens.length) score += 100;
    if (el.label.trim().toLowerCase() === exact) score += 1000;
    scored.push({ el, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.el);
}
