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
function nodeOf(p: Page, el: unknown): number {
  return p.win.__rhFast.ids.get(el);
}

function addFrame(p: Page, html: string, rect = { left: 10, top: 20, width: 300, height: 200 }, parent: any = p.doc.body): any {
  const frame = p.doc.createElement('iframe');
  parent.appendChild(frame);
  frame.contentDocument.body.innerHTML = html;
  frame.getBoundingClientRect = () => ({
    x: rect.left, y: rect.top, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    right: rect.left + rect.width, bottom: rect.top + rect.height,
  });
  return frame;
}

describe('snapshot across shadow roots and frames', () => {
  it('lists controls and text inside an open shadow root and keeps them actionable', () => {
    const p = makePage('<div id="host"></div><button id="top">Top</button>');
    const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<p>Secure checkout</p><input id="card" type="text" aria-label="Card number"><button id="pay">Pay now</button>';
    let clicks = 0;
    root.getElementById('pay').addEventListener('click', () => { clicks += 1; });
    const snap = p.evalJson(buildSnapshotCall());
    const labels = snap.actions.map((a: any) => a.label);
    expect(labels).toEqual(expect.arrayContaining(['Top', 'Pay now', 'Card number']));
    expect(snap.text).toContain('Secure checkout');
    expect(p.run({ op: 'click', node: nodeOf(p, root.getElementById('pay')), label: 'Pay now' })).toMatchObject({ ok: true });
    expect(clicks).toBe(1);
  });

  it('lists controls inside a same-origin iframe and acts on them', () => {
    const p = makePage('<button id="top">Top</button>');
    const frame = addFrame(p, '<input id="q" type="text" aria-label="Survey answer"><button id="next">Next question</button>');
    let clicks = 0;
    frame.contentDocument.getElementById('next').addEventListener('click', () => { clicks += 1; });
    const snap = p.evalJson(buildSnapshotCall());
    const next = snap.actions.find((a: any) => a.label === 'Next question');
    expect(next).toBeDefined();
    expect(p.run({ op: 'click', node: next.node, label: 'Next question' })).toMatchObject({ ok: true });
    expect(clicks).toBe(1);
    const q = snap.actions.find((a: any) => a.label === 'Survey answer');
    expect(p.run({ op: 'type', node: q.node, label: 'Survey answer', text: 'Somewhat confident' })).toMatchObject({ ok: true });
    expect(frame.contentDocument.getElementById('q').value).toBe('Somewhat confident');
  });

  it('masks password values inside a shadow root and a frame', () => {
    const p = makePage('<div id="host"></div>');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input id="pw1" type="password" aria-label="Shadow password" value="hunter2">';
    addFrame(p, '<input type="password" aria-label="Frame password" value="swordfish">');
    // The engine reads the light snapshot (full mode also carries guards with raw values for the legacy driver).
    const json = JSON.stringify(p.evalJson(buildSnapshotCall()));
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('swordfish');
    expect(json).toContain('••••••••');
  });

  it('counts a visible frame it cannot read and ignores small or hidden ones', () => {
    const p = makePage('<button id="top">Top</button>');
    const blocked = addFrame(p, '', { left: 0, top: 0, width: 400, height: 300 });
    Object.defineProperty(blocked, 'contentDocument', { get: () => null });
    const pixel = addFrame(p, '', { left: 0, top: 0, width: 1, height: 1 });
    Object.defineProperty(pixel, 'contentDocument', { get: () => null });
    const snap = p.evalJson(buildSnapshotCall());
    expect(snap.frames_blocked).toBe(1);
    expect(snap.actions.map((a: any) => a.label)).toContain('Top');
  });

  it('does not report frames_blocked when every frame is readable', () => {
    const p = makePage('<button>Top</button>');
    addFrame(p, '<button>Inside</button>');
    expect('frames_blocked' in p.evalJson(buildSnapshotCall())).toBe(false);
  });

  it('ignores closed shadow roots without error', () => {
    const p = makePage('<div id="host"></div><button>Visible</button>');
    p.doc.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML = '<button>Secret</button>';
    const labels = p.evalJson(buildSnapshotCall()).actions.map((a: any) => a.label);
    expect(labels).toContain('Visible');
    expect(labels).not.toContain('Secret');
  });

  it('stops descending after 3 nested shadow levels', () => {
    const p = makePage('<div id="h0"></div>');
    let host = p.doc.getElementById('h0');
    for (let level = 1; level <= 5; level += 1) {
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<button>L${level}</button><div class="next"></div>`;
      host = root.querySelector('.next');
    }
    const labels = p.evalJson(buildSnapshotCall()).actions.map((a: any) => a.label);
    expect(labels).toEqual(expect.arrayContaining(['L1', 'L2', 'L3']));
    expect(labels).not.toContain('L4');
    expect(labels).not.toContain('L5');
  });
});
describe('actions and extract inside shadow roots and frames', () => {
  it('types into a contenteditable inside a frame using the frame document', () => {
    const p = makePage('', { contentEditable: true });
    const frame = addFrame(p, '<div id="ed" contenteditable="true" role="textbox" aria-label="Reply"></div>');
    const idoc = frame.contentDocument;
    const calls: Array<[string, unknown]> = [];
    idoc.getElementById('ed').textContent = 'old text';
    const covered: string[] = [];
    idoc.execCommand = (cmd: string, _ui: boolean, val: unknown) => {
      calls.push([cmd, val]);
      const sel = idoc.defaultView.getSelection();
      const ed = idoc.getElementById('ed');
      covered.push(sel.rangeCount === 1 && ed.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0).toString() : '(elsewhere)');
      ed.textContent = String(val);
      return true;
    };
    Object.defineProperty(idoc.defaultView.HTMLElement.prototype, 'innerText', { configurable: true, get(this: any) { return this.textContent; } });
    Object.defineProperty(idoc.defaultView.HTMLElement.prototype, 'isContentEditable', {
      configurable: true,
      get(this: any) { const v = this.getAttribute('contenteditable'); return v !== null && v !== 'false'; },
    });
    const snap = p.evalJson(buildSnapshotCall());
    const reply = snap.actions.find((a: any) => a.label === 'Reply');
    expect(reply).toBeDefined();
    expect(p.run({ op: 'type', node: reply.node, label: 'Reply', text: 'Thanks!' })).toMatchObject({ ok: true });
    expect(calls).toEqual([['insertText', 'Thanks!']]);
    expect(idoc.getElementById('ed').textContent).toBe('Thanks!');
    expect(covered).toEqual(['old text']); // the frame's own selection covered the editor's existing contents
  });

  it('press Enter goes to the focused control inside a shadow root', () => {
    const p = makePage('<div id="host"></div>');
    const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="in" type="text" aria-label="Search">';
    const input = root.getElementById('in');
    let seen = 0;
    input.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') seen += 1; });
    input.focus();
    expect(p.run({ op: 'press', key: 'Enter' })).toMatchObject({ ok: true });
    expect(seen).toBe(1);
  });

  it('press goes to the focused control inside a same-origin frame', () => {
    const p = makePage('');
    const frame = addFrame(p, '<input id="in" type="text" aria-label="Answer">');
    const input = frame.contentDocument.getElementById('in');
    let seen = 0;
    input.addEventListener('keydown', () => { seen += 1; });
    input.focus();
    frame.focus();
    expect(p.run({ op: 'press', key: 'Escape' })).toMatchObject({ ok: true });
    expect(seen).toBe(1);
  });

  it('extract includes shadow-root and same-origin frame text and still skips passwords', () => {
    const p = makePage('<main><p>Top text</p><div id="host"></div></main>');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow text</p><input type="password" value="hunter2">';
    addFrame(p, '<p>Frame text</p><input type="password" value="swordfish">', undefined, p.doc.querySelector('main'));
    const out = p.evalJson(buildExtractScript(2000));
    expect(out.text).toContain('Top text');
    expect(out.text).toContain('Shadow text');
    expect(out.text).toContain('Frame text');
    expect(out.text).not.toContain('hunter2');
    expect(out.text).not.toContain('swordfish');
  });

  it('extract stops at 3 nested frame levels so a page embedding itself cannot loop', () => {
    const p = makePage('<p>Level0</p>');
    let doc = p.doc;
    for (let level = 1; level <= 5; level += 1) {
      const f = doc.createElement('iframe');
      doc.body.appendChild(f);
      f.contentDocument.body.innerHTML = `<p>Level${level}</p>`;
      doc = f.contentDocument;
    }
    const text = p.evalJson(buildExtractScript(2000)).text as string;
    expect(text).toContain('Level3');
    expect(text).not.toContain('Level4');
  });
});

describe('buildActionScript: hover', () => {
  it('fires over/enter/move on the element and enter on its ancestors, outermost first', () => {
    const p = makePage('<nav id="menu"><a id="item" href="#x">Products</a></nav>');
    const seen: string[] = [];
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      p.doc.getElementById('menu').addEventListener(type, () => seen.push(`menu:${type}`));
      p.doc.getElementById('item').addEventListener(type, () => seen.push(`item:${type}`));
    }
    p.snapshot();
    expect(p.run({ op: 'hover', node: p.node('#item'), label: 'Products' })).toMatchObject({ ok: true });
    expect(seen).toEqual(expect.arrayContaining(['menu:mouseenter', 'item:mouseenter', 'item:mouseover', 'menu:mouseover', 'item:mousemove']));
    expect(seen.indexOf('menu:mouseenter')).toBeLessThan(seen.indexOf('item:mouseenter'));
  });

  it('keeps the label and disabled guards', () => {
    const p = makePage('<button id="b">Save</button><button id="d" disabled>Off</button>');
    p.snapshot();
    expect(p.run({ op: 'hover', node: p.node('#b'), label: 'Other' })).toMatchObject({ ok: false, error: 'changed' });
    expect(p.run({ op: 'hover', node: 99999, label: 'x' })).toMatchObject({ ok: false, error: 'stale' });
  });
});

describe('buildActionScript: press Tab', () => {
  const FIELDS = '<input id="a" aria-label="First"><input id="b" aria-label="Second"><button id="c">Go</button>';

  it('moves focus forward and back and reports the label', () => {
    const p = makePage(FIELDS);
    p.snapshot();
    p.doc.getElementById('a').focus();
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ ok: true, focused: 'Second' });
    expect(p.doc.activeElement.id).toBe('b');
    expect(p.run({ op: 'press', key: 'shift+tab' })).toMatchObject({ ok: true, focused: 'First' });
    expect(p.doc.activeElement.id).toBe('a');
  });

  it('wraps around at both ends and starts at the first control when nothing is focused', () => {
    const p = makePage(FIELDS);
    p.snapshot();
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ focused: 'First' });
    p.doc.getElementById('c').focus();
    expect(p.run({ op: 'press', key: 'TAB' })).toMatchObject({ focused: 'First' });
    p.doc.getElementById('a').focus();
    expect(p.run({ op: 'press', key: 'Shift+Tab' })).toMatchObject({ focused: 'Go' });
  });

  it('skips disabled, hidden-type, tabindex=-1 and aria-hidden controls and honours positive tabindex first', () => {
    const p = makePage(
      '<input id="a" aria-label="A"><input id="off" aria-label="Off" disabled><input type="hidden" id="h"><input id="skip" aria-label="Skip" tabindex="-1"><div aria-hidden="true"><input id="hid" aria-label="Hid"></div><input id="z" aria-label="Z" tabindex="1">',
    );
    p.snapshot();
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ focused: 'Z' });
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ focused: 'A' });
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ focused: 'Z' });
  });

  it('does not move focus when the page cancels keydown', () => {
    const p = makePage(FIELDS);
    p.snapshot();
    p.doc.getElementById('a').focus();
    p.doc.addEventListener('keydown', (e: any) => e.preventDefault());
    const res = p.run({ op: 'press', key: 'Tab' });
    expect(res).toMatchObject({ ok: true });
    expect((res as any).focused).toBeUndefined();
    expect(p.doc.activeElement.id).toBe('a');
  });

  it('works before any snapshot and with no focusable controls', () => {
    const p = makePage(FIELDS);
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ ok: true, focused: 'First' });
    const empty = makePage('<p>nothing here</p>');
    expect(empty.run({ op: 'press', key: 'Tab' })).toMatchObject({ ok: true });
  });

});

describe('buildActionScript: click opened hint', () => {
  function pageWithLink(attrs: string, cancel = false) {
    const p = makePage(`<a id="l" href="#docs" ${attrs}>Docs</a>`);
    if (cancel) p.doc.getElementById('l').addEventListener('click', (e: any) => e.preventDefault());
    p.snapshot();
    return p;
  }

  it('reports opened for target=_blank in any case', () => {
    for (const attrs of ['target="_blank"', 'target="_BLANK"']) {
      const p = pageWithLink(attrs);
      expect(p.run({ op: 'click', node: p.node('#l'), label: 'Docs' })).toMatchObject({ ok: true, opened: true });
    }
  });

  it('omits opened when the page cancels the click (consent dialog, in-page action)', () => {
    const p = pageWithLink('target="_blank"', true);
    const res = p.run({ op: 'click', node: p.node('#l'), label: 'Docs' }) as any;
    expect(res.ok).toBe(true);
    expect(res.opened).toBeUndefined();
  });

  it('omits opened for same-tab links, downloads and plain buttons', () => {
    for (const attrs of ['', 'target="_self"', 'target="_top"', 'target="_blank" download']) {
      const p = pageWithLink(attrs);
      const res = p.run({ op: 'click', node: p.node('#l'), label: 'Docs' }) as any;
      expect(res.ok).toBe(true);
      expect(res.opened).toBeUndefined();
    }
    const b = makePage('<button id="b">Go</button>');
    b.snapshot();
    expect((b.run({ op: 'click', node: b.node('#b'), label: 'Go' }) as any).opened).toBeUndefined();
  });
});

describe('snapshot hardening (review fixes)', () => {
  const light = (p: Page): any => p.evalJson(buildSnapshotCall());

  it('legacy full mode keeps seeing only the top document and never serialises nested secrets', () => {
    const p = makePage('<button>Top</button><div id="host"></div>');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input type="password" aria-label="Shadow pw" value="SHADOWSECRET"><button>Inner</button>';
    addFrame(p, '<input type="password" aria-label="Frame pw" value="FRAMESECRET"><button>Framed</button>');
    const snap = p.snapshot();
    expect(snap.actions.map((a: any) => a.label)).toEqual(expect.arrayContaining(['Top']));
    expect(snap.actions.map((a: any) => a.label)).not.toContain('Inner');
    expect(snap.actions.map((a: any) => a.label)).not.toContain('Framed');
    expect(JSON.stringify(snap)).not.toContain('SHADOWSECRET');
    expect(JSON.stringify(snap)).not.toContain('FRAMESECRET');
  });

  it('names a slotted button from what is assigned to the slot, falling back only when nothing is assigned', () => {
    const p = makePage('<x-btn id="a">Delete account</x-btn><x-btn id="b"></x-btn>');
    for (const id of ['a', 'b']) {
      p.doc.getElementById(id).attachShadow({ mode: 'open' }).innerHTML = '<button><slot>Save</slot></button>';
    }
    const labels = light(p).actions.map((a: any) => a.label);
    expect(labels).toContain('Delete account');
    expect(labels).toContain('Save');
    expect(labels.filter((l: string) => l === 'Save')).toHaveLength(1);
  });

  it('reads text placed directly in a shadow root', () => {
    const p = makePage('<div id="host"></div>');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).append('Your appointment is confirmed');
    expect(light(p).text).toContain('Your appointment is confirmed');
  });

  it('stops scanning after the shared element budget and says the page was not fully read', () => {
    const p = makePage(`${'<i></i>'.repeat(100_010)}<div id="host"></div>`);
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>Beyond budget</button>';
    const snap = light(p);
    expect(snap.actions.map((a: any) => a.label)).not.toContain('Beyond budget');
    expect(snap.scan_truncated).toBe(true);
  }, 60_000);

  it('does not report scan_truncated on an ordinary page', () => {
    const p = makePage('<button>Go</button>');
    expect('scan_truncated' in light(p)).toBe(false);
  });

  it('skips a frame that the outer frame clips away, and its controls', () => {
    const p = makePage('');
    const outer = addFrame(p, '', { left: 0, top: 200, width: 300, height: 200 });
    const inner = outer.contentDocument.createElement('iframe');
    outer.contentDocument.body.appendChild(inner);
    inner.contentDocument.body.innerHTML = '<button>Hidden by clip</button>';
    inner.getBoundingClientRect = () => ({ x: 0, y: 250, left: 0, top: 250, width: 100, height: 100, right: 100, bottom: 350 });
    expect(light(p).actions.map((a: any) => a.label)).not.toContain('Hidden by clip');
  });

  it('counts only unreadable frames that are on screen, and never a hidden one', () => {
    const p = makePage('');
    const offscreen = addFrame(p, '', { left: 0, top: 10_000, width: 400, height: 300 });
    Object.defineProperty(offscreen, 'contentDocument', { get: () => null });
    const hidden = addFrame(p, '', { left: 0, top: 0, width: 400, height: 300 });
    hidden.setAttribute('aria-hidden', 'true');
    Object.defineProperty(hidden, 'contentDocument', { get: () => null });
    expect('frames_blocked' in light(p)).toBe(false);
  });

  it('counts a frame nested deeper than the limit as unreadable', () => {
    const p = makePage('');
    let doc = p.doc;
    for (let level = 1; level <= 4; level += 1) {
      const f = doc.createElement('iframe');
      doc.body.appendChild(f);
      f.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200 });
      f.contentDocument.body.innerHTML = '';
      doc = f.contentDocument;
    }
    expect(light(p).frames_blocked).toBeGreaterThanOrEqual(1);
  });

  it('counts a select as one control against the 250 cap and lists at most 500 of its options, saying how many it left out', () => {
    const options = Array.from({ length: 800 }, (_, i) => `<option value="${i}">Option ${i}</option>`).join('');
    const p = makePage(`<select aria-label="Year">${options}</select><button>After the select</button>`);
    const snap = light(p);
    const labels = snap.actions.map((a: any) => a.label);
    expect(labels).toContain('After the select');
    const listed = snap.actions.filter((a: any) => a.label.startsWith('Year → '));
    expect(listed).toHaveLength(500);
    expect(listed[0].options_omitted).toBe(299);
    expect(snap.omitted_actions).toBe(0);
  });

  it('reports how many controls (not actions) were left out beyond 250', () => {
    const p = makePage(Array.from({ length: 260 }, (_, i) => `<button>B${i}</button>`).join(''));
    expect(light(p).omitted_actions).toBe(10);
  });
});

describe('page scripts across shadow roots and frames (review fixes)', () => {
  it('input events from typing cross the shadow boundary so host listeners see them', () => {
    const p = makePage('<div id="host"></div>');
    const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="in" type="text" aria-label="Card">';
    let seen = 0;
    p.doc.getElementById('host').addEventListener('input', () => { seen += 1; });
    const snap = p.evalJson(buildSnapshotCall());
    const card = snap.actions.find((a: any) => a.label === 'Card');
    expect(p.run({ op: 'type', node: card.node, label: 'Card', text: '4242' })).toMatchObject({ ok: true });
    expect(seen).toBe(1);
  });

  it('events inside a frame are built from the frame window', () => {
    const p = makePage('');
    const frame = addFrame(p, '<input id="in" type="text" aria-label="Answer"><button id="b">Go</button>');
    const win = frame.contentWindow;
    const idoc = frame.contentDocument;
    const seen: Array<{ view: boolean; instance: boolean }> = [];
    idoc.getElementById('in').addEventListener('keydown', (e: any) => {
      seen.push({ view: e.view === win, instance: e instanceof win.KeyboardEvent });
    });
    idoc.getElementById('in').focus();
    frame.focus();
    p.run({ op: 'press', key: 'Escape' });
    expect(seen).toEqual([{ view: true, instance: true }]);
    const clicks: boolean[] = [];
    idoc.getElementById('b').addEventListener('mousedown', (e: any) => clicks.push(e instanceof win.MouseEvent && e.view === win));
    const snap = p.evalJson(buildSnapshotCall());
    const go = snap.actions.find((a: any) => a.label === 'Go');
    p.run({ op: 'click', node: go.node, label: 'Go' });
    expect(clicks).toEqual([true]);
  });

  it('refuses an action when an ancestor outside the shadow root became aria-disabled after the snapshot', () => {
    const p = makePage('<div id="host"></div>');
    const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="b">Delete</button>';
    let clicks = 0;
    root.getElementById('b').addEventListener('click', () => { clicks += 1; });
    const snap = p.evalJson(buildSnapshotCall());
    const del = snap.actions.find((a: any) => a.label === 'Delete');
    p.doc.getElementById('host').setAttribute('aria-disabled', 'true');
    expect(p.run({ op: 'click', node: del.node, label: 'Delete' })).toMatchObject({ ok: false, error: 'unsupported' });
    expect(clicks).toBe(0);
  });

  it('hover reaches document-level delegated mouseover handlers from inside a shadow root', () => {
    const p = makePage('<div id="host"></div>');
    const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<a id="l" href="#x">Products</a>';
    let opened = 0;
    p.doc.addEventListener('mouseover', () => { opened += 1; });
    const snap = p.evalJson(buildSnapshotCall());
    const link = snap.actions.find((a: any) => a.label === 'Products');
    expect(p.run({ op: 'hover', node: link.node, label: 'Products' })).toMatchObject({ ok: true });
    expect(opened).toBe(1);
  });

  describe('Tab', () => {
    it('follows the page order through a shadow host and a frame that sit between two controls', () => {
      const p = makePage('<input aria-label="First"><div id="host"></div><input aria-label="Last">');
      p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Inside shadow">';
      const order: string[] = [];
      p.doc.querySelector('input').focus();
      for (let i = 0; i < 3; i += 1) order.push((p.run({ op: 'press', key: 'Tab' }) as any).focused);
      expect(order).toEqual(['Inside shadow', 'Last', 'First']);
      const back: string[] = [];
      for (let i = 0; i < 2; i += 1) back.push((p.run({ op: 'press', key: 'Shift+Tab' }) as any).focused);
      expect(back).toEqual(['Last', 'Inside shadow']);
    });

    it('moves through a same-origin frame at the frame position', () => {
      const p = makePage('<input aria-label="First">');
      addFrame(p, '<input aria-label="In frame">');
      const last = p.doc.createElement('input');
      last.setAttribute('aria-label', 'Last');
      p.doc.body.appendChild(last);
      p.doc.querySelector('input').focus();
      expect((p.run({ op: 'press', key: 'Tab' }) as any).focused).toBe('In frame');
      expect((p.run({ op: 'press', key: 'Tab' }) as any).focused).toBe('Last');
    });

    it('does not move when a document-level handler cancels Tab from inside a shadow root (focus trap)', () => {
      const p = makePage('<div id="host"></div><input aria-label="Outside">');
      const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<input id="in" aria-label="Trapped">';
      p.doc.addEventListener('keydown', (e: any) => { if (e.key === 'Tab') e.preventDefault(); });
      root.getElementById('in').focus();
      const res = p.run({ op: 'press', key: 'Tab' }) as any;
      expect(res.ok).toBe(true);
      expect(res.focused).toBeUndefined();
      expect(root.activeElement.id).toBe('in');
    });

    it('skips elements that cannot take focus and never reports a control that did not get it', () => {
      const p = makePage('<input aria-label="A"><div tabindex="wat" aria-label="Not focusable"></div><div aria-hidden="true"><input aria-label="Hidden"></div><input aria-label="B">');
      p.doc.querySelector('input').focus();
      expect((p.run({ op: 'press', key: 'Tab' }) as any).focused).toBe('B');
      expect(p.doc.activeElement.getAttribute('aria-label')).toBe('B');
    });

    it('reports nothing when no control can take focus', () => {
      const p = makePage('<div aria-hidden="true"><input aria-label="Hidden"></div>');
      const res = p.run({ op: 'press', key: 'Tab' }) as any;
      expect(res.ok).toBe(true);
      expect(res.focused).toBeUndefined();
    });
  });
});

describe('extract: slots and budget (review fixes)', () => {
  it('shows assigned slot content once and uses fallback content only when nothing is assigned', () => {
    const p = makePage('<main><x-a id="a">Delete account</x-a><x-a id="b"></x-a></main>');
    for (const id of ['a', 'b']) {
      p.doc.getElementById(id).attachShadow({ mode: 'open' }).innerHTML = '<button><slot>Save</slot></button>';
    }
    const text = p.evalJson(buildExtractScript(2000)).text as string;
    expect(text).toBe('Delete account Save');
  });

  it('does not show light children of a shadow host that no slot places', () => {
    const p = makePage('<main><x-a id="a">Never rendered</x-a></main>');
    p.doc.getElementById('a').attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow only</p>';
    expect(p.evalJson(buildExtractScript(2000)).text).toBe('Shadow only');
  });

  it('stops after a fixed number of nodes and marks the result truncated', () => {
    const p = makePage(`<main><p>start</p>${'<i></i>'.repeat(200_050)}<p>end</p></main>`);
    const text = p.evalJson(buildExtractScript(2000)).text as string;
    expect(text.startsWith('start')).toBe(true);
    expect(text.endsWith('\u2026')).toBe(true);
    expect(text).not.toContain('end');
  }, 60_000);
});

describe('snapshot geometry and text (round 2 fixes)', () => {
  const light = (p: Page): any => p.evalJson(buildSnapshotCall());
  const rectAt = (x: number) => () => ({ x, y: 10, left: x, top: 10, width: 20, height: 20, right: x + 20, bottom: 30 });

  it('clips a frame to its content box, inside its border', () => {
    const p = makePage('');
    p.win.CSS = {}; // switch on the geometry checks jsdom normally skips
    const frame = addFrame(p, '<button id="in">Inside</button><button id="out">Outside</button>', { left: 0, top: 0, width: 200, height: 200 });
    for (const [k, v] of Object.entries({ clientLeft: 50, clientTop: 50, clientWidth: 100, clientHeight: 100 })) {
      Object.defineProperty(frame, k, { value: v });
    }
    frame.contentDocument.getElementById('in').getBoundingClientRect = rectAt(10);
    frame.contentDocument.getElementById('out').getBoundingClientRect = rectAt(110);
    const labels = light(p).actions.map((a: any) => a.label);
    expect(labels).toContain('Inside');
    expect(labels).not.toContain('Outside');
  });

  it('does not guess inside a scaled frame: it is reported as unreadable instead', () => {
    const p = makePage('');
    const frame = addFrame(p, '<button>Scaled</button>', { left: 0, top: 0, width: 150, height: 100 });
    Object.defineProperty(frame, 'offsetWidth', { value: 300 });
    const snap = light(p);
    expect(snap.actions.map((a: any) => a.label)).not.toContain('Scaled');
    expect(snap.frames_blocked).toBe(1);
  });

  it('reads text placed directly in a shadow root even when the host has no box, unless the host is hidden', () => {
    const p = makePage('<div id="a"></div><div id="b" aria-hidden="true"></div>');
    for (const id of ['a', 'b']) {
      const host = p.doc.getElementById(id);
      host.checkVisibility = () => false; // a display: contents host has no box
      host.attachShadow({ mode: 'open' }).append(id === 'a' ? 'Shown text' : 'Hidden text');
    }
    const text = light(p).text as string;
    expect(text).toContain('Shown text');
    expect(text).not.toContain('Hidden text');
  });
});

describe('page scripts (round 2 fixes)', () => {
  it('Tab stops on a contenteditable editor between two inputs, but not on one with tabindex -1', () => {
    const p = makePage(
      '<input aria-label="First"><div contenteditable="true" aria-label="Reply"></div><div contenteditable="true" tabindex="-1" aria-label="Skipped"></div><input aria-label="Last">',
      { contentEditable: true },
    );
    p.doc.querySelector('input').focus();
    expect((p.run({ op: 'press', key: 'Tab' }) as any).focused).toBe('Reply');
    expect((p.run({ op: 'press', key: 'Tab' }) as any).focused).toBe('Last');
    expect((p.run({ op: 'press', key: 'Shift+Tab' }) as any).focused).toBe('Reply');
  });

  it('omits opened when a handler cancels the click and stops propagation, also inside a shadow root', () => {
    const cancel = (e: any) => { e.preventDefault(); e.stopPropagation(); };
    const light = makePage('<a id="l" href="#d" target="_blank">Docs</a>');
    light.doc.getElementById('l').addEventListener('click', cancel);
    light.snapshot();
    expect((light.run({ op: 'click', node: light.node('#l'), label: 'Docs' }) as any).opened).toBeUndefined();

    const shadow = makePage('<div id="host"></div>');
    const root = shadow.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<a id="l" href="#d" target="_blank">Docs</a>';
    root.getElementById('l').addEventListener('click', cancel);
    const snap = shadow.evalJson(buildSnapshotCall());
    const docs = snap.actions.find((a: any) => a.label === 'Docs');
    expect(shadow.run({ op: 'click', node: docs.node, label: 'Docs' })).toMatchObject({ ok: true });
    expect((shadow.run({ op: 'click', node: docs.node, label: 'Docs' }) as any).opened).toBeUndefined();
  });

  it('extract skips a slot that is hidden, aria-hidden, inert or display none, but still shows a plain one', () => {
    const p = makePage('<main><x-a id="a">Assigned</x-a></main>');
    const root = p.doc.getElementById('a').attachShadow({ mode: 'open' });
    for (const attrs of ['hidden', 'aria-hidden="true"', 'inert', 'style="display:none"']) {
      root.innerHTML = `<slot ${attrs}>Fallback</slot>`;
      expect(p.evalJson(buildExtractScript(2000)).text).toBe('');
    }
    root.innerHTML = '<slot>Fallback</slot>';
    expect(p.evalJson(buildExtractScript(2000)).text).toBe('Assigned');
  });
});

describe('page scripts and snapshot (round 3 fixes)', () => {
  const light = (p: Page): any => p.evalJson(buildSnapshotCall());

  it('keeps 40 long-labelled dropdowns far below the 16 MiB bridge limit, every dropdown still present', () => {
    const question = 'Q'.repeat(900);
    const options = Array.from({ length: 501 }, (_, i) => `<option value="${i}">Choice ${i}</option>`).join('');
    const p = makePage(Array.from({ length: 40 }, (_, i) => `<select aria-label="${question}${i}">${options}</select>`).join(''));
    const raw = p.win.eval(buildSnapshotCall()) as string;
    expect(raw.length).toBeLessThan(8 * 1024 * 1024);
    const snap = JSON.parse(raw);
    const selects = new Set(snap.actions.filter((a: any) => a.kind === 'select').map((a: any) => a.node));
    expect(selects.size).toBe(40);
    expect(snap.actions.filter((a: any) => a.kind === 'select').length).toBeLessThanOrEqual(3000 + 40);
  }, 60_000);

  it('Tab stops on every standard contenteditable spelling', () => {
    for (const attr of ['contenteditable', 'contenteditable=""', 'contenteditable="plaintext-only"', 'contenteditable="TRUE"']) {
      const p = makePage(`<input aria-label="First"><div ${attr} aria-label="Editor"></div><input aria-label="Last">`, { contentEditable: true });
      p.doc.querySelector('input').focus();
      expect((p.run({ op: 'press', key: 'Tab' }) as any).focused).toBe('Editor');
    }
    const p = makePage('<input aria-label="First"><div contenteditable="false" aria-label="Plain"></div><input aria-label="Last">', { contentEditable: true });
    p.doc.querySelector('input').focus();
    expect((p.run({ op: 'press', key: 'Tab' }) as any).focused).toBe('Last');
  });

  it('Tab does not enter the shadow tree of a host with a negative tabindex', () => {
    const p = makePage('<input aria-label="First"><div id="host" tabindex="-1"></div><input aria-label="Last">');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Inner">';
    p.doc.querySelector('input').focus();
    expect((p.run({ op: 'press', key: 'Tab' }) as any).focused).toBe('Last');
  });

  it('Tab stops iterating a huge sibling list once its node budget is spent', () => {
    const p = makePage('<input aria-label="First">');
    const body = p.doc.body;
    let yielded = 0;
    const real = Object.getOwnPropertyDescriptor(p.win.Node.prototype, 'childNodes')!;
    const big = { [Symbol.iterator]: function* () { for (let i = 0; i < 500_000; i += 1) { yielded += 1; yield p.doc.createComment('x'); } } };
    Object.defineProperty(body, 'childNodes', { configurable: true, get() { return big; } });
    p.doc.querySelector('input').focus();
    p.run({ op: 'press', key: 'Tab' });
    expect(yielded).toBeLessThan(200_000);
    Object.defineProperty(body, 'childNodes', real as any);
  }, 60_000);

  it('a nested click does not hide that the link click was cancelled', () => {
    const p = makePage('<button id="other">Other</button><a id="l" href="#d" target="_blank">Docs</a>');
    p.doc.getElementById('l').addEventListener('click', (e: any) => { e.preventDefault(); p.doc.getElementById('other').click(); });
    p.snapshot();
    expect((p.run({ op: 'click', node: p.node('#l'), label: 'Docs' }) as any).opened).toBeUndefined();
  });

  it('makes no new-tab claim when an early capture handler cancels and stops the click', () => {
    const p = makePage('<a id="l" href="#d" target="_blank">Docs</a>');
    p.win.addEventListener('click', (e: any) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
    p.snapshot();
    expect((p.run({ op: 'click', node: p.node('#l'), label: 'Docs' }) as any).opened).toBeUndefined();
  });

  it('reports a frame under a vertical scale, a rotation or a reflection as unreadable, but reads one under a pure translation', () => {
    const matrixOf = (m: string) => {
      const frames: Record<string, string> = {};
      return { frames, m };
    };
    void matrixOf;
    const cases: Array<[string, boolean]> = [
      ['matrix(1, 0, 0, 0.5, 0, 0)', false],
      ['matrix(-1, 0, 0, -1, 0, 0)', false],
      ['matrix(0, 1, -1, 0, 0, 0)', false],
      ['matrix(1, 0, 0, 1, 40, 20)', true],
    ];
    for (const [transform, readable] of cases) {
      const p = makePage('');
      p.win.DOMMatrixReadOnly = class {
        a: number; b: number; c: number; d: number;
        constructor(s: string) { [this.a, this.b, this.c, this.d] = (s.match(/-?[\d.]+/g) ?? []).map(Number) as [number, number, number, number]; }
      };
      const frame = addFrame(p, '<button>Inner</button>', { left: 0, top: 0, width: 200, height: 200 });
      const original = p.win.getComputedStyle.bind(p.win);
      p.win.getComputedStyle = (el: any) => (el === frame ? { transform, rotate: 'none', scale: 'none' } : original(el));
      const snap = light(p);
      expect(snap.actions.map((a: any) => a.label).includes('Inner')).toBe(readable);
      if (!readable) expect(snap.frames_blocked).toBe(1);
    }
  });

  it('extract reads inside a display: contents host and skips a slot made invisible by CSS visibility', () => {
    const p = makePage('<main><div id="wrapper" style="display:contents">Wrapped text</div><x-a id="a">Assigned</x-a></main>');
    p.doc.getElementById('wrapper').checkVisibility = () => false; // no box of its own
    p.doc.getElementById('a').attachShadow({ mode: 'open' }).innerHTML = '<slot style="visibility:hidden"></slot>';
    expect(p.evalJson(buildExtractScript(2000)).text).toBe('Wrapped text');
  });
});

