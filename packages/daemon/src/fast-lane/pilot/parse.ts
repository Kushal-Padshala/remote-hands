import type { PilotView, UiElement } from './types.js';

// Mirrors browser/render.ts: `[id] role "label" = "value" [checked] options: a | b | …(+N)`.
const HEADER = /^(?:browser: (.*?) · )?page: (.*) — (.*?)( \(same page\))?$/;
const ELEMENT = /^([+~] )?\[([^\]]+)\] ([^"]+?) "((?:[^"\\]|\\.)*)"(.*)$/;
const REMOVED = /^- \[([^\]]+)\] "(?:[^"\\]|\\.)*"$/;
const REST = /^(?: = "((?:[^"\\]|\\.)*)")?( \[checked\])?(?: options: (.*))?$/;
const MORE_OPTIONS = /^…\(\+(\d+)\)$/;

const unquote = (s: string): string => s.replace(/\\(["\\])/g, '$1');

function parseElement(id: string, role: string, label: string, rest: string): UiElement | null {
  const tail = REST.exec(rest);
  if (tail === null) return null;
  const el: UiElement = { id, role, label: unquote(label) };
  if (tail[1] !== undefined) el.value = unquote(tail[1]);
  if (tail[2] !== undefined) el.checked = true;
  if (tail[3] !== undefined) {
    const parts = tail[3].split(' | ');
    const last = parts.at(-1);
    const more = last === undefined ? null : MORE_OPTIONS.exec(last);
    if (more) {
      parts.pop();
      el.optionsMore = Number(more[1]);
    }
    el.options = parts;
  }
  if (!/^\d+$/.test(id)) el.pseudo = true;
  return el;
}

/**
 * Parses the model-facing text the browser tools return (a full snapshot, or a delta marked
 * "(same page)") into a structured view. A delta is applied to `prev`; anything else replaces it.
 */
export function parseRendered(text: string, prev: PilotView | null = null): PilotView {
  const notes: string[] = [];
  let header: { browser: string | undefined; title: string; url: string; same: boolean } | null = null;
  let pageText: string | undefined;
  let stateUnavailable = false;
  let noChange = false;
  const listed: Array<{ prefix: '' | '+' | '~'; el: UiElement }> = [];
  const removed = new Set<string>();

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (line.startsWith('(state unavailable')) {
      stateUnavailable = true;
      notes.push(line);
      continue;
    }
    const h: RegExpExecArray | null = header === null ? HEADER.exec(line) : null;
    if (h) {
      header = { browser: h[1], title: h[2]!, url: h[3]!, same: h[4] !== undefined };
      continue;
    }
    if (line.startsWith('no visible change')) {
      noChange = true;
      continue;
    }
    if (line.startsWith('text: ')) {
      pageText = line.slice(6).replace(/ ⏎ /g, '\n');
      continue;
    }
    if (line === '(no interactive elements)' || /^\(\d+ unchanged\)$/.test(line)) continue;
    if (line.startsWith('did: ') || line.startsWith('changed: ')) continue;
    const gone = REMOVED.exec(line);
    if (gone) {
      removed.add(gone[1]!);
      continue;
    }
    const m = ELEMENT.exec(line);
    if (m) {
      const el = parseElement(m[2]!, m[3]!, m[4]!, m[5]!);
      if (el) {
        listed.push({ prefix: (m[1]?.trim() ?? '') as '' | '+' | '~', el });
        continue;
      }
    }
    notes.push(line);
  }

  const delta = header?.same === true;
  let elements: UiElement[];
  if (delta || (stateUnavailable && header === null)) {
    elements = (prev?.elements ?? []).map((e) => ({ ...e }));
    for (const { el } of listed) {
      const at = elements.findIndex((e) => e.id === el.id);
      if (at >= 0) elements[at] = el;
      else elements.push(el);
    }
    if (removed.size > 0) elements = elements.filter((e) => !removed.has(e.id));
  } else {
    elements = listed.map((l) => l.el);
  }

  const view: PilotView = {
    title: header?.title ?? prev?.title ?? '',
    url: header?.url ?? prev?.url ?? '',
    elements,
    sameDocument: delta,
    changed: !noChange && !stateUnavailable,
    stateUnavailable,
    notes,
  };
  const browser = header?.browser ?? prev?.browser;
  if (browser !== undefined) view.browser = browser;
  const textOut = pageText ?? (delta ? prev?.text : undefined);
  if (textOut !== undefined) view.text = textOut;
  return view;
}
