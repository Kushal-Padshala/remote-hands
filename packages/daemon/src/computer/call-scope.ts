import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionGate } from '../action-gate.js';

interface Scope {
  aborted: boolean;
  /** Approval waits in progress; the call's time limit does not run while the person is deciding. */
  waiting: number;
  onWaiting?: ((waiting: boolean) => void) | undefined;
}

const storage = new AsyncLocalStorage<Scope>();

/** The wording every refusal uses when a tool call was abandoned. */
export const ABANDONED = 'this call was abandoned after the tool timed out';

/**
 * Runs `fn` as one tool call. Everything it awaits (batches, nested tools, approval waits) sees
 * the same scope, so `abort()` reaches all of it without threading a token through every signature.
 */
export function runInCallScope<T>(
  fn: () => Promise<T>,
): { result: Promise<T>; abort: () => void; watchWaiting: (cb: (waiting: boolean) => void) => void } {
  const scope: Scope = { aborted: false, waiting: 0 };
  return {
    result: storage.run(scope, fn),
    abort: () => { scope.aborted = true; },
    watchWaiting: (cb) => {
      scope.onWaiting = cb;
      // the handler runs before this is called, so a wait may already have begun
      if (scope.waiting > 0) cb(true);
    },
  };
}

/** True when the tool call this code runs for was abandoned (its timeout fired): it must not act any more. */
export function isCallAborted(): boolean {
  return storage.getStore()?.aborted === true;
}

/** Wraps an approval gate: if the call was abandoned while it waited, a late "yes" does not let the action run. */
export function abandonAwareGate(gate: ActionGate): ActionGate {
  return async (label, opts) => {
    const scope = storage.getStore();
    let waiting = false;
    // The time limit of the tool call is for the work, not for the person to decide: it stands still only while the gate
    // really waits for an answer (a control that needs no approval never reaches this).
    const onWait = (now: boolean) => {
      if (!scope || now === waiting) return;
      waiting = now;
      if (now) {
        if (++scope.waiting === 1) scope.onWaiting?.(true);
      } else if (--scope.waiting === 0) {
        scope.onWaiting?.(false);
      }
    };
    try {
      await gate(label, { ...opts, onWait });
    } finally {
      onWait(false);
    }
    if (isCallAborted()) throw new Error(`${ABANDONED}; nothing was done`);
  };
}
