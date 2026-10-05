import { clean } from '../../browser/render.js';
import type { PilotView, UiElement } from './types.js';

export type PilotCandidate =
  | { kind: 'click'; elementId: string }
  | { kind: 'check'; elementId: string }
  | { kind: 'fill'; elementId: string }
  | { kind: 'pick'; elementId: string }
  | { kind: 'scroll'; delta: number }
  | { kind: 'done' }
  | { kind: 'handoff' };

export interface PilotOption {
  id: string;
  text: string;
  action: PilotCandidate;
}

export interface OptionContext {
  goal: string;
  brief?: string | undefined;
  /** Values the pilot may type, by name (from the request, slots or the brain's brief). */
  facts: Record<string, string>;
  history: ReadonlyArray<{ op: string; elementId?: string | undefined }>;
  maxOptions?: number | undefined;
}

const DONE_TEXT = 'The goal is already complete.';
const HANDOFF_TEXT = 'I am not sure what to do next; ask for help.';

const FILL_ROLES = new Set(['textbox', 'searchbox', 'textarea', 'combobox', 'spinbutton', 'input']);
const CHECK_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
const INERT_ROLES = new Set(['heading', 'text', 'image', 'img', 'paragraph', 'separator', 'status', 'group', 'wait']);
const FORWARD = /^(next|continue|submit|start|begin|search|save|done|finish|ok|okay|confirm|sign in|log in|login|apply|go|get started|proceed)\b/i;

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
}

function overlap(label: string[], wanted: string[]): number {
  let n = 0;
  for (const w of label) if (wanted.some((x) => overlaps(w, x))) n++;
  return n;
}

function labelText(el: UiElement): string {
  const label = clean(el.label);
  return label === '' ? '(no label)' : `"${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

interface Scored {
  option: Omit<PilotOption, 'id'>;
  score: number;
  index: number;
}

/**
 * The closed list of next actions the model may choose from: a shortlist of the page's controls
 * plus two fixed options, `done` and `handoff`. At most `maxOptions` (default 12) in total.
 */
export function buildOptions(view: PilotView, ctx: OptionContext): PilotOption[] {
  const max = Math.max(2, ctx.maxOptions ?? 12);
  const wanted = words(`${ctx.goal} ${ctx.brief ?? ''} ${Object.keys(ctx.facts).join(' ')}`);
  const factValues = new Set(Object.values(ctx.facts));
  const hasFacts = Object.keys(ctx.facts).length > 0;
  const recent = ctx.history.slice(-6);
  const used = (id: string) => recent.filter((h) => h.elementId === id).length;

  // A group of radios is a run of consecutive radio elements. Once one is chosen the rest are not
  // offered: choosing another would change the answer, and a model that keeps trying to is stuck.
  const answeredRadio = new Set<number>();
  let run: number[] = [];
  const closeRun = () => {
    if (run.some((i) => view.elements[i]!.checked === true)) for (const i of run) answeredRadio.add(i);
    run = [];
  };
  view.elements.forEach((e, i) => {
    if (e.role === 'radio') run.push(i);
    else closeRun();
  });
  closeRun();

  const scored: Scored[] = [];
  view.elements.forEach((el, index) => {
    if (INERT_ROLES.has(el.role)) return;
    if (answeredRadio.has(index)) return;
    const tokens = words(el.label);
    let score = overlap(tokens, wanted) * 10 - index * 0.001;
    const uses = used(el.id);
    if (uses >= 2) score -= 20;
    else if (uses === 1) score -= 2;

    if (el.pseudo) {
      if (el.id === 'scroll_down' || el.id === 'scroll_up') {
        scored.push({ option: { text: el.id === 'scroll_down' ? 'scroll down' : 'scroll up', action: { kind: 'scroll', delta: el.id === 'scroll_down' ? 560 : -560 } }, score: score - 1, index });
      }
      return;
    }

    const base = `[${el.id}] ${el.role} ${labelText(el)}`;
    if (FILL_ROLES.has(el.role)) {
      if (!hasFacts) return;
      if (el.value !== undefined && el.value !== '' && factValues.has(el.value)) return; // already filled
      const current = el.value === undefined || el.value === '' ? '(empty)' : `(currently "${clean(el.value)}")`;
      scored.push({ option: { text: `fill ${base} ${current}`, action: { kind: 'fill', elementId: el.id } }, score: score + 5, index });
    } else if (el.role === 'select') {
      const current = el.value === undefined || el.value === '' ? '(nothing chosen)' : `(currently "${clean(el.value)}")`;
      scored.push({ option: { text: `pick ${base} ${current}`, action: { kind: 'pick', elementId: el.id } }, score: score + 1, index });
    } else if (CHECK_ROLES.has(el.role)) {
      if (el.checked === true) return;
      const verb = el.role === 'radio' ? 'select' : 'tick';
      scored.push({ option: { text: `${verb} ${base}`, action: { kind: 'check', elementId: el.id } }, score, index });
    } else {
      if (FORWARD.test(clean(el.label))) score += 6;
      scored.push({ option: { text: `click ${base}`, action: { kind: 'click', elementId: el.id } }, score, index });
    }
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = scored.slice(0, max - 2).map((s) => s.option);
  chosen.push({ text: DONE_TEXT, action: { kind: 'done' } }, { text: HANDOFF_TEXT, action: { kind: 'handoff' } });
  return chosen.map((option, i) => ({ id: `o${i}`, ...option }));
}
