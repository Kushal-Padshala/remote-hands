import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DOM_SNAPSHOT_SCRIPT } from '../browser-snapshot.js';
import {
  buildActionScript,
  buildExtractScript,
  buildNavigateScript,
  buildReadyProbe,
  buildSnapshotWithProbe,
  NAV_PENDING_MS,
  buildSnapshotCall,
  type PageOp,
  type PageOpResult,
} from './page-scripts.js';

interface Page {
  win: any;
  doc: any;
  snapshot(): any;
  run(op: PageOp): PageOpResult;
  evalJson(script: string): any;
  node(selector: string): number;
  calls: { requestSubmit: number; scrollBy: Array<unknown> };
}

// jsdom gaps are stubbed here (test only): requestSubmit/scrollBy record calls instead of
// hitting jsdom's "not implemented" paths, and isContentEditable is missing in jsdom.
function makePage(body: string, opts: { contentEditable?: boolean } = {}): Page {
  const dom = new JSDOM(`<!DOCTYPE html><html><head><title>Test Page</title></head><body>${body}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.com/form',
  });
  const win = dom.window as any;
  const calls = { requestSubmit: 0, scrollBy: [] as Array<unknown> };
  win.HTMLFormElement.prototype.requestSubmit = function requestSubmit() {
    calls.requestSubmit++;
  };
  win.scrollBy = (arg: unknown) => {
    calls.scrollBy.push(arg);
  };
  if (opts.contentEditable) {
    Object.defineProperty(win.HTMLElement.prototype, 'isContentEditable', {
      configurable: true,
      get(this: any) {
        const v = this.getAttribute('contenteditable');
        return v !== null && v !== 'false';
      },
    });
    if (!('innerText' in win.HTMLElement.prototype)) {
      Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get(this: any) { return this.textContent; },
      });
    }
  }
  const evalJson = (script: string): any => {
    const raw = win.eval(script);
    expect(typeof raw).toBe('string');
    return JSON.parse(raw);
  };
  return {
    win,
    doc: win.document,
    calls,
    snapshot: () => win.eval(DOM_SNAPSHOT_SCRIPT),
    run: (op) => evalJson(buildActionScript(op)),
    evalJson,
    node: (selector) => {
      const el = win.document.querySelector(selector);
      return win.__rhFast.ids.get(el);
    },
  };
}

const FORM = `
  <form id="f">
    <label for="name">Full name</label><input id="name" type="text" value="">
    <label for="pw">Password</label><input id="pw" type="password" value="">
    <label for="notes">Notes</label><textarea id="notes"></textarea>
    <label><input id="agree" type="checkbox"> Agree to terms</label>
    <label for="color">Color</label>
    <select id="color">
      <option value="r">Red</option>
      <option value="g">Green</option>
      <option value="b">Blue</option>
    </select>
    <label for="age">Age</label><input id="age" type="number">
  </form>
  <button id="go">Go now</button>
`;

describe('snapshot in jsdom', () => {
  it('lists button, text input, checkbox and one select action per non-selected option', () => {
    const page = makePage(FORM);
    const snap = page.snapshot();
    const actions = snap.actions as Array<any>;
    expect(actions.some((a) => a.role === 'button' && a.label === 'Go now')).toBe(true);
    expect(actions.some((a) => a.kind === 'fill' && a.label === 'Full name')).toBe(true);
    expect(actions.some((a) => a.role === 'checkbox' && a.label === 'Agree to terms')).toBe(true);
    const selects = actions.filter((a) => a.kind === 'select');
    expect(selects.map((a) => a.value)).toEqual(['g', 'b']);
  });

  it('exposes name, role and visible helpers on window.__rhFast', () => {
    const page = makePage(FORM);
    page.snapshot();
    expect(typeof page.win.__rhFast.name).toBe('function');
    expect(typeof page.win.__rhFast.role).toBe('function');
    expect(typeof page.win.__rhFast.visible).toBe('function');
  });

  it('buildSnapshotCall evaluates to the snapshot as a JSON string', () => {
    const page = makePage(FORM);
    const snap = page.evalJson(buildSnapshotCall());
    expect(snap.title).toBe('Test Page');
    expect(Array.isArray(snap.actions)).toBe(true);
  });

  it('buildSnapshotCall returns JSON null when the page has no body', () => {
    const page = makePage('');
    page.doc.body.remove();
    expect(page.evalJson(buildSnapshotCall())).toBeNull();
  });

  it('buildReadyProbe returns url, readyState and title', () => {
    const page = makePage(FORM);
    expect(page.evalJson(buildReadyProbe())).toEqual({
      u: 'https://example.com/form',
      r: page.doc.readyState,
      t: 'Test Page',
      o: page.win.performance.timeOrigin,
      p: false,
    });
  });
});

describe('buildActionScript: click', () => {
  it('returns no_snapshot when the page was never snapshotted', () => {
    const page = makePage(FORM);
    expect(page.run({ op: 'click', node: 1, label: 'Go now' })).toEqual({ ok: false, error: 'no_snapshot' });
  });

  it('fires the click listener exactly once and returns the label', () => {
    const page = makePage(FORM);
    page.snapshot();
    let clicks = 0;
    let downs = 0;
    const btn = page.doc.getElementById('go');
    btn.addEventListener('click', () => clicks++);
    btn.addEventListener('mousedown', () => downs++);
    const res = page.run({ op: 'click', node: page.node('#go'), label: 'Go now' });
    expect(res).toEqual({ ok: true, label: 'Go now', navigated: false });
    expect(clicks).toBe(1);
    expect(downs).toBe(1);
  });

  it('returns changed with the current label when the label differs', () => {
    const page = makePage(FORM);
    page.snapshot();
    const res = page.run({ op: 'click', node: page.node('#go'), label: 'Delete everything' });
    expect(res).toEqual({ ok: false, error: 'changed', current: 'Go now' });
  });

  it('returns stale after the element is removed', () => {
    const page = makePage(FORM);
    page.snapshot();
    const node = page.node('#go');
    page.doc.getElementById('go').remove();
    expect(page.run({ op: 'click', node, label: 'Go now' })).toEqual({ ok: false, error: 'stale' });
  });

  it('returns stale for an unknown node id', () => {
    const page = makePage(FORM);
    page.snapshot();
    expect(page.run({ op: 'click', node: 9999, label: '' })).toEqual({ ok: false, error: 'stale' });
  });

  it('skips the label check when the label is empty', () => {
    const page = makePage(FORM);
    page.snapshot();
    expect(page.run({ op: 'click', node: page.node('#go'), label: '' })).toEqual({ ok: true, label: 'Go now', navigated: false });
  });
});

describe('buildActionScript: type', () => {
  it('sets the value via the native setter and fires input and change once each', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('name');
    const seen: string[] = [];
    el.addEventListener('input', () => seen.push('input'));
    el.addEventListener('change', () => seen.push('change'));
    const res = page.run({ op: 'type', node: page.node('#name'), label: 'Full name', text: 'Alice' });
    expect(res).toEqual({ ok: true, label: 'Full name' });
    expect(el.value).toBe('Alice');
    expect(seen).toEqual(['input', 'change']);
  });

  it('uses the prototype setter even when the instance value property is overridden (React style)', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('name');
    let instanceSets = 0;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')!;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return desc.get!.call(this); },
      set(v) { instanceSets++; desc.set!.call(this, v); },
    });
    const res = page.run({ op: 'type', node: page.node('#name'), label: 'Full name', text: 'Bob' });
    expect(res.ok).toBe(true);
    expect(el.value).toBe('Bob');
    expect(instanceSets).toBe(0);
  });

  it('round-trips awkward text byte-for-byte and the script has no raw U+2028/U+2029 or </script', () => {
    const page = makePage(FORM);
    page.snapshot();
    const text = 'a"b\\c\n\u{1F600}`${x}</script>\u2028\u2029\'end';
    const op: PageOp = { op: 'type', node: page.node('#notes'), label: 'Notes', text };
    const script = buildActionScript(op);
    expect(script.includes('\u2028')).toBe(false);
    expect(script.includes('\u2029')).toBe(false);
    expect(script.toLowerCase().includes('</script')).toBe(false);
    const res = page.run(op);
    expect(res).toEqual({ ok: true, label: 'Notes' });
    expect(page.doc.getElementById('notes').value).toBe(text);
  });

  it('types into a password input without echoing the value, and extract never includes it', () => {
    const page = makePage(FORM);
    page.snapshot();
    const res = page.run({ op: 'type', node: page.node('#pw'), label: 'Password', text: 'hunter2-secret' });
    expect(res).toEqual({ ok: true, label: 'Password' });
    expect(JSON.stringify(res)).not.toContain('hunter2');
    expect(page.doc.getElementById('pw').value).toBe('hunter2-secret');
    const ex = page.evalJson(buildExtractScript(10000));
    expect(JSON.stringify(ex)).not.toContain('hunter2');
  });

  it('submit:true dispatches Enter and calls form.requestSubmit once', () => {
    const page = makePage(FORM);
    page.snapshot();
    const keys: string[] = [];
    page.doc.getElementById('name').addEventListener('keydown', (e: any) => keys.push(e.key));
    const res = page.run({ op: 'type', node: page.node('#name'), label: 'Full name', text: 'x', submit: true });
    expect(res.ok).toBe(true);
    expect(keys).toEqual(['Enter']);
    expect(page.calls.requestSubmit).toBe(1);
  });

  it('submit:true does not submit when keydown is default-prevented', () => {
    const page = makePage(FORM);
    page.snapshot();
    page.doc.getElementById('name').addEventListener('keydown', (e: any) => e.preventDefault());
    page.run({ op: 'type', node: page.node('#name'), label: 'Full name', text: 'x', submit: true });
    expect(page.calls.requestSubmit).toBe(0);
  });

  it('returns unsupported when typing into a button or checkbox', () => {
    const page = makePage(FORM);
    page.snapshot();
    expect(page.run({ op: 'type', node: page.node('#go'), label: 'Go now', text: 'x' })).toMatchObject({ ok: false, error: 'unsupported' });
    expect(page.run({ op: 'type', node: page.node('#agree'), label: 'Agree to terms', text: 'x' })).toMatchObject({ ok: false, error: 'unsupported' });
  });

  it('returns failed when the value does not stick on a text input', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('name');
    el.addEventListener('input', () => { el.value = 'reverted'; });
    expect(page.run({ op: 'type', node: page.node('#name'), label: 'Full name', text: 'Alice' }))
      .toEqual({ ok: false, error: 'failed', message: 'value did not stick', current: 'reverted' });
  });

  it('returns failed with the read-back value when a masking handler changes it', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('name');
    el.addEventListener('input', () => { el.value = el.value.toUpperCase(); });
    expect(page.run({ op: 'type', node: page.node('#name'), label: 'Full name', text: 'alice' }))
      .toEqual({ ok: false, error: 'failed', message: 'value did not stick', current: 'ALICE' });
  });

  it('caps the read-back value at 200 chars', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('name');
    el.addEventListener('input', () => { el.value = 'z'.repeat(500); });
    const res = page.run({ op: 'type', node: page.node('#name'), label: 'Full name', text: 'a' }) as { current?: string };
    expect(res.current).toBe('z'.repeat(200));
  });

  it('never returns the read-back value of a password field that did not stick', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('pw');
    el.addEventListener('input', () => { el.value = el.value.toUpperCase(); });
    const res = page.run({ op: 'type', node: page.node('#pw'), label: 'Password', text: 'secret' });
    expect(res).toEqual({ ok: false, error: 'failed', message: 'value did not stick' });
    expect(JSON.stringify(res).toLowerCase()).not.toContain('secret');
  });

  it('returns ok with the value read back for a number input the browser normalises', () => {
    const page = makePage(FORM);
    page.snapshot();
    const res = page.run({ op: 'type', node: page.node('#age'), label: 'Age', text: '0042' });
    expect(res).toEqual({ ok: true, label: 'Age', value: '0042' });
  });

  it('returns failed when non-empty text is rejected by a number input (read-back empty)', () => {
    const page = makePage(FORM);
    page.snapshot();
    const res = page.run({ op: 'type', node: page.node('#age'), label: 'Age', text: 'abc' });
    expect(res).toMatchObject({ ok: false, error: 'failed' });
  });

  it('types into a contenteditable element (textContent fallback) and fires input', () => {
    const page = makePage('<div id="ed" contenteditable="true" aria-label="Editor">old</div>', { contentEditable: true });
    page.snapshot();
    let inputs = 0;
    page.doc.getElementById('ed').addEventListener('input', () => inputs++);
    const res = page.run({ op: 'type', node: page.node('#ed'), label: 'Editor', text: 'new text' });
    expect(res).toEqual({ ok: true, label: 'Editor' });
    expect(page.doc.getElementById('ed').textContent).toBe('new text');
    expect(inputs).toBe(1);
  });
});

