import { clean, findElements, type PageElement, type PageState } from './render.js';

export type TargetOp = 'click' | 'type' | 'select' | 'check' | 'hover';

export type TargetResult = { ok: true; el: PageElement & { node: number } } | { ok: false; reason: string };

const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'switch']);
const SHOWN_CANDIDATES = 5;

function fits(op: TargetOp, el: PageElement): el is PageElement & { node: number } {
  if (typeof el.node !== 'number') return false;
  switch (op) {
    case 'type':
      return el.kind === 'fill';
    case 'select':
      return el.kind === 'select';
    case 'check':
      return CHECKABLE_ROLES.has(el.role) || el.checked !== undefined;
    default:
      return true;
  }
}

const norm = (s: string): string => clean(s, 500).toLowerCase();

const NOUN: Record<TargetOp, string> = {
  click: 'element',
  hover: 'element',
  type: 'text field',
  select: 'dropdown',
  check: 'checkbox or switch',
};

function listed(list: PageElement[]): string {
  const shown = list.slice(0, SHOWN_CANDIDATES).map((e) => `[${e.id}] ${e.role} "${clean(e.label, 60)}"`);
  const more = list.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

const BOUNDARY = /[\p{L}\p{N}\p{M}]/u;

/** `label` starts with `want` and the match ends at a word boundary ("email" in "email address", not "emailing"). */
function startsWithWord(label: string, want: string): boolean {
  if (!label.startsWith(want)) return false;
  const next = label.codePointAt(want.length);
  return next === undefined || !BOUNDARY.test(String.fromCodePoint(next));
}

/**
 * Resolves a visible label to one element of the shown page. An exact label match wins; failing
 * that, a unique label that starts with the target at a word boundary. Zero or several matches,
 * an exact match of the wrong kind (a button called "Email" when typing), or a page the snapshot
 * could not list completely all fail with the candidates, so nothing is ever guessed.
 */
export function resolveTarget(state: PageState, op: TargetOp, target: string): TargetResult {
  const want = norm(target);
  if (!want) return { ok: false, reason: 'target is empty' };
  if (state.omitted || state.scanTruncated) {
    const missing = state.omitted ? ` (${state.omitted} not listed)` : '';
    return {
      ok: false,
      reason: `the page has more controls than could be listed${missing}, so a label cannot be proven unique; use browser_find to get an index`,
    };
  }
  const real = state.elements.filter((e): e is PageElement & { node: number } => typeof e.node === 'number');
  const pool = real.filter((e) => fits(op, e));
  const pick = (matches: Array<PageElement & { node: number }>): TargetResult | null => {
    if (matches.length === 1) return { ok: true, el: matches[0]! };
    if (matches.length > 1) {
      return { ok: false, reason: `target "${clean(target, 80)}" is ambiguous (matches ${listed(matches)}); use index` };
    }
    return null;
  };
  const exactAll = real.filter((e) => norm(e.label) === want);
  const exact = pick(exactAll.filter((e) => fits(op, e)));
  if (exact) return exact;
  if (exactAll.length > 0) {
    return {
      ok: false,
      reason: `target "${clean(target, 80)}" is not a ${NOUN[op]} here (it matches ${listed(exactAll)}); use index`,
    };
  }
  const prefix = pick(pool.filter((e) => startsWithWord(norm(e.label), want)));
  if (prefix) return prefix;
  const near = findElements({ ...state, elements: pool }, target, SHOWN_CANDIDATES);
  const hint = near.length > 0 ? `; closest: ${listed(near)}` : '';
  return { ok: false, reason: `no ${NOUN[op]} matches target "${clean(target, 80)}"${hint}` };
}
