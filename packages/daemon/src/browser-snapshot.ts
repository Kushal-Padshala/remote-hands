export interface IndexedElement {
  index: number;
  id: number | string;
  node?: number | undefined;
  kind?: string | undefined;
  role: string;
  label: string;
  tag: string;
  type?: string | undefined;
  value?: string | undefined;
  current_value?: string | undefined;
  checked?: boolean | string | undefined;
  disabled?: boolean | undefined;
  rect?: { x: number; y: number; w: number; h: number } | undefined;
}

export interface SnapshotResult {
  url: string;
  title: string;
  elements: IndexedElement[];
  formattedTable: string;
  text?: string | undefined;
  actions?: IndexedElement[] | undefined;
}

export const DOM_SNAPSHOT_SCRIPT = `(() => {
  if (!document.body) return null;
  const cache = (window.__jevFast = window.__rhFast = window.__jevFast || window.__rhFast || { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) {
    if (!e.isConnected) cache.nodes.delete(id);
  }
  const safe = (e) => !['file', 'hidden'].includes(e.type);
  const visible = (e) => !e.closest('[aria-hidden="true"],[inert]') &&
    (typeof e.checkVisibility === 'function' ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((role) => '[role="' + role + '"]').join(',');
  const role = (e) => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel', 'password'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])];
  cache.guard = (e) => {
    if (!e || !e.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null,
      e.readOnly ?? null, e.matches(':disabled'), e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected'),
      e.getAttribute('href'), scope?.innerText?.slice(0, 6000) || ''];
  };
  const actions = [];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = typeof e.getBoundingClientRect === 'function' ? e.getBoundingClientRect() : { x: 0, y: 0, width: 10, height: 10 };
    const x = r.x + (r.width || 10) / 2, y = r.y + (r.height || 10) / 2, rname = role(e);
    const isNodeEnv = typeof window.CSS === 'undefined';
    if (!rname || (!isNodeEnv && (r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight))) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = { node: identity(e), role: rname, label: name(e) || rname, type: e.type,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      for (const o of e.options) {
        if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]')) {
          actions.push({ ...base, kind: 'select', value: o.value,
            current_value: [...e.selectedOptions].map((opt) => opt.label).join(', '), label: base.label + ' → ' + o.label });
        }
      }
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
          (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const value = e.type === 'password' ? '••••••••' :
        ('value' in e ? String(e.value) : (e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : ''));
      actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
      if (editable) actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
    }
  }
  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  let length = 0;
  while ((node = walker.nextNode()) && length < 6000) {
    const value = node.textContent.trim();
    const parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node);
    const r = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : { width: 10, height: 10, bottom: 10, top: 1, right: 10, left: 1 };
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
      words.push(value);
      length += value.length;
    }
  }
  const text = words.join('\\n').slice(0, 6000);
  const height = document.documentElement.scrollHeight;
  const page_key = cache.pageKey();
  const guards = {};
  for (const a of actions) {
    if (!(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));
  }
  const semantics = actions.map(({ rect, ...action }) => action);
  const marker = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    document.title, text, semantics, page_key[6]];
  const omitted_actions = Math.max(0, actions.length - 250);
  actions.splice(250);
  actions.forEach((a, i) => a.id = 'e' + (i + 1));
  if (scrollY + innerHeight < height - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
  if (scrollY > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  return { url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
    scroll: { y: scrollY, height }, actions, elements: actions, marker, page_key, guards, omitted_actions };
})()`;

export function formatIndexedElements(elements: IndexedElement[], text?: string): string {
  if (!elements || elements.length === 0) {
    return 'No interactive elements found.';
  }
  const rows: string[] = [];
  if (text && text.trim()) {
    rows.push('--- Page Text ---');
    rows.push(text.trim());
    rows.push('--- Interactive Elements ---');
  }
  for (const el of elements) {
    const idDisplay = typeof el.id === 'string' && el.id.startsWith('e') ? el.id : el.index;
    const indexStr = `[${idDisplay}]`;
    const roleStr = el.role.padEnd(8, ' ');
    const labelStr = el.label || '(unlabeled)';
    let extra = '';
    if (el.value !== undefined && el.value !== '') {
      extra += ` · value="${el.value}"`;
    }
    if (el.checked !== undefined && el.checked !== false && el.checked !== 'false') {
      extra += ' [checked]';
    }
    if (el.disabled) {
      extra += ' [disabled]';
    }
    rows.push(`${indexStr} ${roleStr} ${labelStr}${extra}`);
  }
  return rows.join('\n');
}

export function parseSnapshotOutput(raw: unknown): SnapshotResult {
  if (!raw || typeof raw !== 'object') {
    return {
      url: '',
      title: '',
      elements: [],
      formattedTable: 'No interactive elements found.',
    };
  }

  const obj = raw as Record<string, unknown>;
  const url = typeof obj.url === 'string' ? obj.url : '';
  const title = typeof obj.title === 'string' ? obj.title : '';
  const text = typeof obj.text === 'string' ? obj.text : undefined;
  const rawList = Array.isArray(obj.actions)
    ? obj.actions
    : Array.isArray(obj.elements)
      ? obj.elements
      : [];

  const elements: IndexedElement[] = rawList.map((e, idx) => {
    const item = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const rawId = item.id;
    let numericIndex = idx + 1;
    if (typeof rawId === 'string' && /^e\d+$/i.test(rawId)) {
      numericIndex = parseInt(rawId.slice(1), 10);
    } else if (typeof item.index === 'number') {
      numericIndex = item.index;
    } else if (typeof rawId === 'number') {
      numericIndex = rawId;
    }
    const finalId: string | number = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : numericIndex;

    return {
      index: numericIndex,
      id: finalId,
      node: typeof item.node === 'number' ? item.node : undefined,
      kind: typeof item.kind === 'string' ? item.kind : undefined,
      role: typeof item.role === 'string' ? item.role : 'element',
      label: typeof item.label === 'string' ? item.label : '',
      tag: typeof item.tag === 'string' ? item.tag : (typeof item.role === 'string' ? item.role : 'element'),
      type: typeof item.type === 'string' ? item.type : undefined,
      value: typeof item.value === 'string' ? item.value : undefined,
      current_value: typeof item.current_value === 'string' ? item.current_value : undefined,
      checked: typeof item.checked === 'boolean' || typeof item.checked === 'string' ? item.checked : undefined,
      disabled: Boolean(item.disabled),
      rect: item.rect && typeof item.rect === 'object'
        ? (item.rect as { x: number; y: number; w: number; h: number })
        : undefined,
    };
  });

  return {
    url,
    title,
    text,
    elements,
    actions: elements,
    formattedTable: formatIndexedElements(elements, text),
  };
}