describe('buildActionScript: select', () => {
  it('selects by option value and fires input and change', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('color');
    const seen: string[] = [];
    el.addEventListener('input', () => seen.push('input'));
    el.addEventListener('change', () => seen.push('change'));
    const res = page.run({ op: 'select', node: page.node('#color'), label: 'Color', value: 'b' });
    expect(res).toEqual({ ok: true, label: 'Color' });
    expect(el.value).toBe('b');
    expect(seen).toEqual(['input', 'change']);
  });

  it('selects by option label case-insensitively, then by prefix', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('color');
    expect(page.run({ op: 'select', node: page.node('#color'), label: 'Color', value: 'gREEN' }).ok).toBe(true);
    expect(el.value).toBe('g');
    expect(page.run({ op: 'select', node: page.node('#color'), label: 'Color', value: 'Bl' }).ok).toBe(true);
    expect(el.value).toBe('b');
  });

  it('returns no_option listing the available labels', () => {
    const page = makePage(FORM);
    page.snapshot();
    const res = page.run({ op: 'select', node: page.node('#color'), label: 'Color', value: 'Purple' });
    expect(res).toMatchObject({ ok: false, error: 'no_option' });
    const msg = (res as { message?: string }).message ?? '';
    expect(msg).toContain('Red');
    expect(msg).toContain('Green');
    expect(msg).toContain('Blue');
  });

  it('returns unsupported for a non-select element', () => {
    const page = makePage(FORM);
    page.snapshot();
    expect(page.run({ op: 'select', node: page.node('#go'), label: 'Go now', value: 'x' })).toMatchObject({ ok: false, error: 'unsupported' });
  });
});

