import { DOM_SNAPSHOT_SCRIPT } from '../browser-snapshot.js';

/**
 * Page-side runtime for the fast browser engine. Every builder returns the source of an
 * expression that evaluates to a JSON STRING (the AppleScript transport returns text), and
 * every caller-supplied value is embedded through `embed()` so the script is safe as a
 * single argv argument and inside any JS evaluation context.
 */

export type PageOp =
  | { op: 'click'; node: number; label: string }
  | { op: 'type'; node: number; label: string; text: string; submit?: boolean }
  | { op: 'select'; node: number; label: string; value: string }
  | { op: 'check'; node: number; label: string; checked: boolean }
  | { op: 'press'; key: string }
  | { op: 'scroll'; delta: number };

export type PageOpError = 'no_snapshot' | 'stale' | 'changed' | 'unsupported' | 'no_option' | 'failed';

export type PageOpResult =
  | { ok: true; label?: string; navigated?: boolean; value?: string }
  | { ok: false; error: PageOpError; current?: string; message?: string };

/**
 * JSON-encode a value as a JS literal, escaping U+2028/U+2029 and `<` so the emitted
 * source never contains raw line separators or a `</script` sequence.
 */
const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');

export function embed(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029")
    .replace(/</g, '\\u003c');
}

// Shared helpers for action scripts. Plain JS (no template-literal interpolation inside).
const PRELUDE = String.raw`
  const out = (r) => JSON.stringify(r);
  const fail = (error, extra) => out(Object.assign({ ok: false, error: error }, extra || {}));
  const fire = (el, type, init) => el.dispatchEvent(new Event(type, Object.assign({ bubbles: true }, init || {})));
  const mouse = (el, type, pointer) => {
    const init = { bubbles: true, cancelable: true, view: window };
    if (pointer) {
      if (typeof window.PointerEvent === 'function') el.dispatchEvent(new PointerEvent(type, init));
      return;
    }
    el.dispatchEvent(new MouseEvent(type, init));
  };
  const key = (el, type, k) => {
    const init = { key: k, code: k.length === 1 ? '' : k, bubbles: true, cancelable: true, view: window };
    if (k === 'Enter') Object.assign(init, { keyCode: 13, which: 13 });
    return el.dispatchEvent(new KeyboardEvent(type, init));
  };
  const pressKey = (el, k) => {
    const allowed = key(el, 'keydown', k);
    if (k.length === 1 || k === 'Enter') key(el, 'keypress', k);
    key(el, 'keyup', k);
    return allowed;
  };
  const submitForm = (form) => {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else if (typeof form.submit === 'function') form.submit();
  };
  const reveal = (el) => {
    if (typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    }
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (e) {}
    }
  };
  const isEditableHost = (el) => {
    if (el.isContentEditable === true) return true;
    const ce = el.getAttribute && el.getAttribute('contenteditable');
    return ce !== null && ce !== undefined && ce !== 'false';
  };
  const TEXT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password'];
  const NON_TYPABLE = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color'];
`;

// Resolves `el` and verifies the label; runs for every op that targets a node.
const RESOLVE = String.raw`
  const cache = window.__rhFast || window.__jevFast;
  if (!cache || !cache.nodes) return fail('no_snapshot');
  const el = cache.nodes.get(op.node);
  if (!el || !el.isConnected) return fail('stale');
  const labelOf = () => String((cache.name ? cache.name(el) : '') || (cache.role ? cache.role(el) : '') || '').trim();
  const current = labelOf();
  if (op.label && String(op.label).trim() !== current) return fail('changed', { current: current });
`;

const CLICK = String.raw`
  reveal(el);
  mouse(el, 'pointerdown', true);
  mouse(el, 'mousedown', false);
  mouse(el, 'pointerup', true);
  mouse(el, 'mouseup', false);
  el.click();
  return out({ ok: true, label: current, navigated: false });
`;

const TYPE = String.raw`
  const tag = el.tagName;
  const inputType = tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
  const isField = tag === 'TEXTAREA' || (tag === 'INPUT' && !NON_TYPABLE.includes(inputType));
  if (!isField && !isEditableHost(el)) return fail('unsupported', { message: 'element is not editable' });
  if (isField && (el.disabled || el.readOnly)) return fail('unsupported', { message: 'element is disabled or read-only' });
  const text = String(op.text);
  reveal(el);
  if (isField) {
    let proto = Object.getPrototypeOf(el);
    let desc = null;
    while (proto && !desc) {
      desc = Object.getOwnPropertyDescriptor(proto, 'value') || null;
      proto = Object.getPrototypeOf(proto);
    }
    if (desc && typeof desc.set === 'function') desc.set.call(el, text);
    else el.value = text;
    fire(el, 'input');
    fire(el, 'change');
    const isText = tag === 'TEXTAREA' || TEXT_TYPES.includes(inputType);
    if (isText) {
      let expected = text;
      if (tag === 'INPUT') expected = expected.replace(/[\r\n]/g, '');
      if (inputType === 'email' || inputType === 'url') expected = expected.trim();
      if (el.value !== expected) return fail('failed', { message: 'value did not stick' });
    }
  } else {
    let inserted = false;
    if (typeof document.execCommand === 'function') {
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && document.createRange) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        inserted = document.execCommand('insertText', false, text) === true;
      } catch (e) { inserted = false; }
    }
    if (!inserted || el.textContent !== text) {
      el.textContent = text;
      fire(el, 'input');
    }
  }
  if (op.submit) {
    const allowed = pressKey(el, 'Enter');
    if (allowed && tag === 'INPUT' && el.form) submitForm(el.form);
  }
  const result = { ok: true, label: current };
  if (isField && !TEXT_TYPES.includes(inputType) && tag === 'INPUT') result.value = String(el.value);
  return out(result);
`;

