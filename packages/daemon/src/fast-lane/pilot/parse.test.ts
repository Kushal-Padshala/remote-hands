import { describe, expect, it } from 'vitest';
import { renderDelta, renderElement, renderFull, type PageElement, type PageState } from '../../browser/render.js';
import { parseRendered } from './parse.js';
import type { PilotView, UiElement } from './types.js';

const URL1 = 'https://app.collegepulse.com/route/01a0e81a-2d48-75d9-9fa7-0d6d71efbf72?growthChannel=pdashboard-new';

// Real engine output from the HUD survey log.
const FULL = [
  `browser: Google Chrome · page: College Pulse Survey — ${URL1}`,
  '[1] radio "Very confident"',
  '[2] radio "Somewhat confident"',
  '[3] radio "Neither confident nor worried"',
  '[4] radio "Somewhat worried"',
  '[5] radio "Very worried"',
  '[6] button "Next"',
  '[wait] wait "Wait for the page to update"',
].join('\n');

const DELTA = [
  'did: check, click',
  `browser: Google Chrome · page: College Pulse Survey — ${URL1} (same page)`,
  '~ [2] radio "Somewhat confident" [checked]',
  '- [6] "Next"',
  '(5 unchanged)',
].join('\n');

const NAVIGATED = [
  'did: wait',
  'changed: page navigated or re-rendered',
  `browser: Google Chrome · page: College Pulse Survey — ${URL1}`,
  '[7] radio "Very concerned"',
  '[8] radio "Somewhat concerned"',
  '[12] button "Next"',
  '[wait] wait "Wait for the page to update"',
].join('\n');

describe('parseRendered: real engine samples', () => {
  it('parses a full snapshot: header, ids, roles, labels and pseudo actions', () => {
    const v = parseRendered(FULL);
    expect(v.browser).toBe('Google Chrome');
    expect(v.title).toBe('College Pulse Survey');
    expect(v.url).toBe(URL1);
    expect(v.sameDocument).toBe(false);
    expect(v.changed).toBe(true);
    expect(v.elements.map((e) => [e.id, e.role, e.label])).toEqual([
      ['1', 'radio', 'Very confident'],
      ['2', 'radio', 'Somewhat confident'],
      ['3', 'radio', 'Neither confident nor worried'],
      ['4', 'radio', 'Somewhat worried'],
      ['5', 'radio', 'Very worried'],
      ['6', 'button', 'Next'],
      ['wait', 'wait', 'Wait for the page to update'],
    ]);
    expect(v.elements.find((e) => e.id === 'wait')?.pseudo).toBe(true);
    expect(v.elements.find((e) => e.id === '6')?.pseudo).toBeUndefined();
  });

  it('applies a delta (changed, removed) to the previous view', () => {
    const prev = parseRendered(FULL);
    const v = parseRendered(DELTA, prev);
    expect(v.sameDocument).toBe(true);
    expect(v.changed).toBe(true);
    expect(v.elements.find((e) => e.id === '2')?.checked).toBe(true);
    expect(v.elements.find((e) => e.id === '6')).toBeUndefined();
    expect(v.elements).toHaveLength(6);
  });

  it('replaces the list when the page navigated', () => {
    const v = parseRendered(NAVIGATED, parseRendered(FULL));
    expect(v.sameDocument).toBe(false);
    expect(v.elements.map((e) => e.id)).toEqual(['7', '8', '12', 'wait']);
  });

  it('returns the previous elements with changed:false for "no visible change"', () => {
    const prev = parseRendered(FULL);
    const v = parseRendered(`browser: Google Chrome · page: College Pulse Survey — ${URL1} (same page)\nno visible change`, prev);
    expect(v.changed).toBe(false);
    expect(v.sameDocument).toBe(true);
    expect(v.elements).toEqual(prev.elements);
  });

  it('adds new elements from "+" lines and tolerates a delta with no previous view', () => {
    const prev = parseRendered(FULL);
    const v = parseRendered(`page: P — u (same page)\n+ [9] button "Finish"\n(7 unchanged)`, prev);
    expect(v.elements.at(-1)).toMatchObject({ id: '9', role: 'button', label: 'Finish' });
    const orphan = parseRendered(`page: P — u (same page)\n+ [9] button "Finish"`, null);
    expect(orphan.elements.map((e) => e.id)).toEqual(['9']);
  });

  it('reads the text line and converts the newline marker', () => {
    const v = parseRendered('page: P — https://x.test\ntext: Hello ⏎ world\n[1] button "Go"');
    expect(v.text).toBe('Hello\nworld');
  });

  it('parses an empty page and keeps unknown lines as notes', () => {
    const v = parseRendered('page: Empty — https://x.test\n(no interactive elements)');
    expect(v.elements).toEqual([]);
    const n = parseRendered('page: P — https://x.test\n[1] button "Go"\nnote: fast browser path unavailable; using fallback');
    expect(n.notes).toEqual(['note: fast browser path unavailable; using fallback']);
    expect(n.elements).toHaveLength(1);
  });

  it('flags an unavailable state and keeps the previous elements', () => {
    const prev = parseRendered(FULL);
    const v = parseRendered('(state unavailable: tab closed; call browser_snapshot)', prev);
    expect(v.stateUnavailable).toBe(true);
    expect(v.elements).toEqual(prev.elements);
  });
});