describe('buildActionScript: check', () => {
  it('toggles a checkbox and is idempotent', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('agree');
    let changes = 0;
    el.addEventListener('change', () => changes++);
    const node = page.node('#agree');
    expect(page.run({ op: 'check', node, label: 'Agree to terms', checked: true })).toEqual({ ok: true, label: 'Agree to terms' });
    expect(el.checked).toBe(true);
    expect(page.run({ op: 'check', node, label: 'Agree to terms', checked: true })).toEqual({ ok: true, label: 'Agree to terms' });
    expect(el.checked).toBe(true);
    expect(changes).toBe(1);
    expect(page.run({ op: 'check', node, label: 'Agree to terms', checked: false }).ok).toBe(true);
    expect(el.checked).toBe(false);
  });

  it('returns failed when the click does not change the state', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('agree');
    el.addEventListener('click', (e: any) => e.preventDefault());
    expect(page.run({ op: 'check', node: page.node('#agree'), label: 'Agree to terms', checked: true }))
      .toMatchObject({ ok: false, error: 'failed' });
  });

  it('handles aria-checked switches', () => {
    const page = makePage('<div id="sw" role="switch" aria-checked="false" aria-label="Wifi" tabindex="0"></div>');
    page.snapshot();
    const el = page.doc.getElementById('sw');
    el.addEventListener('click', () => el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));
    expect(page.run({ op: 'check', node: page.node('#sw'), label: 'Wifi', checked: true })).toEqual({ ok: true, label: 'Wifi' });
    expect(el.getAttribute('aria-checked')).toBe('true');
  });
});

