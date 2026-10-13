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

/**
 * Resolves a visible label to one element of the shown page: an exact label match first, then
 * a substring match, among elements that fit the op. Zero or several matches fail with the
 * candidates so the caller can pick an index; nothing is ever guessed.
 */
export function resolveTarget(state: PageState, op: TargetOp, target: string): TargetResult {
  const want = norm(target);
  if (!want) return { ok: false, reason: 'target is empty' };
  const pool = state.elements.filter((e): e is PageElement & { node: number } => fits(op, e));
  const pick = (matches: Array<PageElement & { node: number }>): TargetResult | null => {
    if (matches.length === 1) return { ok: true, el: matches[0]! };
    if (matches.length > 1) {
      return { ok: false, reason: `target "${clean(target, 80)}" is ambiguous (matches ${listed(matches)}); use index` };
    }
    return null;
  };
  const exact = pick(pool.filter((e) => norm(e.label) === want));
  if (exact) return exact;
  const partial = pick(pool.filter((e) => norm(e.label).includes(want)));
  if (partial) return partial;
  const near = findElements({ ...state, elements: pool }, target, SHOWN_CANDIDATES);
  const hint = near.length > 0 ? `; closest: ${listed(near)}` : '';
  return { ok: false, reason: `no ${NOUN[op]} matches target "${clean(target, 80)}"${hint}` };
}