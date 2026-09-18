export interface IndexedElement {
  index: number;
  id: number;
  role: string;
  label: string;
  tag: string;
  type?: string | undefined;
  value?: string | undefined;
  checked?: boolean | undefined;
  disabled?: boolean | undefined;
}

export interface SnapshotResult {
  url: string;
  title: string;
  elements: IndexedElement[];
  formattedTable: string;
}

export const DOM_SNAPSHOT_SCRIPT = `
(() => {
  if (!document.body) return { url: location.href, title: document.title, elements: [] };
  const cache = (window.__rhFast = window.__rhFast || { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identify = (el) => {
    if (!cache.ids.has(el)) cache.ids.set(el, cache.next++);
    const id = cache.ids.get(el);
    cache.nodes.set(id, el);
    return id;
  };
  for (const [id, node] of cache.nodes) {
    if (!node.isConnected) cache.nodes.delete(id);
  }

  const isVisible = (el) => {
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return true;
    return !style || style.display !== 'none';
  };

  const getAccessibleName = (el, seen = new Set()) => {
    if (!el || seen.has(el)) return '';
    seen.add(el);
    const labelledby = (el.getAttribute('aria-labelledby') || '').trim();
    if (labelledby) {
      const names = labelledby.split(/\\s+/).map(id => {
        const ref = document.getElementById(id);
        return ref ? getAccessibleName(ref, seen) : '';
      }).filter(Boolean);
      if (names.length) return names.join(' ');
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    if (el.labels && el.labels.length > 0) {
      const labelText = Array.from(el.labels).map(l => getAccessibleName(l, seen)).filter(Boolean).join(' ');
      if (labelText) return labelText;
    }
    if (['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value.trim();
    if (el.alt) return el.alt.trim();
    if (el.title) return el.title.trim();
    if (el.placeholder) return el.placeholder.trim();
    if (el.tagName !== 'INPUT') {
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) return text.slice(0, 100);
    }
    return '';
  };

  const interactiveRoles = [
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
    'combobox', 'textbox', 'searchbox', 'spinbutton', 'option'
  ];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    interactiveRoles.map(r => '[role="' + r + '"]').join(',');

  const determineRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit && interactiveRoles.includes(explicit)) return explicit;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A') return 'link';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(type)) return type;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return 'element';
  };

  const elements = [];
  let indexCounter = 1;
  const nodes = Array.from(document.querySelectorAll(selector));

  for (const node of nodes) {
    if (node.type === 'hidden' || node.type === 'password' && node.disabled) continue;
    if (!isVisible(node)) continue;
    const id = identify(node);
    const role = determineRole(node);
    const label = getAccessibleName(node);
    const isPassword = node.type === 'password';
    let safeValue = isPassword ? (node.value ? '••••••••' : undefined) : (node.value !== undefined ? String(node.value) : undefined);
    if (safeValue && safeValue.length > 50 && !isPassword) {
      safeValue = safeValue.slice(0, 47) + '...';
    }
    const item = {
      index: indexCounter++,
      id,
      role,
      label,
      tag: node.tagName,
      type: node.type || undefined,
      value: safeValue,
      checked: node.checked !== undefined ? Boolean(node.checked) : undefined,
      disabled: Boolean(node.disabled),
    };
    elements.push(item);
  }

  return {
    url: location.href,
    title: document.title,
    elements,
  };
})()
`;

export function formatIndexedElements(elements: IndexedElement[]): string {
  if (!elements || elements.length === 0) {
    return 'No interactive elements found.';
  }
  const rows: string[] = [];
  for (const el of elements) {
    const indexStr = `[${el.index}]`;
    const roleStr = el.role.padEnd(8, ' ');
    const labelStr = el.label || '(unlabeled)';
    let extra = '';
    if (el.value !== undefined && el.value !== '') {
      extra += ` · value="${el.value}"`;
    }
    if (el.checked !== undefined) {
      extra += el.checked ? ' [checked]' : ' [unchecked]';
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
  const elementsRaw = Array.isArray(obj.elements) ? obj.elements : [];

  const elements: IndexedElement[] = elementsRaw.map((e, idx) => {
    const item = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    return {
      index: typeof item.index === 'number' ? item.index : idx + 1,
      id: typeof item.id === 'number' ? item.id : idx + 1,
      role: typeof item.role === 'string' ? item.role : 'element',
      label: typeof item.label === 'string' ? item.label : '',
      tag: typeof item.tag === 'string' ? item.tag : '',
      type: typeof item.type === 'string' ? item.type : undefined,
      value: typeof item.value === 'string' ? item.value : undefined,
      checked: typeof item.checked === 'boolean' ? item.checked : undefined,
      disabled: typeof item.disabled === 'boolean' ? item.disabled : undefined,
    };
  });

  return {
    url,
    title,
    elements,
    formattedTable: formatIndexedElements(elements),
  };
}