describe('buildActionScript: press and scroll', () => {
  it('press Enter in a form input submits the form', () => {
    const page = makePage(FORM);
    page.snapshot();
    page.doc.getElementById('name').focus();
    const keys: string[] = [];
    page.doc.addEventListener('keydown', (e: any) => keys.push(e.key));
    page.doc.addEventListener('keyup', (e: any) => keys.push('up:' + e.key));
    expect(page.run({ op: 'press', key: 'Enter' })).toEqual({ ok: true });
    expect(keys).toEqual(['Enter', 'up:Enter']);
    expect(page.calls.requestSubmit).toBe(1);
  });

  it('press Escape dispatches on the body without submitting', () => {
    const page = makePage(FORM);
    const keys: string[] = [];
    page.doc.addEventListener('keydown', (e: any) => keys.push(e.key));
    expect(page.run({ op: 'press', key: 'Escape' })).toEqual({ ok: true });
    expect(keys).toEqual(['Escape']);
    expect(page.calls.requestSubmit).toBe(0);
  });

  it('scroll calls window.scrollBy with the delta', () => {
    const page = makePage(FORM);
    expect(page.run({ op: 'scroll', delta: 560 })).toEqual({ ok: true });
    expect(page.calls.scrollBy).toEqual([{ top: 560, behavior: 'instant' }]);
  });
});

