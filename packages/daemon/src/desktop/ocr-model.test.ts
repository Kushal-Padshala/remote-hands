import { describe, expect, it } from 'vitest';
import { buildView } from './ax-model.js';
import type { AxNode, AxSnapshot } from './ax-helper.js';
import { BLIND_NOTE, OCR_HEADER, OCR_ID_BASE, buildOcrView, looksBlind, type OcrReading } from './ocr-model.js';

const snap = (nodes: AxNode[]): AxSnapshot => ({ ok: true, app: { name: 'App', pid: 1 }, window: { title: 'W' }, nodes, truncated: false, timedOut: false, elapsedMs: 1 });
const WIN: AxNode = { id: 1, parent: 0, role: 'AXWindow', x: 0, y: 0, width: 800, height: 600 };
const btn = (id: number, label: string, x = 10, y = 10): AxNode => ({ id, parent: 1, role: 'AXButton', label, actions: ['AXPress'], x, y, width: 60, height: 20 });

const reading = (lines: OcrReading['lines'], over: Partial<OcrReading> = {}): OcrReading => ({
  ok: true,
  app: { name: 'Game', pid: 5 },
  window: { title: 'Lobby', x: 100, y: 200, width: 400, height: 300 },
  lines,
  truncated: false,
  captureMs: 100,
  ocrMs: 200,
  elapsedMs: 330,
  ...over,
});

describe('looksBlind', () => {
  it('is blind with only window buttons and the menu bar', () => {
    const view = buildView(snap([WIN, btn(2, 'close button'), btn(3, 'minimize button'), { id: 4, parent: 0, role: 'AXMenuBarItem', label: 'File', actions: ['AXPress'], x: 0, y: 0, width: 20, height: 10 }]));
    expect(looksBlind(view)).toBe(true);
  });

  it('is blind with nothing at all', () => {
    expect(looksBlind(buildView(snap([WIN])))).toBe(true);
  });

  it('is not blind with one real control, so a small dialog never gets the note', () => {
    expect(looksBlind(buildView(snap([WIN, btn(2, 'OK')])))).toBe(false);
    expect(looksBlind(buildView(snap([WIN, { id: 2, parent: 1, role: 'AXTextField', label: 'Name', value: '', x: 0, y: 0, width: 50, height: 10 }])))).toBe(false);
  });

  it('the note names the way out and says it is slower', () => {
    expect(BLIND_NOTE).toContain('ocr=true');
    expect(BLIND_NOTE).toContain('slower');
  });
});

describe('buildOcrView', () => {
  it('numbers lines from the base and gives the place in the window in percent', () => {
    const view = buildOcrView(reading([{ text: 'Play', x: 280, y: 340, width: 40, height: 20 }]));
    // middle: x 300, y 350 -> (300-100)/400 = 50%, (350-200)/300 = 50%
    expect(view.items).toEqual([{ id: OCR_ID_BASE + 1, text: 'Play', x: 300, y: 350 }]);
    expect(view.text.split('\n')[1]).toBe(`[${OCR_ID_BASE + 1}] "Play" @50,50`);
    expect(view.text.startsWith(`${OCR_HEADER} of Game window "Lobby": 1 text line in 330 ms.`)).toBe(true);
    expect(view.byId.get(OCR_ID_BASE + 1)?.text).toBe('Play');
  });

  it('tells the model these ids are click-only and short-lived', () => {
    const head = buildOcrView(reading([])).text;
    expect(head).toContain('can only be clicked with desktop_click');
    expect(head).toContain('until the next action');
    expect(head).toContain('(no text found in the window)');
  });

  it('cuts long text and keeps quotes from breaking the line', () => {
    const view = buildOcrView(reading([{ text: `say "hi" ${'x'.repeat(200)}`, x: 100, y: 200, width: 10, height: 10 }]));
    expect(view.items[0]!.text.length).toBeLessThanOrEqual(80);
    expect(view.text.split('\n')[1]).toMatch(/^\[100001\] "say 'hi' x+…" @/);
  });

  it('keeps places inside 0..100 even for text on the edge', () => {
    const view = buildOcrView(reading([{ text: 'Edge', x: 0, y: 0, width: 4, height: 4 }, { text: 'Far', x: 900, y: 900, width: 4, height: 4 }]));
    expect(view.text).toContain('"Edge" @0,0');
    expect(view.text).toContain('"Far" @100,100');
  });

  it('caps the list and says how many were left out', () => {
    const lines = Array.from({ length: 130 }, (_, i) => ({ text: `Item ${i}`, x: 100, y: 200 + i, width: 10, height: 5 }));
    const view = buildOcrView(reading(lines));
    expect(view.items).toHaveLength(120);
    expect(view.text).toContain('… 10 more lines not shown (use filter to search them)');
  });

  it('a filter narrows by text and counts what it hid', () => {
    const view = buildOcrView(reading([{ text: 'Play now', x: 100, y: 200, width: 10, height: 5 }, { text: 'Quit', x: 100, y: 230, width: 10, height: 5 }]), { filter: 'play' });
    expect(view.items.map((i) => i.text)).toEqual(['Play now']);
    expect(view.text).toContain('(1 lines hidden by the filter)');
  });

  it('leaves out text Accessibility already shows at that very place, but not the same word elsewhere', () => {
    const ax = buildView(snap([WIN, { ...btn(2, 'Save', 100, 200), width: 60, height: 20 }]));
    const view = buildOcrView(
      reading([
        { text: 'Save', x: 110, y: 205, width: 30, height: 10 },
        { text: 'Save', x: 300, y: 400, width: 30, height: 10 },
      ]),
      { axView: ax },
    );
    expect(view.items.map((i) => [i.text, i.x])).toEqual([['Save', 315]]);
    expect(view.text).toContain('(1 lines are already listed above by Accessibility)');
  });

  it('says when the helper could not read everything', () => {
    expect(buildOcrView(reading([{ text: 'A', x: 100, y: 200, width: 5, height: 5 }], { truncated: true })).text).toContain('more lines not shown');
  });
});
