import { createHash } from 'node:crypto';
import type { AxNode, AxSnapshot } from './ax-helper.js';

/**
 * Turns the helper's raw accessibility tree into what the model reads: one short line per thing a person
 * would see and could act on, with state, the actions that are not a plain press, and hints for what is
 * scrolled out of view. Pure functions, no I/O.
 */

export interface ViewItem {
  /** `n<id>` for an element, `h<id>` for a scroll hint: what diffs are keyed by. */
  key: string;
  /** The element's id (for a row, the row's). 0 for a hint. */
  id: number;
  /** Friendly role: button, textfield, row … */
  role: string;
  label: string;
  line: string;
  interactive: boolean;
  /** Whether it takes typed text. */
  editable: boolean;
  secure: boolean;
  disabled: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  /** Named actions (AXPress, AXOpen …) and the element that supports each: a row's `AXOpen` lives on its cell. */
  actionTargets: Record<string, number>;
  /** Elements this line stands for (the row and the cells and texts folded into it). */
  members: number[];
}

export interface View {
  header: string;
  lines: string[];
  text: string;
  items: ViewItem[];
  byId: Map<number, ViewItem>;
  fingerprint: string;
  /** Lines left out of `lines` because of the cap or a filter. */
  hidden: number;
  truncated: boolean;
}

export interface ViewOptions {
  max?: number;
  filter?: string;
}

const MAX_LABEL = 80;
const MAX_VALUE = 60;
const MAX_INDENT = 3;
const DEFAULT_MAX_LINES = 150;

const ROLE_NAMES: Record<string, string> = {
  AXButton: 'button',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'radio',
  AXPopUpButton: 'popup',
  AXMenuButton: 'menubutton',
  AXMenuItem: 'menuitem',
  AXMenuBarItem: 'menu',
  AXLink: 'link',
  AXTextField: 'textfield',
  AXTextArea: 'textarea',
  AXSearchField: 'search',
  AXSecureTextField: 'password',
  AXComboBox: 'combobox',
  AXSlider: 'slider',
  AXIncrementor: 'stepper',
  AXStepper: 'stepper',
  AXDisclosureTriangle: 'disclosure',
  AXTab: 'tab',
  AXTabButton: 'tab',
  AXSegmentedControl: 'segmented',
  AXSwitch: 'switch',
  AXToggle: 'toggle',
  AXColorWell: 'colorwell',
  AXDateField: 'datefield',
  AXRow: 'row',
  AXCell: 'row',
  AXStaticText: 'text',
  AXHeading: 'heading',
  AXTable: 'list',
  AXOutline: 'list',
  AXList: 'list',
  AXBrowser: 'list',
  AXToolbar: 'toolbar',
  AXTabGroup: 'tabs',
  AXSheet: 'sheet',
  AXWindow: 'window',
  AXMenu: 'menu',
  AXPopover: 'popover',
  AXDrawer: 'drawer',
  AXGroup: 'group',
  AXProgressIndicator: 'progress',
  AXImage: 'image',
};

const TEXT_FIELD_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXSearchField', 'AXSecureTextField', 'AXComboBox']);

/** Controls whose children are just their own label: never listed separately. */
const LEAF_CONTROLS = new Set([
  'AXButton', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuButton', 'AXMenuItem', 'AXMenuBarItem', 'AXLink',
  'AXDisclosureTriangle', 'AXTab', 'AXTabButton', 'AXSwitch', 'AXToggle', 'AXSlider', 'AXIncrementor', 'AXStepper',
  'AXColorWell', 'AXDateField',
  ...TEXT_FIELD_ROLES,
]);

const ROW_ROLES = new Set(['AXRow', 'AXCell']);
const LIST_ROLES = new Set(['AXTable', 'AXOutline', 'AXList', 'AXBrowser']);
const HEADER_ROLES = new Set(['AXToolbar', 'AXTabGroup', 'AXSheet', 'AXMenu', 'AXPopover', 'AXDrawer']);
const HIDDEN_ROLES = new Set([
  'AXScrollBar', 'AXValueIndicator', 'AXSplitter', 'AXLayoutArea', 'AXLayoutItem', 'AXMatte', 'AXBusyIndicator', 'AXRuler', 'AXGrowArea', 'AXHandle',
]);