describe('buildExtractScript', () => {
  it('prefers main, collapses whitespace and skips script/style', () => {
    const page = makePage(`
      <nav>Navigation junk</nav>
      <main>
        <h1>  Title   here </h1>
        <p>First
           paragraph.</p>
        <script>var secret = 1;</script>
        <style>.x{color:red}</style>
      </main>`);
    const ex = page.evalJson(buildExtractScript(1000));
    expect(ex.title).toBe('Test Page');
    expect(ex.url).toBe('https://example.com/form');
    expect(ex.text).toBe('Title here First paragraph.');
  });

  it('picks the largest of main/article and falls back to body', () => {
    const page = makePage('<article>short</article><article>a much longer article body</article>');
    expect(page.evalJson(buildExtractScript(1000)).text).toBe('a much longer article body');
    const page2 = makePage('<div>just body text</div>');
    expect(page2.evalJson(buildExtractScript(1000)).text).toBe('just body text');
  });

  it('truncates at maxChars with a trailing ellipsis', () => {
    const page = makePage('<main>abcdefghijklmnopqrstuvwxyz</main>');
    expect(page.evalJson(buildExtractScript(10)).text).toBe('abcdefghij…');
  });
});

describe('review fixes', () => {
  it('extract counts collapsed length so indented pages fill maxChars and end with an ellipsis', () => {
    const pad = ' '.repeat(200);
    const paras = Array.from({ length: 100 }, (_, i) => `<p>${pad}paragraph number ${i} has some words${pad}</p>`).join('\n');
    const page = makePage(`<main>${paras}</main>`);
    const text: string = page.evalJson(buildExtractScript(1000)).text;
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeGreaterThanOrEqual(990);
    expect(text.length).toBeLessThanOrEqual(1001);
  });

  it('extract does not descend into select/option', () => {
    const page = makePage('<main>Pick <select><option>Alpha</option><option>Beta</option></select> done</main>');
    expect(page.evalJson(buildExtractScript(1000)).text).toBe('Pick done');
  });

  it('extract truncation does not split a surrogate pair', () => {
    const page = makePage('<main>abcdefghi\u{1F600}xyz</main>');
    expect(page.evalJson(buildExtractScript(10)).text).toBe('abcdefghi…');
  });

  it('extract skips password input values even when set in markup', () => {
    const page = makePage('<main>Login <input type="password" value="pw-in-markup"> <input type="text" value="visible-user"></main>');
    const text: string = page.evalJson(buildExtractScript(1000)).text;
    expect(text).not.toContain('pw-in-markup');
    expect(text).toContain('visible-user');
  });

  it('contenteditable: a successful execCommand is not overwritten and input fires once', () => {
    const page = makePage('<div id="ed" contenteditable="true" aria-label="Editor">old</div>', { contentEditable: true });
    page.snapshot();
    const ed = page.doc.getElementById('ed');
    let inputs = 0;
    ed.addEventListener('input', () => inputs++);
    let execCalls = 0;
    page.doc.execCommand = (cmd: string, _ui: boolean, value: string) => {
      execCalls++;
      expect(cmd).toBe('insertText');
      ed.textContent = value.replace(' ', ' ');
      ed.dispatchEvent(new page.win.Event('input', { bubbles: true }));
      return true;
    };
    const res = page.run({ op: 'type', node: page.node('#ed'), label: 'Editor', text: 'new text' });
    expect(res).toMatchObject({ ok: true, label: 'Editor' });
    expect(execCalls).toBe(1);
    expect(ed.textContent).toBe('new text');
    expect(inputs).toBe(1);
  });

  it('contenteditable: execCommand returning false uses the textContent fallback', () => {
    const page = makePage('<div id="ed" contenteditable="true" aria-label="Editor">old</div>', { contentEditable: true });
    page.snapshot();
    const ed = page.doc.getElementById('ed');
    let inputs = 0;
    ed.addEventListener('input', () => inputs++);
    page.doc.execCommand = () => false;
    const res = page.run({ op: 'type', node: page.node('#ed'), label: 'Editor', text: 'fallback text' });
    expect(res).toEqual({ ok: true, label: 'Editor' });
    expect(ed.textContent).toBe('fallback text');
    expect(inputs).toBe(1);
  });

  it('check on an aria-checked widget that renders asynchronously returns ok with verified:false', () => {
    const page = makePage('<div id="sw" role="switch" aria-checked="false" aria-label="Wifi" tabindex="0"></div>');
    page.snapshot();
    expect(page.run({ op: 'check', node: page.node('#sw'), label: 'Wifi', checked: true }))
      .toEqual({ ok: true, label: 'Wifi', verified: false });
  });

  it('check on a native checkbox whose click is prevented still hard-fails', () => {
    const page = makePage(FORM);
    page.snapshot();
    page.doc.getElementById('agree').addEventListener('click', (e: any) => e.preventDefault());
    expect(page.run({ op: 'check', node: page.node('#agree'), label: 'Agree to terms', checked: true }))
      .toMatchObject({ ok: false, error: 'failed' });
  });

  it('end-to-end: real snapshot actions (Open …, fill, select option) drive ops successfully', () => {
    const page = makePage(FORM);
    const actions = page.snapshot().actions as Array<any>;
    const open = actions.find((a) => a.kind === 'click' && a.label === 'Open Full name');
    const fill = actions.find((a) => a.kind === 'fill' && a.label === 'Full name');
    const option = actions.find((a) => a.kind === 'select' && a.value === 'b');
    const button = actions.find((a) => a.role === 'button');
    expect(open && fill && option && button).toBeTruthy();
    expect(option.label).toBe('Color → Blue');
    expect(page.run({ op: 'click', node: open.node, label: open.label })).toMatchObject({ ok: true });
    expect(page.run({ op: 'type', node: fill.node, label: fill.label, text: 'Zed' })).toMatchObject({ ok: true });
    expect(page.run({ op: 'select', node: option.node, label: option.label, value: option.value })).toMatchObject({ ok: true });
    expect(page.run({ op: 'click', node: button.node, label: button.label })).toMatchObject({ ok: true });
    expect(page.doc.getElementById('name').value).toBe('Zed');
    expect(page.doc.getElementById('color').value).toBe('b');
  });

  it('label tolerance does not accept an unrelated prefix', () => {
    const page = makePage(FORM);
    page.snapshot();
    expect(page.run({ op: 'click', node: page.node('#go'), label: 'Go' })).toMatchObject({ ok: false, error: 'changed' });
    expect(page.run({ op: 'click', node: page.node('#go'), label: 'Open Go' })).toMatchObject({ ok: false, error: 'changed' });
  });

  it('disabled, aria-disabled and disabled-fieldset elements return unsupported', () => {
    const page = makePage(`${FORM}<fieldset id="fs"><button id="inner">Inner</button></fieldset><button id="ad">Aria</button>`);
    page.snapshot();
    const go = page.node('#go');
    const inner = page.node('#inner');
    const ad = page.node('#ad');
    page.doc.getElementById('go').disabled = true;
    page.doc.getElementById('fs').disabled = true;
    page.doc.getElementById('ad').setAttribute('aria-disabled', 'true');
    const expected = { ok: false, error: 'unsupported', message: 'element is disabled' };
    expect(page.run({ op: 'click', node: go, label: 'Go now' })).toEqual(expected);
    expect(page.run({ op: 'click', node: inner, label: 'Inner' })).toEqual(expected);
    expect(page.run({ op: 'click', node: ad, label: 'Aria' })).toEqual(expected);
    const name = page.node('#name');
    page.doc.getElementById('name').disabled = true;
    expect(page.run({ op: 'type', node: name, label: 'Full name', text: 'x' })).toEqual(expected);
  });

  it('an element that became invisible returns stale', () => {
    const page = makePage(FORM);
    page.snapshot();
    const go = page.node('#go');
    page.doc.getElementById('go').setAttribute('aria-hidden', 'true');
    expect(page.run({ op: 'click', node: go, label: 'Go now' })).toEqual({ ok: false, error: 'stale' });
  });

  it('select multiple adds the matching option and keeps the others selected', () => {
    const page = makePage('<label for="m">Tags</label><select id="m" multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>');
    page.snapshot();
    const node = page.node('#m');
    expect(page.run({ op: 'select', node, label: 'Tags', value: 'a' }).ok).toBe(true);
    expect(page.run({ op: 'select', node, label: 'Tags', value: 'c' }).ok).toBe(true);
    const selected = Array.from(page.doc.getElementById('m').selectedOptions).map((o: any) => o.value);
    expect(selected).toEqual(['a', 'c']);
  });

  it('clicking a checkbox through op:click toggles it exactly once', () => {
    const page = makePage(FORM);
    page.snapshot();
    const el = page.doc.getElementById('agree');
    let changes = 0;
    el.addEventListener('change', () => changes++);
    expect(page.run({ op: 'click', node: page.node('#agree'), label: 'Agree to terms' }).ok).toBe(true);
    expect(el.checked).toBe(true);
    expect(changes).toBe(1);
  });

  it('an exception inside the script still evaluates to a JSON failure string', () => {
    const page = makePage(FORM);
    page.snapshot();
    page.win.__rhFast.name = () => { throw new Error('kaboom'); };
    const raw = page.win.eval(buildActionScript({ op: 'click', node: page.node('#go'), label: 'Go now' }));
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw)).toEqual({ ok: false, error: 'failed', message: 'kaboom' });
  });

  it('buildSnapshotCall returns a JSON error object when the snapshot throws', () => {
    const page = makePage(FORM);
    page.doc.querySelectorAll = () => { throw new Error('boom'); };
    expect(page.evalJson(buildSnapshotCall())).toEqual({ error: 'snapshot failed: boom' });
  });
});

