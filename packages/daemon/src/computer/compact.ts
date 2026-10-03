import type { IndexedElement } from '../desktop/ax-walker.js';

const NOISE_ROLES = new Set([
  'AXStaticText',
  'AXGroup',
  'AXUnknown',
  'AXImage',
  'AXScrollArea',
  'AXSplitGroup',
  'AXLayoutArea',
  'AXLayoutItem',
]);

const MAX_LABEL = 60;

export function compactDesktopElements(
  elements: IndexedElement[],
  opts: { max?: number; filter?: string } = {},
): string {
  const max = opts.max ?? 80;
  const filter = opts.filter?.trim().toLowerCase();
  const lines: string[] = [];
  let previous = '';
  for (const element of elements) {
    const label = element.label.replace(/\s+/g, ' ').trim();
    if (!label && NOISE_ROLES.has(element.role)) continue;
    const role = element.role.replace(/^AX/, '');
    if (filter && !`${role} ${label}`.toLowerCase().includes(filter)) continue;
    const shown = label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
    const line = `[${element.index}] ${role} "${shown}"`;
    const identity = `${role}|${shown}`;
    if (identity === previous) continue;
    previous = identity;
    lines.push(line);
  }
  if (lines.length === 0) return '(no interactive elements found)';
  if (lines.length > max) {
    const hidden = lines.length - max;
    return [...lines.slice(0, max), `… ${hidden} more elements hidden; pass filter to narrow`].join('\n');
  }
  return lines.join('\n');
}

export function capLines(text: string, max: number): string {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), `… ${lines.length - max} more lines hidden`].join('\n');
}
