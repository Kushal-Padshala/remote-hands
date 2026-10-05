import { renderDelta, renderFull, type PageElement, type PageState } from '../../../browser/render.js';
import type { DoStep } from '../../../browser/port.js';
import type { PilotBrowser } from '../env.js';

/**
 * A fake website the pilot can be tested against without a browser. Pages are real `PageState`
 * objects rendered by the production renderer, so the pilot sees exactly the text the engine emits.
 */
export interface SimSite {
  state(): PageState;
  click(id: number): void;
  type(id: number, text: string, submit?: boolean): void;
  check(id: number, checked: boolean): void;
  select(id: number, value: string): void;
}

export interface SimLogEntry {
  op: string;
  id?: number;
  label?: string;
  text?: string;
}

export const link = (id: number, label: string): PageElement => ({ id, node: id, role: 'link', label, kind: 'click' });
export const button = (id: number, label: string): PageElement => ({ id, node: id, role: 'button', label, kind: 'click' });
export const radio = (id: number, label: string, checked = false): PageElement => ({ id, node: id, role: 'radio', label, kind: 'click', ...(checked ? { checked: true } : {}) });
export const checkbox = (id: number, label: string, checked = false): PageElement => ({ id, node: id, role: 'checkbox', label, kind: 'click', ...(checked ? { checked: true } : {}) });
export const textbox = (id: number, label: string, value = ''): PageElement => ({ id, node: id, role: 'textbox', label, kind: 'fill', value });
export const select = (id: number, label: string, options: string[], value = ''): PageElement => ({ id, node: id, role: 'select', label, kind: 'select', value, options });
export const heading = (id: number, label: string): PageElement => ({ id, node: id, role: 'heading', label, kind: 'text' });

export function page(title: string, text: string, elements: PageElement[]): PageState {
  return {
    url: `https://sim.test/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    text,
    elements: elements.map((e) => ({ ...e })),
    browser: 'Google Chrome',
  };
}

/**
 * Stands in for ComputerSession's browser methods. Mirrors the engine: element ids must exist on
 * the last page shown, clicks go through an optional approval gate, and every response is a delta
 * against the previous page, as text.
 */
export class SimBrowser implements PilotBrowser {
  readonly log: SimLogEntry[] = [];
  private shown: PageState | null = null;

  constructor(
    private readonly site: SimSite,
    private readonly gate?: (label: string) => void,
  ) {}

  async browserSnapshot(opts?: { text?: boolean }): Promise<string> {
    const state = this.site.state();
    this.shown = { ...state, elements: state.elements.map((e) => ({ ...e })) };
    return renderFull(state, { text: opts?.text === true });
  }

  async browserDo(steps: DoStep[]): Promise<string> {
    if (this.shown === null) await this.browserSnapshot();
    const before = this.shown!;
    const done: string[] = [];
    for (const [i, step] of steps.entries()) {
      const n = i + 1;
      const fail = (message: string): never => {
        throw new Error(`step ${n} ${step.op} failed: ${message} (${n === 1 ? 'no steps ok' : `steps 1-${n - 1} ok`})`);
      };
      if (step.op === 'wait' || step.op === 'scroll' || step.op === 'press') {
        this.log.push({ op: step.op });
        done.push(step.op);
        continue;
      }
      const element = before.elements.find((e) => e.id === step.index);
      if (step.index === undefined || element === undefined) fail(`element [${step.index}] is not on the page. Call browser_snapshot.`);
      const id = step.index!;
      const label = element!.label;
      if (step.op === 'click') {
        try {
          this.gate?.(label);
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        this.log.push({ op: 'click', id, label });
        this.site.click(id);
      } else if (step.op === 'type') {
        this.log.push({ op: 'type', id, label, text: step.text ?? '' });
        this.site.type(id, step.text ?? '', step.submit);
      } else if (step.op === 'check') {
        this.log.push({ op: 'check', id, label });
        this.site.check(id, step.checked === true);
      } else if (step.op === 'select') {
        this.log.push({ op: 'select', id, label, text: step.value ?? '' });
        this.site.select(id, step.value ?? '');
      }
      done.push(step.op);
    }
    const next = this.site.state();
    const out = `did: ${done.join(', ')}\n${renderDelta(before, next, { text: false })}`;
    this.shown = { ...next, elements: next.elements.map((e) => ({ ...e })) };
    return out;
  }
}