describe('parseRendered: element line details', () => {
  const one = (line: string): UiElement => parseRendered(`page: P — u\n${line}`).elements[0]!;

  it('unescapes quotes and backslashes in labels and values', () => {
    expect(one('[3] textbox "Say \\"hi\\" \\\\ now" = "a \\"b\\""')).toMatchObject({ label: 'Say "hi" \\ now', value: 'a "b"' });
  });

  it('reads value, checked and options', () => {
    expect(one('[4] select "Country" = "France" options: France | Spain | …(+3)')).toMatchObject({
      role: 'select', label: 'Country', value: 'France', options: ['France', 'Spain'], optionsMore: 3,
    });
    expect(one('[5] checkbox "Agree" [checked]')).toMatchObject({ checked: true });
    expect(one('[6] textbox "Email" = ""').value).toBe('');
  });

  it('keeps labels that contain brackets, arrows and unicode', () => {
    expect(one('[7] button "Next → [step 2] 🙂"').label).toBe('Next → [step 2] 🙂');
  });
});

// ---- property test: parsing is the exact inverse of the real renderer ----

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomState(rand: () => number): PageState {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const pieces = ['Next', 'Very confident', 'a "quoted" word', 'back\\slash', 'emoji 🙂', 'Zürich', 'x'.repeat(100), '  spaced   out  ', 'line\nbreak', '[1]', '→ arrow', 'a = b'];
  const label = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(pieces)).join(' ');
  const elements: PageElement[] = [];
  const n = Math.floor(rand() * 14);
  for (let i = 0; i < n; i++) {
    const role = pick(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'select'] as const);
    if (role === 'select') {
      const options = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, k) => `opt ${k} ${pick(['a', 'b', 'é'])}`);
      elements.push({ id: i + 1, node: i + 1, role, label: label(), kind: 'select', value: rand() < 0.5 ? options[0]! : '', options });
    } else {
      const el: PageElement = { id: i + 1, node: i + 1, role, label: label(), kind: role === 'textbox' || role === 'combobox' ? 'fill' : 'click' };
      if (el.kind === 'fill' && rand() < 0.6) el.value = label();
      if ((role === 'checkbox' || role === 'radio') && rand() < 0.4) el.checked = true;
      elements.push(el);
    }
  }
  if (rand() < 0.5) elements.push({ id: 'wait', role: 'wait', label: 'Wait for the page to update', kind: 'wait' });
  return { url: 'https://example.test/p', title: 'Page ' + pick(pieces), text: rand() < 0.5 ? 'some text\nmore' : '', elements, browser: 'Google Chrome' };
}

/** Rebuilds engine elements from parsed ones so the real renderer can reproduce the original lines. */
function toPageElement(e: UiElement): PageElement {
  const base: PageElement = { id: e.pseudo ? e.id : Number(e.id), role: e.role, label: e.label, kind: e.pseudo ? e.role : 'click' };
  if (e.options) {
    base.kind = 'select';
    base.options = [...e.options, ...Array.from({ length: e.optionsMore ?? 0 }, () => 'more')];
  } else if (e.value !== undefined) base.kind = 'fill';
  if (e.value !== undefined) base.value = e.value;
  if (e.checked) base.checked = true;
  return base;
}

const linesOf = (view: PilotView) => view.elements.map((e) => renderElement(toPageElement(e)));
const expectedLines = (state: PageState) => state.elements.map((e) => renderElement(e));

describe('parseRendered: round trip with the real renderer', () => {
  it('parses what renderFull produces and the real renderer reproduces the same lines (200 random pages)', () => {
    const rand = rng(12345);
    for (let i = 0; i < 200; i++) {
      const state = randomState(rand);
      const parsed = parseRendered(renderFull(state, { text: true }));
      expect(linesOf(parsed)).toEqual(expectedLines(state));
      expect(parsed.title).toBeTypeOf('string');
    }
  });

  it('applies what renderDelta produces so the result matches the next page (200 random transitions)', () => {
    const rand = rng(777);
    for (let i = 0; i < 200; i++) {
      const prev = randomState(rand);
      const next: PageState = { ...prev, elements: prev.elements.map((e) => ({ ...e })) };
      // mutate a few elements
      for (const el of next.elements) {
        if (rand() < 0.15 && el.kind === 'click' && (el.role === 'radio' || el.role === 'checkbox')) el.checked = !el.checked;
        if (rand() < 0.1 && el.kind === 'fill') el.value = 'typed ' + i;
      }
      if (rand() < 0.2 && next.elements.length > 2) next.elements.pop();
      const parsedPrev = parseRendered(renderFull(prev, { text: false }));
      const out = renderDelta(prev, next, { text: false });
      const parsed = parseRendered(out, parsedPrev);
      expect(linesOf(parsed).sort()).toEqual(expectedLines(next).sort());
    }
  });
});
