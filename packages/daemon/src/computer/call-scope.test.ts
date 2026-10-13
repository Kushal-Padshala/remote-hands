import { describe, it, expect } from 'vitest';
import { abandonAwareGate, ABANDONED, isCallAborted, runInCallScope } from './call-scope.js';

describe('call scope', () => {
  it('is not aborted outside any call, and reaches awaited and nested work once aborted', async () => {
    expect(isCallAborted()).toBe(false);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { result, abort } = runInCallScope(async () => {
      const before = isCallAborted();
      await held;
      await Promise.resolve();
      const nested = await (async () => isCallAborted())();
      return { before, after: isCallAborted(), nested };
    });
    abort();
    release();
    expect(await result).toEqual({ before: false, after: true, nested: true });
  });

  it('keeps calls apart: aborting one does not abort another', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const a = runInCallScope(async () => { await held; return isCallAborted(); });
    const b = runInCallScope(async () => { await held; return isCallAborted(); });
    a.abort();
    release();
    expect([await a.result, await b.result]).toEqual([true, false]);
  });

  it('a late approval does not let an abandoned call act, but is transparent otherwise', async () => {
    let approve!: () => void;
    const waiting = new Promise<void>((r) => { approve = r; });
    const gate = abandonAwareGate(async () => { await waiting; });
    const abandoned = runInCallScope(() => gate('Delete'));
    abandoned.abort();
    approve();
    await expect(abandoned.result).rejects.toThrow(`${ABANDONED}; nothing was done`);
    await expect(runInCallScope(() => abandonAwareGate(async () => {})('Save')).result).resolves.toBeUndefined();
    await expect(abandonAwareGate(async () => {})('Save')).resolves.toBeUndefined();
  });
});
