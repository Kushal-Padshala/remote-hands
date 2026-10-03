/** One step of a `browser_do` batch. Index ops address the ids of the last shown page. */
export interface DoStep {
  op: 'click' | 'type' | 'select' | 'check' | 'press' | 'scroll' | 'wait';
  index?: number;
  text?: string;
  value?: string;
  checked?: boolean;
  key?: string;
  delta?: number;
  ms?: number;
  submit?: boolean;
}

/** Browser operations as the computer-use tools see them; every method returns model-facing text. */
export interface BrowserPort {
  tabs(): Promise<string>;
  focus(target: string | number): Promise<string>;
  open(url: string): Promise<string>;
  snapshot(opts?: { text?: boolean }): Promise<string>;
  click(index: number): Promise<string>;
  type(index: number, text: string, opts?: { submit?: boolean }): Promise<string>;
  find(query: string, limit?: number): Promise<string>;
  do(steps: DoStep[]): Promise<string>;
  extract(maxChars?: number): Promise<string>;
}

/** `computer_batch` wording for the steps that succeeded before step `n` (1-based). */
export function okSoFar(n: number): string {
  return n === 1 ? 'no steps ok' : n === 2 ? 'step 1 ok' : `steps 1-${n - 1} ok`;
}
