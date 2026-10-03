import { DOM_SNAPSHOT_SCRIPT } from '../browser-snapshot.js';

/**
 * Page-side runtime for the fast browser engine. Every builder returns the source of an
 * expression that evaluates to a JSON STRING (the AppleScript transport returns text), and
 * every caller-supplied value is embedded through `embed()` so the script is safe as a
 * single argv argument and inside any JS evaluation context.
 */

export type PageOp = (
  | { op: 'click'; node: number; label: string }
  | { op: 'type'; node: number; label: string; text: string; submit?: boolean }
  | { op: 'select'; node: number; label: string; value: string }
  | { op: 'check'; node: number; label: string; checked: boolean }
  | { op: 'press'; key: string }
  | { op: 'scroll'; delta: number }
) & {
  /** `performance.timeOrigin` from the snapshot: a different document makes the op `stale`. */
  origin?: number | string;
};

export type PageOpError = 'no_snapshot' | 'stale' | 'changed' | 'unsupported' | 'no_option' | 'failed';

export type PageOpResult =
  /**
   * `verified: false` means the action ran but its effect could not be confirmed in-page
   * (async-rendering widgets); the engine confirms by re-snapshotting.
   */
  | { ok: true; label?: string; navigated?: boolean; value?: string; verified?: boolean }
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

// Identity guard: the document must be the one that was snapshotted (when the caller says which).
const GUARD = String.raw`
  if (op.origin !== undefined && op.origin !== null && typeof performance !== 'undefined' &&
      String(performance.timeOrigin) !== String(op.origin)) {
    return fail('stale', { message: 'page changed since the snapshot' });
  }
`;

// Marks a pending navigation (beforeunload/pagehide) so the engine does not mistake the old
// document for the result. Installed once per document; the flag is cleared before each action.
const NAV_HOOK = String.raw`
  if (!window.__rhNavHooked && typeof window.addEventListener === 'function') {
    const markNav = () => { window.__rhNavPending = true; };
    window.addEventListener('beforeunload', markNav);
    window.addEventListener('pagehide', markNav);
    window.__rhNavHooked = true;
  }
  window.__rhNavPending = false;
`;

