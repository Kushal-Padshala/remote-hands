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
  | { op: 'hover'; node: number; label: string }
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
  | { ok: true; label?: string; navigated?: boolean; value?: string; verified?: boolean; opened?: boolean; focused?: string }
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
  const viewOf = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || window;
  const fire = (el, type, init) => {
    const W = viewOf(el);
    return el.dispatchEvent(new (W.Event || Event)(type, Object.assign({ bubbles: true, composed: type === 'input' }, init || {})));
  };
  const mouse = (el, type, pointer) => {
    const W = viewOf(el);
    const init = { bubbles: true, cancelable: true, composed: true, view: W };
    if (pointer) {
      if (typeof W.PointerEvent === 'function') el.dispatchEvent(new W.PointerEvent(type, init));
      return;
    }
    el.dispatchEvent(new (W.MouseEvent || MouseEvent)(type, init));
  };
  const key = (el, type, k, shift) => {
    const W = viewOf(el);
    const init = { key: k, code: k.length === 1 ? '' : k, shiftKey: shift === true, bubbles: true, cancelable: true, composed: true, view: W };
    if (k === 'Enter') Object.assign(init, { keyCode: 13, which: 13 });
    return el.dispatchEvent(new (W.KeyboardEvent || KeyboardEvent)(type, init));
  };
  const composedClosest = (e, sel) => {
    for (let n = e; n; ) {
      const hit = n.closest ? n.closest(sel) : null;
      if (hit) return hit;
      const r = n.getRootNode && n.getRootNode();
      let next = r && r.host ? r.host : null;
      if (!next) {
        const v = n.ownerDocument && n.ownerDocument.defaultView;
        try { next = v && v !== window ? v.frameElement : null; } catch (err) { next = null; }
      }
      n = next;
    }
    return null;
  };
  const pressKey = (el, k, shift) => {
    const allowed = key(el, 'keydown', k, shift);
    if (k.length === 1 || k === 'Enter') key(el, 'keypress', k, shift);
    key(el, 'keyup', k, shift);
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
  const deepActive = () => {
    let a = document.activeElement || document.body;
    for (let i = 0; i < 8 && a; i++) {
      let next = null;
      if (a.shadowRoot && a.shadowRoot.activeElement) next = a.shadowRoot.activeElement;
      else if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        try { const d = a.contentDocument; if (d && d.activeElement) next = d.activeElement; } catch (e) { next = null; }
      }
      if (!next || next === a) break;
      a = next;
    }
    return a;
  };
  const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,summary,[tabindex],[contenteditable]';
  const visibleNow = (e) => !composedClosest(e, '[aria-hidden="true"],[inert]') &&
    (typeof e.checkVisibility === 'function' ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
  // Focusable controls in the order the page's flat tree presents them: a shadow host's
  // children come from its shadow root (slots expand to what is assigned), a same-origin
  // frame's controls sit at the frame's position. Bounded in depth and in nodes visited.
  const flatFocusables = () => {
    const found = [];
    let visits = 0;
    const LIMIT = 100000;
    const walkAll = (nodes, depth) => {
      for (const c of nodes) {
        if (visits > LIMIT) return;
        walk(c, depth);
      }
    };
    const walk = (node, depth) => {
      if (++visits > LIMIT || node.nodeType !== 1) return;
      if (node.matches(FOCUSABLE)) found.push(node);
      if (node.shadowRoot && depth < 3) {
        // A host with a negative tabindex keeps its whole shadow tree out of the tab order.
        const ti = node.getAttribute('tabindex');
        if (ti !== null && Number(ti) < 0) return;
        walkAll(node.shadowRoot.childNodes, depth + 1);
        return;
      }
      if (node.tagName === 'SLOT' && typeof node.assignedNodes === 'function') {
        const assigned = node.assignedNodes({ flatten: true });
        walkAll(assigned.length > 0 ? assigned : node.childNodes, depth);
        return;
      }
      if ((node.tagName === 'IFRAME' || node.tagName === 'FRAME') && depth < 3) {
        let d = null;
        try { d = node.contentDocument; } catch (err) { d = null; }
        if (d && d.body) walk(d.body, depth + 1);
        return;
      }
      walkAll(node.childNodes, depth);
    };
    walk(document.documentElement || document.body, 0);
    return found;
  };
  // Sequential order value of a control, or null when Tab skips it. An explicit tabindex wins;
  // without one, editing hosts (contenteditable) take focus even though tabIndex reads -1.
  const tabOrder = (e) => {
    const attr = e.getAttribute('tabindex');
    const explicit = attr !== null && attr.trim() !== '' && !Number.isNaN(Number(attr)) ? Math.trunc(Number(attr)) : null;
    if (explicit !== null) return explicit < 0 ? null : explicit;
    if (isEditableHost(e)) return 0;
    return e.tabIndex >= 0 ? e.tabIndex : null;
  };
  const tabbables = () => {
    const ok = [];
    for (const e of flatFocusables()) {
      const order = tabOrder(e);
      if (order === null || e.matches(':disabled') || composedClosest(e, '[aria-disabled="true"]')) continue;
      if (e.tagName === 'INPUT' && e.type === 'hidden') continue;
      if (visibleNow(e)) ok.push({ e, order });
    }
    // Positive values first (page-wide approximation of scoped focus navigation), then the rest in tree order.
    const positive = ok.filter((x) => x.order > 0).sort((a, b) => a.order - b.order);
    return positive.concat(ok.filter((x) => x.order === 0)).map((x) => x.e);
  };
  // Moves focus to the next (or previous) control that actually accepts it and returns that
  // control; a candidate the browser refuses is skipped. Null when focus could not move.
  const moveFocus = (from, backwards) => {
    const list = tabbables();
    const n = list.length;
    if (n === 0) return null;
    const i = list.indexOf(from);
    for (let k = 1; k <= n; k++) {
      const idx = i < 0 ? (backwards ? n - k : k - 1) : (backwards ? ((i - k) % n + n) % n : (i + k) % n);
      const candidate = list[idx];
      try { candidate.focus(); } catch (err) { continue; }
      if (deepActive() === candidate) return candidate;
    }
    return null;
  };
`;

// Identity guard: the document must be the one that was snapshotted (when the caller says which).
// Every op first clears a leftover navigation flag (downloads, mailto: links, 204 responses and
// cancelled navigations fire beforeunload without leaving the page).
const GUARD = String.raw`
  window.__rhNavPending = 0;
  if (op.origin !== undefined && op.origin !== null && typeof performance !== 'undefined' &&
      String(performance.timeOrigin) !== String(op.origin)) {
    return fail('stale', { message: 'page changed since the snapshot' });
  }
`;

// Marks a pending navigation (beforeunload/pagehide) with a timestamp so the engine does not
// mistake the old document for the result. Installed once per document; GUARD clears the flag
// before each action and the ready probe ignores a flag older than NAV_PENDING_MS.
const NAV_HOOK = String.raw`
  if (!window.__rhNavHooked && typeof window.addEventListener === 'function') {
    const markNav = () => { window.__rhNavPending = Date.now(); };
    window.addEventListener('beforeunload', markNav);
    window.addEventListener('pagehide', markNav);
    window.__rhNavHooked = true;
  }
`;

/** A navigation flag older than this is treated as stale (the navigation never happened). */
export const NAV_PENDING_MS = 1500; // shorter than the engine's 3 s settle cap

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
    !!composedClosest(el, '[aria-disabled="true"]');
  if (disabled) return fail('unsupported', { message: 'element is disabled' });
`;

const CLICK = String.raw`
  const link = el.closest ? el.closest('a[href],area[href]') : null;
  let opened = !!link && String(link.getAttribute('target') || '').toLowerCase() === '_blank' && !link.hasAttribute('download');
  reveal(el);
  mouse(el, 'pointerdown', true);
  mouse(el, 'mousedown', false);
  mouse(el, 'pointerup', true);
  mouse(el, 'mouseup', false);
  // Keep the click event itself (a capture listener on the window sees it first) and read its
  // final state afterwards: a page handler that cancelled it, even with stopPropagation, means
  // the link opens nothing.
  const view = viewOf(el);
  let clickEvent = null;
  // Only the event that targets this element counts: a handler may click something else first.
  const record = (ev) => {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
    if (!clickEvent && path.includes(el)) clickEvent = ev;
  };
  view.addEventListener('click', record, true);
  try { el.click(); } finally { view.removeEventListener('click', record, true); }
  // If the event could not be observed, or the page cancelled it, make no claim about a new tab.
  if (!clickEvent || clickEvent.defaultPrevented) opened = false;
  const result = { ok: true, label: current, navigated: false };
  if (opened) result.opened = true;
  return out(result);
`;

const HOVER = String.raw`
  if (typeof el.scrollIntoView === 'function') {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  }
  const emit = (target, type, pointer, bubbles) => {
    const W = viewOf(target);
    const init = { bubbles: bubbles, cancelable: true, composed: bubbles, view: W };
    if (pointer) {
      if (typeof W.PointerEvent === 'function') target.dispatchEvent(new W.PointerEvent(type, init));
      return;
    }
    target.dispatchEvent(new (W.MouseEvent || MouseEvent)(type, init));
  };
  const chain = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) chain.unshift(n);
  for (const n of chain) {
    emit(n, 'pointerenter', true, false);
    emit(n, 'mouseenter', false, false);
  }
  emit(el, 'pointerover', true, true);
  emit(el, 'mouseover', false, true);
  emit(el, 'pointermove', true, true);
  emit(el, 'mousemove', false, true);
  return out({ ok: true, label: current });
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
    const ownDoc = el.ownerDocument || document;
    const ownView = ownDoc.defaultView || window;
    let inserted = false;
    if (typeof ownDoc.execCommand === 'function') {
      try {
        const sel = ownView.getSelection && ownView.getSelection();
        if (sel && ownDoc.createRange) {
          const range = ownDoc.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        inserted = ownDoc.execCommand('insertText', false, text) === true;
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
  const lower = String(op.key).toLowerCase();
  const backwards = lower === 'shift+tab';
  const k = backwards || lower === 'tab' ? 'Tab' : String(op.key);
  const target = deepActive();
  const allowed = pressKey(target, k, backwards);
  if (k === 'Enter' && allowed && target.tagName === 'INPUT' && target.form) submitForm(target.form);
  if (k === 'Tab' && allowed) {
    const next = moveFocus(target, backwards);
    if (next) {
      const c = window.__rhFast || window.__jevFast;
      const plain = next.getAttribute('aria-label') || next.getAttribute('title') || next.getAttribute('placeholder') || next.textContent || '';
      const label = String((c && c.name ? c.name(next) : '') || plain || next.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 80);
      return out({ ok: true, focused: label });
    }
  }
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
  hover: GUARD + RESOLVE + HOVER,
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
    (typeof e.checkVisibility === 'function' && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      // an element with display: contents has no box but its children are rendered normally
      !(typeof getComputedStyle === 'function' && getComputedStyle(e).display === 'contents'));
  // A boxless wrapper that is visibility: hidden hides its own text; descendants decide for themselves.
  const quietKids = (e) => {
    // only an element without a box can be display: contents; skip the style read for the rest
    if (typeof getComputedStyle !== 'function' || typeof e.checkVisibility !== 'function' ||
        e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const cs = getComputedStyle(e);
    return cs.display === 'contents' && (cs.visibility === 'hidden' || cs.visibility === 'collapse');
  };
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
  let visits = 0;
  const walk = (n, depth, quiet) => {
    if (truncated) return;
    if (++visits > 200000) { truncated = true; return; }
    if (n.nodeType === 3) { if (!quiet) add(n.textContent || ''); return; }
    if (n.nodeType !== 1 || SKIP.includes(n.tagName)) return;
    if (n.tagName === 'SLOT' && typeof n.assignedNodes === 'function') {
      // A slot has no box of its own, so checkVisibility cannot judge it; explicit hiding still applies.
      if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert')) return;
      if (typeof getComputedStyle === 'function') {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return;
      }
      const assigned = n.assignedNodes({ flatten: true });
      for (const c of (assigned.length > 0 ? assigned : n.childNodes)) { if (truncated) return; walk(c, depth, quiet); }
      return;
    }
    if (hidden(n)) return;
    if (n.tagName === 'INPUT') {
      const type = String(n.type || 'text').toLowerCase();
      if (VALUE_TYPES.includes(type) && n.value) add(n.value);
      return;
    }
    if (n.tagName === 'TEXTAREA') { if (n.value) add(n.value); return; }
    const kidsQuiet = quietKids(n);
    if (n.shadowRoot && depth < 3) {
      // The shadow tree is what is rendered; light children only appear where a slot places them.
      for (const c of n.shadowRoot.childNodes) { if (truncated) return; walk(c, depth + 1, kidsQuiet); }
      return;
    }
    if ((n.tagName === 'IFRAME' || n.tagName === 'FRAME') && depth < 3) {
      let d = null;
      try { d = n.contentDocument; } catch (e) { d = null; }
      if (d && d.body) walk(d.body, depth + 1, false);
    }
    for (const c of n.childNodes) { if (truncated) return; walk(c, depth, kidsQuiet); }
  };
  if (root) walk(root, 0, false);
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
 * DOM_SNAPSHOT_SCRIPT in light mode (no guards/marker, page_key = [timeOrigin], so no input
 * values such as password plaintext leave the page), with the keys the engine does not use
 * dropped (rect, guards, marker and the duplicate `elements` list). The flag is restored so
 * a legacy-driver snapshot of the same page stays full. Evaluates to the snapshot or null.
 */
const LIGHT_SNAPSHOT = `(() => {
    const hadLight = Object.prototype.hasOwnProperty.call(window, '__rhLight');
    const prevLight = window.__rhLight;
    window.__rhLight = true;
    let r;
    try {
      r = ${DOM_SNAPSHOT_SCRIPT};
    } finally {
      if (hadLight) window.__rhLight = prevLight; else delete window.__rhLight;
    }
    if (!r || typeof r !== 'object') return r === undefined ? null : r;
    delete r.guards;
    delete r.marker;
    delete r.elements;
    if (Array.isArray(r.actions)) for (const a of r.actions) if (a && typeof a === 'object') delete a.rect;
    return r;
  })()`;

/**
 * Wraps the light snapshot so it evaluates to a JSON string: the snapshot, `null` when the
 * page has no body, or `{"error":"snapshot failed: <message>"}` when it throws. Callers must
 * treat a result with an `error` key as a failed snapshot.
 */
export function buildSnapshotCall(): string {
  return `(() => {
  try {
    const r = ${LIGHT_SNAPSHOT};
    return JSON.stringify(r);
  } catch (e) {
    return JSON.stringify({ error: 'snapshot failed: ' + String((e && e.message) || e).slice(0, 300) });
  }
})()`;
}

/**
 * Cheap probe as a JSON string: url, readyState, title, document origin (timeOrigin), and
 * navigation pending (`p`: the unload flag was set less than NAV_PENDING_MS ago).
 */
export function buildReadyProbe(): string {
  return `JSON.stringify(${probeObject()})`;
}

function probeObject(): string {
  return `{ u: location.href, r: document.readyState, t: document.title, o: typeof performance !== 'undefined' ? performance.timeOrigin : null, p: typeof window.__rhNavPending === 'number' && window.__rhNavPending > 0 && Date.now() - window.__rhNavPending < ${NAV_PENDING_MS} }`;
}

/**
 * Snapshot and readiness probe in ONE evaluation: `{"snap": <snapshot | null | {error}>,
 * "probe": {u,r,t,o,p}}`. The probe is read after the snapshot so it describes the same
 * document the snapshot came from (a navigation starting in between shows as `p`/`o`).
 */
export function buildSnapshotWithProbe(): string {
  return `(() => {
  let snap;
  try {
    snap = ${LIGHT_SNAPSHOT};
  } catch (e) {
    snap = { error: 'snapshot failed: ' + String((e && e.message) || e).slice(0, 300) };
  }
  return JSON.stringify({ snap: snap, probe: ${probeObject()} });
})()`;
}

/**
 * Navigates the tab to `url` (embedded safely); evaluates to `{"ok":true,"o":<timeOrigin>}`
 * where `o` identifies the document that was navigated away from.
 */
export function buildNavigateScript(url: string): string {
  return `(() => { const o = typeof performance !== 'undefined' ? performance.timeOrigin : null; location.href = ${embed(url)}; return JSON.stringify({ ok: true, o: o }); })()`;
}