describe('light snapshot (fix pass 4)', () => {
  const SECRET = 'hunter2-plaintext';
  const withSecret = (p: Page): void => {
    (p.doc.getElementById('pw') as any).value = SECRET;
    (p.doc.getElementById('name') as any).value = 'Ada';
  };

  it('DOM_SNAPSHOT_SCRIPT without the flag still returns guards, marker and the full page_key', () => {
    const page = makePage(FORM);
    withSecret(page);
    const snap = page.snapshot();
    expect(snap.guards).toBeDefined();
    expect(snap.marker).toBeDefined();
    expect(snap.page_key).toHaveLength(7);
  });

  it('with window.__rhLight the raw script skips guards/marker and page_key is [timeOrigin]', () => {
    const page = makePage(FORM);
    withSecret(page);
    page.win.__rhLight = true;
    const snap = page.snapshot();
    expect('guards' in snap).toBe(false);
    expect('marker' in snap).toBe(false);
    expect(snap.page_key).toEqual([page.win.performance.timeOrigin]);
    expect(JSON.stringify(snap)).not.toContain(SECRET);
  });

  it('the engine wrappers use light mode, strip rect/guards/marker and never carry a password', () => {
    for (const build of [buildSnapshotCall, buildSnapshotWithProbe]) {
      const page = makePage(FORM);
      withSecret(page);
      const raw = page.win.eval(build());
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain('"guards"');
      expect(raw).not.toContain('"marker"');
      expect(raw).not.toContain('"rect"');
      const parsed = JSON.parse(raw);
      const snap = build === buildSnapshotCall ? parsed : parsed.snap;
      expect(snap.page_key).toEqual([page.win.performance.timeOrigin]);
      expect(snap.actions.some((a: any) => a.label === 'Full name' && a.value === 'Ada')).toBe(true);
      // The flag does not leak: a later plain snapshot (legacy driver) is full again.
      expect(page.win.__rhLight).not.toBe(true);
      expect(page.snapshot().guards).toBeDefined();
    }
  });
});