// Resolves `el` and verifies the label; runs for every op that targets a node.
const RESOLVE = String.raw`
  const cache = window.__rhFast || window.__jevFast;
  if (!cache || !cache.nodes) return fail('no_snapshot');
  const el = cache.nodes.get(op.node);
  if (!el || !el.isConnected) return fail('stale');
  const labelOf = () => String((cache.name ? cache.name(el) : '') || (cache.role ? cache.role(el) : '') || '').trim();
  const current = labelOf();
  if (op.label) {
    // Accept the labels the snapshot emits for this node: the plain label, the extra
    // 'Open <label>' click action of editable fields, and '<label> → <option>' for selects.
    const want = String(op.label).trim();
    const sameNode = want === current || want === 'Open ' + current || want.startsWith(current + ' → ');
    if (!sameNode) return fail('changed', { current: current });
  }
  if (cache.visible && !cache.visible(el)) return fail('stale');
  const disabled = (typeof el.matches === 'function' && el.matches(':disabled')) ||
    !!(el.closest && el.closest('[aria-disabled="true"]'));
  if (disabled) return fail('unsupported', { message: 'element is disabled' });
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
  if (isField && el.readOnly) return fail('unsupported', { message: 'element is read-only' });
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
      if (el.value !== expected) {
        // Report what the page kept (masking handlers etc.), but never a password value.
        const extra = { message: 'value did not stick' };
        if (inputType !== 'password') extra.current = String(el.value).slice(0, 200);
        return fail('failed', extra);
      }
    } else if (tag === 'INPUT' && text !== '' && String(el.value) === '') {
      return fail('failed', { message: 'value rejected by the ' + inputType + ' input' });
    }
  } else {
    // contenteditable: prefer execCommand (keeps the editor's undo stack and fires a real
    // input event); fall back to textContent only when it is missing, throws or returns false.
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
    if (!inserted) {
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
  // A multiple select adds the matching option and leaves the existing selection alone
  // (one op selects one option); a single select replaces the selection.
  if (el.multiple) match.selected = true;
  else el.selectedIndex = match.index;
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
    if (state() !== want) {
      // Native inputs update synchronously, so an unchanged state is a real failure. ARIA
      // widgets may re-render asynchronously: report unverified and let the engine re-snapshot.
      if (native) return fail('failed', { message: 'checked state did not change' });
      return out({ ok: true, label: current, verified: false });
    }
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

const BODIES: Record<PageOp["op"], string> = {
  click: GUARD + RESOLVE + NAV_HOOK + CLICK,
  type: GUARD + RESOLVE + NAV_HOOK + TYPE,
  select: GUARD + RESOLVE + SELECT,
  check: GUARD + RESOLVE + CHECK,
  press: GUARD + NAV_HOOK + PRESS,
  scroll: GUARD + SCROLL,
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
  const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SELECT', 'OPTION', 'OPTGROUP', 'DATALIST'];
  const VALUE_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number'];
  const hidden = (e) => e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('inert') ||
    (typeof e.checkVisibility === 'function' && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const textLen = (e) => (e.textContent || '').length;
  const candidates = Array.from(document.querySelectorAll('main,[role="main"],article')).filter((e) => !hidden(e));
  let root = null;
  for (const c of candidates) if (!root || textLen(c) > textLen(root)) root = c;
  root = root || document.body || document.documentElement;
  // Count the COLLAPSED length while walking so whitespace-heavy markup cannot make the walk
  // stop early with a short, unmarked result.
  let text = '';
  let full = false;
  let truncated = false;
  const add = (raw) => {
    if (full) { truncated = true; return; }
    const t = String(raw).replace(/\\s+/g, ' ').trim();
    if (!t) return;
    text = text ? text + ' ' + t : t;
    if (text.length >= max) full = true;
  };
  const walk = (n) => {
    if (truncated) return;
    if (n.nodeType === 3) { add(n.textContent || ''); return; }
    if (n.nodeType !== 1 || SKIP.includes(n.tagName) || hidden(n)) return;
    if (n.tagName === 'INPUT') {
      const type = String(n.type || 'text').toLowerCase();
      if (VALUE_TYPES.includes(type) && n.value) add(n.value);
      return;
    }
    if (n.tagName === 'TEXTAREA') { if (n.value) add(n.value); return; }
    for (const c of n.childNodes) walk(c);
  };
  if (root) walk(root);
  if (truncated || text.length > max) {
    // Cut at max without splitting a surrogate pair.
    let end = Math.min(max, text.length);
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    text = text.slice(0, end).trimEnd() + '\\u2026';
  }
  return JSON.stringify({ title: document.title, url: location.href, text: text });
})()`;
}

/**
 * Wraps DOM_SNAPSHOT_SCRIPT so it evaluates to a JSON string: the snapshot, `null` when the
 * page has no body, or `{"error":"snapshot failed: <message>"}` when it throws. Callers must
 * treat a result with an `error` key as a failed snapshot.
 */
export function buildSnapshotCall(): string {
  return `(() => {
  try {
    const r = ${DOM_SNAPSHOT_SCRIPT};
    return JSON.stringify(r === undefined ? null : r);
  } catch (e) {
    return JSON.stringify({ error: 'snapshot failed: ' + String((e && e.message) || e).slice(0, 300) });
  }
})()`;
}

/** Cheap probe as a JSON string: url, readyState, title, document origin (timeOrigin), navigation pending. */
export function buildReadyProbe(): string {
  return `JSON.stringify({ u: location.href, r: document.readyState, t: document.title, o: typeof performance !== 'undefined' ? performance.timeOrigin : null, p: !!window.__rhNavPending })`;
}

/**
 * Navigates the tab to `url` (embedded safely); evaluates to `{"ok":true,"o":<timeOrigin>}`
 * where `o` identifies the document that was navigated away from.
 */
export function buildNavigateScript(url: string): string {
  return `(() => { const o = typeof performance !== 'undefined' ? performance.timeOrigin : null; location.href = ${embed(url)}; return JSON.stringify({ ok: true, o: o }); })()`;
}
