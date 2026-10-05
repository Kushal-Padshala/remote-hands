/** One control on the page as the pilot sees it: parsed from the engine's element table. */
export interface UiElement {
  /** The engine's stable id: digits for real elements, a word (`wait`, `scroll_down`) for pseudo actions. */
  id: string;
  role: string;
  label: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  /** How many further options the engine summarised as `…(+N)` after the ones listed. */
  optionsMore?: number;
  pseudo?: boolean;
}

export interface PilotView {
  browser?: string;
  title: string;
  url: string;
  /** Visible page text when the snapshot included it (untrusted). */
  text?: string;
  elements: UiElement[];
  /** The response said "(same page)": elements were patched from the previous view. */
  sameDocument: boolean;
  /** False when the engine reported no visible change. */
  changed: boolean;
  /** The engine said the page state could not be read ("(state unavailable: ...)"). */
  stateUnavailable: boolean;
  /** Lines the parser did not recognise (engine notes, hints, warnings). */
  notes: string[];
}

export type PilotAction =
  | { op: 'click'; id: string }
  | { op: 'type'; id: string; text: string; submit?: boolean }
  | { op: 'select'; id: string; value: string }
  | { op: 'check'; id: string; checked: boolean }
  | { op: 'scroll'; delta: number }
  | { op: 'wait'; ms: number };

export interface PilotEnv {
  observe(): Promise<PilotView>;
  act(action: PilotAction): Promise<PilotView>;
}

export type HandoffReason =
  | 'no_decision'
  | 'low_margin'
  | 'model_requested'
  | 'needs_text'
  | 'action_failed'
  | 'no_progress'
  | 'loop'
  | 'no_elements'
  | 'budget';

export interface PilotStep {
  index: number;
  op: string;
  elementId?: string;
  description: string;
  gapNats: number;
  decideMs: number;
  actMs: number;
  outcome: 'ok' | 'no-change' | 'failed';
}

export type PilotResult =
  | { status: 'done'; steps: PilotStep[]; elapsedMs: number; finalView: PilotView }
  | { status: 'handoff'; reason: HandoffReason; detail: string; steps: PilotStep[]; elapsedMs: number; finalView: PilotView | null }
  | { status: 'declined'; reason: string; steps: PilotStep[]; elapsedMs: number; finalView: PilotView | null };
