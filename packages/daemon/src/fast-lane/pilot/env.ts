import type { DoStep } from '../../browser/port.js';
import { parseRendered } from './parse.js';
import type { PilotAction, PilotEnv, PilotView } from './types.js';

/** The slice of `ComputerSession` the pilot needs; the real session satisfies it as is. */
export interface PilotBrowser {
  browserSnapshot(opts?: { text?: boolean }): Promise<string>;
  browserDo(steps: DoStep[]): Promise<string>;
}

function index(id: string): number {
  if (!/^\d+$/.test(id)) throw new Error(`invalid element id "${id}"`);
  return Number(id);
}

function toStep(action: PilotAction): DoStep {
  switch (action.op) {
    case 'click':
      return { op: 'click', index: index(action.id) };
    case 'type':
      return action.submit === undefined
        ? { op: 'type', index: index(action.id), text: action.text }
        : { op: 'type', index: index(action.id), text: action.text, submit: action.submit };
    case 'select':
      return { op: 'select', index: index(action.id), value: action.value };
    case 'check':
      return { op: 'check', index: index(action.id), checked: action.checked };
    case 'scroll':
      return { op: 'scroll', delta: action.delta };
    case 'wait':
      return { op: 'wait', ms: action.ms };
  }
}

/** Adapts the browser tools (which return model-facing text) to the structured `PilotEnv`. */
export class BrowserPilotEnv implements PilotEnv {
  private last: PilotView | null = null;

  constructor(private readonly browser: PilotBrowser) {}

  async observe(): Promise<PilotView> {
    this.last = parseRendered(await this.browser.browserSnapshot({ text: true }), null);
    return this.last;
  }

  async act(action: PilotAction): Promise<PilotView> {
    const step = toStep(action); // validates ids before anything touches the browser
    const text = await this.browser.browserDo([step]);
    this.last = parseRendered(text, this.last);
    return this.last;
  }
}
