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
  // Light mode (window.__rhLight, set by the fast engine): no guards/marker and a page_key
  // of [timeOrigin] only, so no input values (password plaintext included) leave the page.
  // Only light mode reads open shadow roots and same-origin frames: the legacy driver
  // (full mode) keeps seeing exactly the top document it always did.
  const light = window.__rhLight === true;
  const MAX_NEST = 3;
  const MAX_SCAN = 100000;
  const MAX_NESTED_CONTROLS = 2000;
  const MAX_NESTED_TEXT_VISITS = 20000;
  const MAX_CONTROLS = 250;
  const MAX_OPTIONS_PER_SELECT = 500;
  const hostOf = (e) => { const r = e.getRootNode && e.getRootNode(); return r && r.host ? r.host : null; };
  const frameOf = (e) => {
    const view = e.ownerDocument && e.ownerDocument.defaultView;
    try { return view && view !== window ? view.frameElement : null; } catch (err) { return null; }
  };
  const closestDeep = (e, sel) => {
    for (let n = e; n; n = hostOf(n) || frameOf(n)) {
      const hit = typeof n.closest === 'function' ? n.closest(sel) : null;
      if (hit) return hit;
    }
    return null;
  };
  const byId = (e, id) => {
    const r = e.getRootNode && e.getRootNode();
    const scope = r && typeof r.getElementById === 'function' ? r : e.ownerDocument;
    return scope.getElementById(id);
  };
  const visible = (e) => !closestDeep(e, '[aria-hidden="true"],[inert]') &&
    (typeof e.checkVisibility === 'function' ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
  const kidsOf = (e) => {
    if (e.tagName === 'SLOT' && typeof e.assignedNodes === 'function') {
      const assigned = e.assignedNodes({ flatten: true });
      if (assigned.length > 0) return assigned;
    }
    return [...e.childNodes];
  };
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => name(byId(e, id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : kidsOf(e).map((n) => n.nodeType === 3 ? n.textContent :
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
  cache.name = name; cache.role = role; cache.visible = visible;
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
  let blocked = 0;
  let budget = MAX_SCAN;
  let scanTruncated = false;
  let nestedControls = 0;
  const textRoots = [];
  const intersect = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const gather = (root, dx, dy, depth, clip) => {
    for (const e of root.querySelectorAll(selector)) {
      if (depth > 0) {
        if (nestedControls >= MAX_NESTED_CONTROLS) { scanTruncated = true; break; }
        nestedControls++;
      }
      found.push({ e, dx, dy, clip });
    }
    textRoots.push({ root: root.body || root, dx, dy, clip, depth });
    if (!light) return;
    if (budget <= 0) { scanTruncated = true; return; }
    const all = root.querySelectorAll('*');
    const count = Math.min(all.length, budget);
    if (all.length > budget) scanTruncated = true;
    budget -= count;
    for (let i = 0; i < count; i++) {
      const host = all[i];
      if (host.shadowRoot) {
        if (depth < MAX_NEST) gather(host.shadowRoot, dx, dy, depth + 1, clip);
        continue;
      }
      if (host.tagName !== 'IFRAME' && host.tagName !== 'FRAME') continue;
      const r = host.getBoundingClientRect();
      // The child's viewport is the frame's content box (inside its border).
      const cl = host.clientLeft || 0, ct = host.clientTop || 0;
      const cw = host.clientWidth || Math.max(0, r.width - 2 * cl);
      const ch = host.clientHeight || Math.max(0, r.height - 2 * ct);
      const box = intersect(clip, { l: dx + r.left + cl, t: dy + r.top + ct, r: dx + r.left + cl + cw, b: dy + r.top + ct + ch });
      if (box.r <= box.l || box.b <= box.t || !visible(host)) continue;
      // A scaled or rotated frame cannot be mapped by adding offsets: do not guess, report it unreadable.
      const scaled = host.offsetWidth > 0 && Math.abs(r.width - host.offsetWidth) > 1;
      let doc = null;
      if (depth < MAX_NEST && !scaled) {
        try { doc = host.contentDocument; } catch (err) { doc = null; }
      }
      if (doc && doc.body) {
        gather(doc, dx + r.left + cl, dy + r.top + ct, depth + 1, box);
      } else if (r.width >= 50 && r.height >= 50) {
        blocked++;
      }
    }
  };
  const actions = [];
  const found = [];
  gather(document, 0, 0, 0, { l: 0, t: 0, r: innerWidth, b: innerHeight });
  for (const { e, dx, dy, clip } of found) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || closestDeep(e, '[aria-disabled="true"]')) continue;
    const r = typeof e.getBoundingClientRect === 'function' ? e.getBoundingClientRect() : { x: 0, y: 0, width: 10, height: 10 };
    const x = r.x + dx + (r.width || 10) / 2, y = r.y + dy + (r.height || 10) / 2, rname = role(e);
    const isNodeEnv = typeof window.CSS === 'undefined';
    const outside = x < clip.l || y < clip.t || x >= clip.r || y >= clip.b;
    if (!rname || (!isNodeEnv && (r.width <= 0 || r.height <= 0 || outside))) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = { node: identity(e), role: rname, label: name(e) || rname, type: e.type,
      rect: { x: r.x + dx, y: r.y + dy, w: r.width, h: r.height } };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      const eligible = [...e.options].filter((o) => !o.selected && !o.disabled && !o.closest('optgroup[disabled]'));
      const listedOptions = light ? eligible.slice(0, MAX_OPTIONS_PER_SELECT) : eligible;
      const cut = eligible.length - listedOptions.length;
      const current = [...e.selectedOptions].map((opt) => opt.label).join(', ');
      for (const o of listedOptions) {
        actions.push({ ...base, kind: 'select', value: o.value, current_value: current, label: base.label + ' → ' + o.label,
          ...(cut > 0 ? { options_omitted: cut } : {}) });
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
  let length = 0;
  for (const tr of textRoots) {
    if (length >= 6000) break;
    const tdoc = tr.root.ownerDocument || tr.root;
    const walker = tdoc.createTreeWalker(tr.root, NodeFilter.SHOW_TEXT);
    const range = tdoc.createRange();
    let node;
    let visits = 0;
    while ((node = walker.nextNode()) && length < 6000) {
      if (tr.depth > 0 && ++visits > MAX_NESTED_TEXT_VISITS) { scanTruncated = true; break; }
      const value = node.textContent.trim();
      const parent = node.parentElement || (node.parentNode && node.parentNode.host) || null;
      if (!value || !parent || parent.closest('script,style,noscript,template')) continue;
      // Text placed directly in a shadow root has the host as context; the host may have no box of
      // its own (display: contents), so only explicit hiding applies there.
      if (node.parentElement ? !visible(parent) : closestDeep(parent, '[aria-hidden="true"],[inert]')) continue;
      range.selectNodeContents(node);
      const r = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : { width: 10, height: 10, bottom: 10, top: 1, right: 10, left: 1 };
      if (r.width > 0 && r.height > 0 && r.bottom + tr.dy > tr.clip.t && r.top + tr.dy < tr.clip.b && r.right + tr.dx > tr.clip.l && r.left + tr.dx < tr.clip.r) {
        words.push(value);
        length += value.length;
      }
    }
  }
  const text = words.join('\\n').slice(0, 6000);
  const height = document.documentElement.scrollHeight;
  const page_key = light ? [performance.timeOrigin] : cache.pageKey();
  const guards = {};
  let marker;
  if (!light) {
    for (const a of actions) {
      if (!(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));
    }
    const semantics = actions.map(({ rect, ...action }) => action);
    marker = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
      document.title, text, semantics, page_key[6]];
  }
  // Fast engine: the cap counts controls, not select options, so one long dropdown cannot push
  // other controls out of the list. Legacy keeps the original action-count cap.
  let omitted_actions;
  if (light) {
    const listed = new Set();
    const skipped = new Set();
    const kept = [];
    for (const a of actions) {
      if (!listed.has(a.node) && listed.size >= MAX_CONTROLS) { skipped.add(a.node); continue; }
      listed.add(a.node);
      kept.push(a);
    }
    actions.length = 0;
    for (const a of kept) actions.push(a);
    omitted_actions = skipped.size;
  } else {
    omitted_actions = Math.max(0, actions.length - 250);
    actions.splice(250);
  }
  actions.forEach((a, i) => a.id = 'e' + (i + 1));
  if (scrollY + innerHeight < height - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
  if (scrollY > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  const out = { url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
    scroll: { y: scrollY, height }, actions, elements: actions, marker, page_key, guards, omitted_actions };
  if (blocked > 0) out.frames_blocked = blocked;
  if (scanTruncated) out.scan_truncated = true;
  if (light) { delete out.marker; delete out.guards; }
  return out;
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