const SELECT = String.raw`
  if (el.tagName !== 'SELECT') return fail('unsupported', { message: 'element is not a <select>' });
  const want = String(op.value).trim().toLowerCase();
  const opts = Array.from(el.options).filter((o) => !o.disabled && !(o.closest && o.closest('optgroup[disabled]')));
  const texts = (o) => [String(o.value), String(o.label || '').trim(), String(o.text || '').trim()].map((s) => s.toLowerCase());
  let match = opts.find((o) => texts(o).includes(want));
  if (!match && want) match = opts.find((o) => texts(o).some((s) => s.startsWith(want)));
  if (!match) {
    const names = opts.slice(0, 10).map((o) => String(o.label || o.text || o.value).trim());
    return fail('no_option', { message: 'no option matching "' + String(op.value) + '"; available: ' + names.join(', ') });
  }
  reveal(el);
  el.selectedIndex = match.index;
  fire(el, 'input');
  fire(el, 'change');
  return out({ ok: true, label: current });
`;

const CHECK = String.raw`
  const native = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
  const aria = el.getAttribute('aria-checked');
  if (!native && aria === null) return fail('unsupported', { message: 'element is not checkable' });
  const state = () => native ? el.checked === true : el.getAttribute('aria-checked') === 'true';
  const want = op.checked === true;
  if (state() !== want) {
    reveal(el);
    el.click();
    if (state() !== want) return fail('failed', { message: 'checked state did not change' });
  }
  return out({ ok: true, label: current });
`;

const PRESS = String.raw`
  const k = String(op.key);
  const target = document.activeElement || document.body;
  const allowed = pressKey(target, k);
  if (k === 'Enter' && allowed && target.tagName === 'INPUT' && target.form) submitForm(target.form);
  return out({ ok: true });
`;

const SCROLL = String.raw`
  const delta = Number(op.delta) || 0;
  if (typeof window.scrollBy === 'function') window.scrollBy({ top: delta, behavior: 'instant' });
  return out({ ok: true });
`;

const BODIES: Record<PageOp['op'], string> = {
  click: RESOLVE + CLICK,
  type: RESOLVE + TYPE,
  select: RESOLVE + SELECT,
  check: RESOLVE + CHECK,
  press: PRESS,
  scroll: SCROLL,
};

/** Builds an IIFE that performs `op` on the snapshotted page and evaluates to a JSON string. */
export function buildActionScript(op: PageOp): string {
  const body = BODIES[op.op];
  return `(() => {${PRELUDE}
  const op = ${embed(op)};
  try {${body}
  } catch (e) {
    return fail('failed', { message: String((e && e.message) || e).slice(0, 300) });
  }
})()`;
}

/**
 * Builds an IIFE returning `JSON.stringify({ title, url, text })`: whitespace-collapsed
 * visible text of the largest `main`/`[role=main]`/`article` (else `body`), skipping
 * script/style/noscript/template and never including password input values.
 */
export function buildExtractScript(maxChars: number): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 20000;
  return `(() => {
  const max = ${embed(limit)};
  const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'];
  const VALUE_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number'];
  const hidden = (e) => e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('inert') ||
    (typeof e.checkVisibility === 'function' && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const textLen = (e) => (e.textContent || '').length;
  const candidates = Array.from(document.querySelectorAll('main,[role="main"],article')).filter((e) => !hidden(e));
  let root = null;
  for (const c of candidates) if (!root || textLen(c) > textLen(root)) root = c;
  root = root || document.body || document.documentElement;
  const parts = [];
  let size = 0;
  const walk = (n) => {
    if (size > max + 200) return;
    if (n.nodeType === 3) {
      const t = n.textContent || '';
      if (t.trim()) { parts.push(t); size += t.length; }
      return;
    }
    if (n.nodeType !== 1 || SKIP.includes(n.tagName) || hidden(n)) return;
    if (n.tagName === 'INPUT') {
      const type = String(n.type || 'text').toLowerCase();
      if (VALUE_TYPES.includes(type) && n.value) { parts.push(String(n.value)); size += String(n.value).length; }
      return;
    }
    if (n.tagName === 'TEXTAREA') {
      if (n.value) { parts.push(String(n.value)); size += String(n.value).length; }
      return;
    }
    for (const c of n.childNodes) walk(c);
  };
  if (root) walk(root);
  let text = parts.join(' ').replace(/\\s+/g, ' ').trim();
  if (text.length > max) text = text.slice(0, max) + '\\u2026';
  return JSON.stringify({ title: document.title, url: location.href, text: text });
})()`;
}

/** Wraps DOM_SNAPSHOT_SCRIPT so it evaluates to a JSON string (`null` when there is no body). */
export function buildSnapshotCall(): string {
  return `(() => {
  const r = ${DOM_SNAPSHOT_SCRIPT};
  return JSON.stringify(r === undefined ? null : r);
})()`;
}

/** Cheap probe of url, readyState and title as a JSON string. */
export function buildReadyProbe(): string {
  return `JSON.stringify({ u: location.href, r: document.readyState, t: document.title })`;
}