const ACTION_NAMES: Record<string, string> = {
  AXOpen: 'open',
  AXShowMenu: 'menu',
  AXIncrement: 'inc',
  AXDecrement: 'dec',
  AXPick: 'pick',
};

const clean = (s: string | undefined, max: number): string => {
  const one = (s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  let end = max - 1;
  const last = one.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${one.slice(0, end)}…`;
};

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function roleName(node: AxNode): string {
  if (node.role === 'AXTextField' && node.sub === 'AXSearchField') return 'search';
  if (node.role === 'AXTextField' && node.sub === 'AXSecureTextField') return 'password';
  return ROLE_NAMES[node.role] ?? (node.role.replace(/^AX/, '').toLowerCase() || 'element');
}

const isSecure = (node: AxNode): boolean => node.role === 'AXSecureTextField' || node.sub === 'AXSecureTextField';

interface Ctx {
  nodes: AxNode[];
  byNode: Map<number, AxNode>;
  kids: Map<number, AxNode[]>;
  items: ViewItem[];
  claimed: Set<number>;
  visited: Set<number>;
}

/** The text a row or control shows: its own label, else the texts and image names inside it. */
function textOf(ctx: Ctx, node: AxNode, depth = 0): string[] {
  const own = clean(node.label, MAX_LABEL);
  if (own) return [own];
  const parts: string[] = [];
  for (const child of ctx.kids.get(node.id) ?? []) {
    if (parts.length >= 4 || depth > 4) break;
    if (child.role === 'AXStaticText' || child.role === 'AXHeading') {
      const t = clean(child.value ?? child.label, MAX_LABEL);
      if (t) parts.push(t);
    } else if (child.role === 'AXImage') {
      const t = clean(child.label, 30);
      // an image named "clock" or "folder" is decoration; it only helps when nothing else is there
      if (t && parts.length === 0 && !(ctx.kids.get(node.id) ?? []).some((c) => c.role === 'AXStaticText' && (c.value ?? c.label))) parts.push(t);
    } else if (!LEAF_CONTROLS.has(child.role) && child.role !== 'AXRow' && !LIST_ROLES.has(child.role)) {
      parts.push(...textOf(ctx, child, depth + 1));
    }
  }
  const unique: string[] = [];
  for (const p of parts) if (unique[unique.length - 1] !== p) unique.push(p);
  return unique.slice(0, 4);
}

function collectMembers(ctx: Ctx, node: AxNode, into: number[], depth = 0): void {
  into.push(node.id);
  if (depth > 5) return;
  for (const child of ctx.kids.get(node.id) ?? []) {
    if (LEAF_CONTROLS.has(child.role) && !ROW_ROLES.has(child.role)) continue;
    if (child.role === 'AXRow') continue;
    if (child.role === 'AXTable' || child.role === 'AXOutline' || child.role === 'AXList') continue;
    collectMembers(ctx, child, into, depth + 1);
  }
}

function actionTargets(ctx: Ctx, node: AxNode, members: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  // the element itself first, then what is folded into it
  for (const id of [node.id, ...members.filter((m) => m !== node.id)]) {
    for (const action of ctx.byNode.get(id)?.actions ?? []) if (!(action in out)) out[action] = id;
  }
  return out;
}

function annotations(node: AxNode, role: string, targets: Record<string, number>): string[] {
  const out: string[] = [];
  const check = node.value;
  if (['checkbox', 'radio', 'switch', 'toggle'].includes(role)) {
    if (check === '1' || check === 'true') out.push('checked');
    else if (check === '2') out.push('mixed');
  }
  if (node.enabled === false) out.push('disabled');
  if (node.selected) out.push('selected');
  if (node.expanded === true) out.push('expanded');
  else if (node.expanded === false && (role === 'disclosure' || role === 'row')) out.push('collapsed');
  if (node.focused && (TEXT_FIELD_ROLES.has(node.role) || role === 'search' || role === 'password')) out.push('focused');
  const names = Object.keys(targets)
    .map((a) => ACTION_NAMES[a])
    .filter((n): n is string => Boolean(n));
  if (names.length > 0) out.push(`{${[...new Set(names)].join(',')}}`);
  return out;
}

function valuePart(node: AxNode, role: string, label: string): string {
  if (isSecure(node)) return node.value || node.value === '' ? ' = "••••"' : '';
  const v = node.value;
  if (v === undefined || v === '') return '';
  if (['checkbox', 'radio', 'switch', 'toggle'].includes(role)) return '';
  if (v === label) return '';
  if (TEXT_FIELD_ROLES.has(node.role) || ['popup', 'combobox', 'slider', 'stepper', 'progress', 'segmented', 'datefield', 'colorwell'].includes(role)) {
    return ` = ${quote(clean(v, MAX_VALUE))}`;
  }
  return '';
}

function emit(ctx: Ctx, indent: number, node: AxNode, opts: { role?: string; label: string; interactive: boolean; members: number[]; text?: boolean }): void {
  const role = opts.role ?? roleName(node);
  const targets = actionTargets(ctx, node, opts.members);
  const notes = annotations(node, role, targets);
  const tail = valuePart(node, role, opts.label);
  const shownLabel = opts.label ? ` ${quote(opts.label)}` : '';
  const pad = '  '.repeat(Math.min(indent, MAX_INDENT));
  const idPart = opts.text ? '' : `[${node.id}] `;
  const line = `${pad}${idPart}${role}${shownLabel}${tail}${notes.length ? ` ${notes.join(' ')}` : ''}`;
  const hasFrame = node.x !== undefined && node.y !== undefined && node.width !== undefined && node.height !== undefined;
  ctx.items.push({
    key: `n${node.id}`,
    id: node.id,
    role,
    label: opts.label,
    line,
    interactive: opts.interactive,
    editable: TEXT_FIELD_ROLES.has(node.role),
    secure: isSecure(node),
    disabled: node.enabled === false,
    ...(hasFrame ? { frame: { x: node.x!, y: node.y!, width: node.width!, height: node.height! } } : {}),
    actionTargets: targets,
    members: opts.members,
  });
  for (const m of opts.members) ctx.claimed.add(m);
}

function hint(ctx: Ctx, indent: number, owner: AxNode): void {
  if (!owner.off || owner.off <= 0) return;
  const s = owner.scroll;
  const where = s === undefined ? 'out of view' : s < 0.02 ? 'below' : s > 0.98 ? 'above' : 'above and below';
  const pad = '  '.repeat(Math.min(indent, MAX_INDENT));
  ctx.items.push({
    key: `h${owner.id}`,
    id: 0,
    role: 'hint',
    label: '',
    line: `${pad}… ${owner.off} more ${where} (desktop_scroll)`,
    interactive: false,
    editable: false,
    secure: false,
    disabled: false,
    actionTargets: {},
    members: [],
  });
}

function visit(ctx: Ctx, node: AxNode, indent: number, inRow: boolean): void {
  const role = node.role;
  if (HIDDEN_ROLES.has(role) || role === 'AXImage') return;
  // Parent links that loop back (a broken tree) must not run forever: each element is shown once.
  if (ctx.visited.has(node.id)) return;
  ctx.visited.add(node.id);

  if (ROW_ROLES.has(role)) {
    const parts = textOf(ctx, node);
    const label = parts.join(' · ');
    const members: number[] = [];
    collectMembers(ctx, node, members);
    if (label || node.selected || Object.keys(actionTargets(ctx, node, members)).length > 0) {
      emit(ctx, indent, node, { label, interactive: true, members });
    }
    // controls inside a row (a button, a checkbox, a field) are still their own lines
    for (const child of ctx.kids.get(node.id) ?? []) visitRowChild(ctx, child, indent + 1);
    return;
  }

  if (role === 'AXStaticText' || role === 'AXHeading') {
    if (inRow) return;
    const t = clean(node.value ?? node.label, 120);
    if (t) emit(ctx, indent, node, { role: role === 'AXHeading' ? 'heading' : 'text', label: t, interactive: false, members: [node.id], text: true });
    return;
  }

  if (LEAF_CONTROLS.has(role)) {
    let label = clean(node.label, MAX_LABEL);
    const members = [node.id];
    if (!label) {
      label = textOf(ctx, node).join(' · ');
      collectMembers(ctx, node, members);
    }
    if (!label && TEXT_FIELD_ROLES.has(role)) label = clean(node.placeholder ?? node.help, MAX_LABEL);
    if (!label) label = clean(node.help, MAX_LABEL);
    emit(ctx, indent, node, { label, interactive: true, members });
    return;
  }

  if (LIST_ROLES.has(role) || HEADER_ROLES.has(role) || (role === 'AXGroup' && clean(node.label, MAX_LABEL))) {
    const label = clean(node.label, MAX_LABEL);
    // A list or toolbar is a heading for what is under it; lists keep an id so they can be scrolled.
    const hasHeader = Boolean(label) || LIST_ROLES.has(role) || role === 'AXSheet' || role === 'AXMenu' || role === 'AXPopover';
    if (hasHeader) emit(ctx, indent, node, { label, interactive: false, members: [node.id] });
    const inner = hasHeader ? indent + 1 : indent;
    for (const child of ctx.kids.get(node.id) ?? []) visit(ctx, child, inner, false);
    hint(ctx, inner, node);
    return;
  }

  if (role === 'AXScrollArea') {
    const from = ctx.items.length;
    for (const child of ctx.kids.get(node.id) ?? []) visit(ctx, child, indent, false);
    // the hint lines up with the rows it is about
    const last = [...ctx.items.slice(from)].reverse().find((i) => i.role !== 'hint');
    const lastIndent = last ? (last.line.length - last.line.trimStart().length) / 2 : indent;
    hint(ctx, last ? lastIndent : indent, node);
    return;
  }

  // window, split groups, unlabelled groups and anything unknown: look through them.
  for (const child of ctx.kids.get(node.id) ?? []) visit(ctx, child, indent, inRow);
  if (role === 'AXWindow') hint(ctx, indent, node);
}

/** Inside a row only controls matter; the row's texts and icons are already in its label. */
function visitRowChild(ctx: Ctx, node: AxNode, indent: number): void {
  if (LEAF_CONTROLS.has(node.role)) {
    visit(ctx, node, indent, true);
    return;
  }
  if (node.role === 'AXRow') return;
  for (const child of ctx.kids.get(node.id) ?? []) visitRowChild(ctx, child, indent);
}

function fingerprintOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function buildView(snapshot: AxSnapshot, opts: ViewOptions = {}): View {
  const nodes = snapshot.nodes;
  const kids = new Map<number, AxNode[]>();
  const known = new Set(nodes.map((n) => n.id));
  const roots: AxNode[] = [];
  const seenIds = new Set<number>();
  for (const node of nodes) {
    // A repeated id is the same element reported twice: keep the first.
    if (seenIds.has(node.id)) continue;
    seenIds.add(node.id);
    if (node.parent !== 0 && node.parent !== node.id && known.has(node.parent)) {
      const list = kids.get(node.parent) ?? [];
      list.push(node);
      kids.set(node.parent, list);
    } else {
      roots.push(node);
    }
  }
  // Members of a parent loop are reachable from no root: promote the first of each loop to a root.
  const reached = new Set<number>();
  const mark = (n: AxNode): void => {
    const stack = [n];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (reached.has(cur.id)) continue;
      reached.add(cur.id);
      for (const k of kids.get(cur.id) ?? []) stack.push(k);
    }
  };
  for (const root of roots) mark(root);
  for (const node of nodes) {
    if (reached.has(node.id) || !seenIds.has(node.id)) continue;
    roots.push(node);
    mark(node);
  }
  const ctx: Ctx = { nodes, byNode: new Map(nodes.map((n) => [n.id, n])), kids, items: [], claimed: new Set(), visited: new Set() };
  for (const root of roots) visit(ctx, root, 0, false);

  // collapse a text line that repeats the one before it
  const items: ViewItem[] = [];
  for (const item of ctx.items) {
    const prev = items[items.length - 1];
    if (!item.interactive && item.role !== 'hint' && prev && prev.line.trim() === item.line.trim()) continue;
    items.push(item);
  }

  const windowTitle = snapshot.window?.title ? ` · window: ${quote(clean(snapshot.window.title, 60))}` : '';
  const header = `app: ${snapshot.app.name || '(frontmost)'}${windowTitle}`;
  const notes: string[] = [];
  if (snapshot.noWindow) notes.push('note: this app has no open window');
  if (snapshot.truncated || snapshot.timedOut) notes.push('note: the window is very large, only part of it was read; use desktop_scroll or a filter');
  if (nodes.length > 0 && items.length === 0) notes.push('(no interactive elements found)');

  const filter = opts.filter?.trim().toLowerCase();
  let shown = items;
  if (filter) shown = items.filter((i) => i.role !== 'hint' && `${i.role} ${i.label} ${i.line}`.toLowerCase().includes(filter));
  let hidden = filter ? items.length - shown.length : 0;
  const max = opts.max ?? DEFAULT_MAX_LINES;
  if (shown.length > max) {
    // Plain text goes first: controls are what the model acts on.
    let keep = shown;
    let excess = shown.length - max;
    keep = shown.filter((i) => {
      if (excess > 0 && !i.interactive && i.role === 'text') {
        excess -= 1;
        return false;
      }
      return true;
    });
    if (keep.length > max) keep = keep.slice(0, max);
    hidden += shown.length - keep.length;
    shown = keep;
  }

  const lines = shown.map((i) => i.line);
  if (filter) {
    if (shown.length === 0) lines.push(`(nothing matches "${clean(opts.filter, 40)}")`);
    else if (hidden > 0) lines.push(`… ${hidden} other elements not shown (filter: ${clean(opts.filter, 40)})`);
  } else if (hidden > 0) {
    lines.push(`… ${hidden} more elements hidden; pass filter to narrow`);
  }
  const body = [...notes, ...lines];
  const text = [header, ...body].join('\n');
  const byId = new Map<number, ViewItem>();
  for (const item of items) if (item.id !== 0 && !byId.has(item.id)) byId.set(item.id, item);
  // Rows fold in their cells and texts: those ids lead to the row.
  for (const item of items) for (const m of item.members) if (!byId.has(m)) byId.set(m, item);
  return {
    header,
    lines: body,
    text,
    items: shown,
    byId,
    fingerprint: fingerprintOf([header, ...items.map((i) => i.line)].join('\n')),
    hidden,
    truncated: snapshot.truncated || snapshot.timedOut,
  };
}

/**
 * What changed between two views of the same window: new lines (+), changed lines (~), gone elements (-).
 * A different app or window, or a change to most of the lines, is shown whole.
 */
export function renderDiff(prev: View | null, next: View): string {
  if (!prev || prev.header !== next.header) return next.text;
  const before = new Map(prev.items.map((i) => [i.key, i]));
  const after = new Set(next.items.map((i) => i.key));
  const out: string[] = [];
  let unchanged = 0;
  let changed = 0;
  for (const item of next.items) {
    const old = before.get(item.key);
    if (!old) {
      out.push(`+ ${item.line.trim()}`);
      changed += 1;
    } else if (old.line !== item.line) {
      out.push(`~ ${item.line.trim()}`);
      changed += 1;
    } else {
      unchanged += 1;
    }
  }
  const gone = prev.items.filter((i) => !after.has(i.key) && i.role !== 'hint');
  for (const item of gone) out.push(`- ${item.id ? `[${item.id}] ` : ''}${item.role}${item.label ? ` ${quote(item.label)}` : ''}`);
  const union = new Set([...before.keys(), ...after]).size;
  if (changed + gone.length > union / 2) return next.text;
  if (out.length === 0) return `${next.header} (same window)\nno visible change`;
  return [`${next.header} (same window)`, ...out, `(${unchanged} unchanged)`].join('\n');
}