describe('light snapshot normalisation (fix pass 4)', () => {
  it('normalizeSnapshot still reads the light result', async () => {
    const { normalizeSnapshot } = await import('./render.js');
    const page = makePage(FORM);
    const state = normalizeSnapshot(JSON.parse(page.win.eval(buildSnapshotCall())));
    expect(state.title).toBe('Test Page');
    const labels = state.elements.map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining(['Full name', 'Password', 'Agree to terms', 'Color', 'Go now']));
    expect(state.elements.find((e) => e.label === 'Color')?.options).toEqual(['Red', 'Green', 'Blue']);
  });
});

describe('buildSnapshotWithProbe (fix pass 4)', () => {
  it('returns the snapshot and the probe from one evaluation', () => {
    const page = makePage(FORM);
    const res = page.evalJson(buildSnapshotWithProbe());
    expect(Object.keys(res).sort()).toEqual(['probe', 'snap']);
    expect(res.snap.title).toBe('Test Page');
    expect(Array.isArray(res.snap.actions)).toBe(true);
    expect(res.probe).toEqual(page.evalJson(buildReadyProbe()));
  });

  it('reports a null snapshot (and still a probe) for a page without a body', () => {
    const page = makePage('');
    page.doc.body.remove();
    const res = page.evalJson(buildSnapshotWithProbe());
    expect(res.snap).toBeNull();
    expect(res.probe.u).toBe('https://example.com/form');
  });
});

