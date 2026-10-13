import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionGate } from '../action-gate.js';

interface Scope {
  aborted: boolean;
}

const storage = new AsyncLocalStorage<Scope>();

/** The wording every refusal uses when a tool call was abandoned. */
export const ABANDONED = 'this call was abandoned after the tool timed out';

/**
 * Runs `fn` as one tool call. Everything it awaits (batches, nested tools, approval waits) sees
 * the same scope, so `abort()` reaches all of it without threading a token through every signature.
 */
export function runInCallScope<T>(fn: () => Promise<T>): { result: Promise<T>; abort: () => void } {
  const scope: Scope = { aborted: false };
  return { result: storage.run(scope, fn), abort: () => { scope.aborted = true; } };
}

/** True when the tool call this code runs for was abandoned (its timeout fired): it must not act any more. */
export function isCallAborted(): boolean {
  return storage.getStore()?.aborted === true;
}

/** Wraps an approval gate: if the call was abandoned while it waited, a late "yes" does not let the action run. */
export function abandonAwareGate(gate: ActionGate): ActionGate {
  return async (label, opts) => {
    await gate(label, opts);
    if (isCallAborted()) throw new Error(`${ABANDONED}; nothing was done`);
  };
}
