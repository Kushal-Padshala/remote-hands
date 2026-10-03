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
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
}

export interface RenderOpts {
  text: boolean;
  maxLines?: number;
  textChars?: number;
}

const ARROW = ' → ';
const MAX_LABEL = 80;
const MAX_OPTIONS = 5;
const DEFAULT_MAX_LINES = 120;
const DEFAULT_TEXT_CHARS = 1200;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function baseLabel(label: string): string {
  const i = label.indexOf(ARROW);
  return i >= 0 ? label.slice(0, i) : label;
}

function optionLabel(label: string): string {
  const i = label.indexOf(ARROW);
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
  return { url: str(obj.url), title: str(obj.title), text: str(obj.text), elements };
}

/** Single line: control characters and newlines become spaces, whitespace collapses. */
export function clean(s: string, max = MAX_LABEL): string {
  // eslint-disable-next-line no-control-regex
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function quote(s: string): string {
  return `"${clean(s).replace(/"/g, '\\"')}"`;
}

function showsValue(el: PageElement): boolean {
  if (el.value === undefined) return false;
  if (el.kind === 'select') return true;
  return el.value !== '' && (el.kind === 'fill' || el.role === 'combobox');
}

export function renderElement(el: PageElement): string {
  let line = `[${el.id}] ${el.role} ${quote(el.label)}`;
  if (showsValue(el)) line += ` = ${quote(el.value ?? '')}`;
  if (el.checked === true) line += ' [checked]';
  if (el.options && el.options.length > 0) {
    const shown = el.options.slice(0, MAX_OPTIONS).map((o) => clean(o));
    const more = el.options.length - shown.length;
    line += ` options: ${shown.join(' | ')}${more > 0 ? ` | …(+${more})` : ''}`;
  }
  return line;
}

function header(state: PageState): string {
  return `page: ${clean(state.title, 200)} — ${clean(state.url, 500)}`;
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
  return lines.join('\n');
}

export function renderDelta(prev: PageState | null, next: PageState, opts: RenderOpts = { text: false }): string {
  const full = (): string => `changed: page navigated or re-rendered\n${renderFull(next, opts)}`;
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
  const textChanged = prev.text !== next.text;
  const out = [`${header(next)} (same page)`];
  if (lines.length === 0 && !textChanged) return `${out[0]}\nno visible change`;
  if (textChanged) {
    const t = textLine(next.text, opts.textChars ?? DEFAULT_TEXT_CHARS);
    if (t) out.push(t);
  }
  return [...out, ...lines, `(${unchanged} unchanged)`].join('\n');
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
    const hay = words(`${el.label} ${el.value ?? ''} ${el.role}`);
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