describe('fix round 1: identity guard, navigation flag, navigate script', () => {
  it('an action with a mismatching origin is stale; a matching or missing origin proceeds', () => {
    const page = makePage(FORM);
    const snap = page.snapshot();
    const origin = snap.page_key[0];
    expect(origin).toBe(page.win.performance.timeOrigin);
    const node = page.node('#go');
    expect(page.run({ op: 'click', node, label: 'Go now', origin: origin + 1 })).toEqual({
      ok: false,
      error: 'stale',
      message: 'page changed since the snapshot',
    });
    expect(page.run({ op: 'click', node, label: 'Go now', origin }).ok).toBe(true);
    expect(page.run({ op: 'click', node, label: 'Go now' }).ok).toBe(true);
  });

  it('press also honours the origin guard', () => {
    const page = makePage(FORM);
    expect(page.run({ op: 'press', key: 'Tab', origin: -1 })).toMatchObject({ ok: false, error: 'stale' });
  });

  it('click, type and press install the navigation-pending flag before acting', () => {
    for (const op of ['click', 'type', 'press'] as const) {
      const page = makePage(FORM);
      page.snapshot();
      const res =
        op === 'click'
          ? page.run({ op, node: page.node('#go'), label: 'Go now' })
          : op === 'type'
            ? page.run({ op, node: page.node('#name'), label: 'Full name', text: 'x' })
            : page.run({ op, key: 'Tab' });
      expect(res.ok).toBe(true);
      expect(page.win.__rhNavPending).toBe(0);
      expect(page.evalJson(buildReadyProbe()).p).toBe(false);
      page.win.dispatchEvent(new page.win.Event('beforeunload'));
      expect(page.win.__rhNavPending).toBeGreaterThan(0);
      expect(page.evalJson(buildReadyProbe()).p).toBe(true);
    }
  });

  it('pagehide also sets the flag and handlers are installed once', () => {
    const page = makePage(FORM);
    page.snapshot();
    page.run({ op: 'click', node: page.node('#go'), label: 'Go now' });
    page.run({ op: 'click', node: page.node('#go'), label: 'Go now' });
    page.win.dispatchEvent(new page.win.Event('pagehide'));
    expect(page.win.__rhNavPending).toBeGreaterThan(0);
    expect(page.win.__rhNavHooked).toBe(true);
  });

  it('the navigation flag is a timestamp: a flag older than ~3 s is reported false, a fresh one true', () => {
    const page = makePage(FORM);
    page.snapshot();
    page.run({ op: 'click', node: page.node('#go'), label: 'Go now' });
    page.win.dispatchEvent(new page.win.Event('beforeunload'));
    expect(typeof page.win.__rhNavPending).toBe('number');
    expect(page.evalJson(buildReadyProbe()).p).toBe(true);
    page.win.__rhNavPending = Date.now() - 5000;
    const probe = page.evalJson(buildReadyProbe());
    expect(probe.p).toBe(false);
    expect(Object.keys(probe).sort()).toEqual(['o', 'p', 'r', 't', 'u']);
    page.win.__rhNavPending = Date.now() - 500;
    expect(page.evalJson(buildReadyProbe()).p).toBe(true);
    // minor 5: the expiry (1.5 s) is shorter than the engine's 3 s settle cap
    expect(NAV_PENDING_MS).toBe(1500);
    page.win.__rhNavPending = Date.now() - 2000;
    expect(page.evalJson(buildReadyProbe()).p).toBe(false);
  });

  it('every op clears a leftover navigation flag (select, check, scroll included)', () => {
    const ops = [
      (p: Page) => p.run({ op: 'select', node: p.node('#color'), label: 'Color', value: 'Green' }),
      (p: Page) => p.run({ op: 'check', node: p.node('#agree'), label: 'Agree to terms', checked: true }),
      (p: Page) => p.run({ op: 'scroll', delta: 100 }),
    ];
    for (const run of ops) {
      const page = makePage(FORM);
      page.snapshot();
      page.win.__rhNavPending = Date.now();
      expect(run(page).ok).toBe(true);
      expect(page.evalJson(buildReadyProbe()).p).toBe(false);
    }
  });

  it('buildNavigateScript sets location.href and returns JSON', () => {
    const page = makePage(FORM);
    const url = 'https://example.com/form#a"b</script>';
    const js = buildNavigateScript(url);
    expect(js).not.toContain('</script>');
    expect(page.evalJson(js)).toEqual({ ok: true, o: page.win.performance.timeOrigin });
    expect(page.win.location.hash).toBe('#a%22b%3C/script%3E');
  });
});
