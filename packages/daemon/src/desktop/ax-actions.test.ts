import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { performAxAction, performAxActionDetailed, getAvailableAxActions, setAxElementValue } from './ax-actions.js';

describe('ax-actions', () => {
  it('dispatches AXPress via swift script with app and index', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"success":true}\n', stderr: '', status: 0 });
    const success = await performAxAction('Bambu Studio', 5, 'AXPress', execMock);
    expect(success).toBe(true);
    expect(execMock).toHaveBeenCalledWith('swift', expect.arrayContaining(['-e', expect.stringContaining('AXUIElementPerformAction')]));
  });

  it('dispatches AXPress with target object containing bounds, role, and label', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"success":true}\n', stderr: '', status: 0 });
    const success = await performAxAction(
      'Bambu Studio',
      { index: 2, bounds: [100, 200, 80, 40], role: 'AXButton', label: 'Slice now' },
      'AXPress',
      execMock,
    );
    expect(success).toBe(true);
    const swiftCode = execMock.mock.calls[0]![1][1];
    expect(swiftCode).toContain('targetX = 100');
    expect(swiftCode).toContain('targetY = 200');
    expect(swiftCode).toContain('targetRole = "AXButton"');
    expect(swiftCode).toContain('targetLabel = "Slice now"');
  });

  it('retrieves available actions for an element index or target object', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '["AXPress","AXShowMenu"]\n', stderr: '', status: 0 });
    const actions = await getAvailableAxActions('Slack', { index: 3, role: 'AXButton' }, execMock);
    expect(actions).toEqual(['AXPress', 'AXShowMenu']);
  });

  it('sets value directly on an accessible element with target object', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"success":true}\n', stderr: '', status: 0 });
    const success = await setAxElementValue(
      'Notes',
      { index: 2, bounds: [50, 50, 200, 30] },
      'Project Update',
      execMock,
    );
    expect(success).toBe(true);
    expect(execMock).toHaveBeenCalledWith('swift', expect.arrayContaining(['-e', expect.stringContaining('kAXValueAttribute')]));
  });

  it('returns false when swift execution fails', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: 'error', status: 1 });
    const success = await performAxAction('Finder', 1, 'AXPress', execMock);
    expect(success).toBe(false);
  });

  it('verifies swift script does not fall back to frontmost app when query is non-empty', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"success":false,"error":"App not found"}\n', stderr: '', status: 0 });
    const success = await performAxAction('NonExistentAppXYZ', 1, 'AXPress', execMock);
    expect(success).toBe(false);
    const swiftCode = execMock.mock.calls[0]![1][1];
    expect(swiftCode).toContain('guard let app = targetApp else');
    expect(swiftCode).toContain('App not found');
  });
});

describe('performAxActionDetailed', () => {
  const ok = (stdout: string) => vi.fn().mockReturnValue({ stdout, stderr: '', status: 0 });

  it('reports method ax on a normal AX press', async () => {
    const res = await performAxActionDetailed('Finder', { role: 'AXButton' }, 'AXPress', ok('{"success":true,"method":"ax"}\n'));
    expect(res).toEqual({ success: true, method: 'ax' });
  });

  it('reports method cgevent when the script fell back to a physical click', async () => {
    const res = await performAxActionDetailed('Finder', { role: 'AXButton' }, 'AXPress', ok('{"success":true,"method":"cgevent"}\n'));
    expect(res).toEqual({ success: true, method: 'cgevent' });
  });

  it('surfaces the script error when the element is not found', async () => {
    const res = await performAxActionDetailed('Finder', 3, 'AXPress', ok('{"success":false,"error":"Element not found"}\n'));
    expect(res).toEqual({ success: false, error: 'Element not found' });
  });

  it('reports a swift exec failure', async () => {
    const exec = vi.fn().mockReturnValue({ stdout: '', stderr: 'boom', status: 1 });
    expect(await performAxActionDetailed('Finder', 3, 'AXPress', exec)).toEqual({ success: false, error: 'swift exec failed' });
  });

  it('reports unparsable output', async () => {
    expect(await performAxActionDetailed('Finder', 3, 'AXPress', ok('not json'))).toEqual({ success: false, error: 'unparsable result' });
  });

  it('keeps performAxAction as a boolean wrapper', async () => {
    expect(await performAxAction('Finder', 3, 'AXPress', ok('{"success":true,"method":"cgevent"}'))).toBe(true);
    expect(await performAxAction('Finder', 3, 'AXPress', ok('{"success":false,"error":"x"}'))).toBe(false);
  });

  it('tracks physical click usage in the swift script with a non-hoistable declaration', async () => {
    const exec = ok('{"success":true,"method":"ax"}');
    await performAxActionDetailed('Finder', { role: 'AXButton' }, 'AXPress', exec);
    const swift = exec.mock.calls[0]![1][1] as string;
    expect(swift).toContain('usedPhysicalClick');
    expect(swift).toMatch(/var usedPhysicalClick: Bool = false/);
    expect(swift).toContain('cgevent');
    expect(swift).toContain('usedPhysicalClick = true');
  });
});

describe('performAxActionDetailed strict matching', () => {
  const okExec = () => vi.fn().mockReturnValue({ stdout: '{"success":true,"method":"ax"}', stderr: '', status: 0 });
  const swiftOf = (exec: ReturnType<typeof okExec>) => exec.mock.calls[0]![1][1] as string;

  it('emits strictMatch = true for strict targets and false otherwise', async () => {
    const strictExec = okExec();
    await performAxActionDetailed('Finder', { bounds: [1, 2, 30, 40], role: 'AXButton', label: 'OK', strict: true }, 'AXPress', strictExec);
    expect(swiftOf(strictExec)).toContain('let strictMatch = true');
    const looseExec = okExec();
    await performAxActionDetailed('Finder', { index: 3, bounds: [1, 2, 30, 40], role: 'AXButton', label: 'OK' }, 'AXPress', looseExec);
    expect(swiftOf(looseExec)).toContain('let strictMatch = false');
    const numExec = okExec();
    await performAxActionDetailed('Finder', 5, 'AXPress', numExec);
    expect(swiftOf(numExec)).toContain('let strictMatch = false');
  });

  it('rejects strict without valid bounds and does not run swift', async () => {
    const exec = okExec();
    const res = await performAxActionDetailed('Finder', { role: 'AXButton', label: 'OK', strict: true }, 'AXPress', exec);
    expect(res).toEqual({ success: false, error: 'strict match requires bounds' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('gates the index and label branches on !strictMatch', async () => {
    const exec = okExec();
    await performAxActionDetailed('Finder', { bounds: [1, 2, 30, 40], strict: true }, 'AXPress', exec);
    const swift = swiftOf(exec);
    expect(swift).toContain('if !strictMatch && targetIndex > 0 && currentCounter == targetIndex {');
    expect(swift).toContain('if !strictMatch && !targetLabel.isEmpty && !trimmed.isEmpty {');
    // the bounds branch must not be gated
    expect(swift).toContain('if hasBounds, let (x, y, w, h) = bounds {');
  });

  it('non-strict script differs from the pre-strict template only by the strictMatch additions', async () => {
    const exec = okExec();
    await performAxActionDetailed('Finder', { index: 3, bounds: [1, 2, 30, 40], role: 'AXButton', label: 'Go "x"' }, 'AXPress', exec);
    const stripped = swiftOf(exec).replace('let strictMatch = false\n', '').split('!strictMatch && ').join('');
    expect(stripped).not.toContain('strictMatch');
    expect(stripped).toContain('if targetIndex > 0 && currentCounter == targetIndex {');
    expect(stripped).toContain('if !targetLabel.isEmpty && !trimmed.isEmpty {');
  });
});

describe('performAxActionDetailed strict fallbacks', () => {
  const okExec = () => vi.fn().mockReturnValue({ stdout: '{"success":true,"method":"ax"}', stderr: '', status: 0 });
  const swiftOf = (exec: ReturnType<typeof okExec>) => exec.mock.calls[0]![1][1] as string;

  it('gates the parent-walk and child-press fallbacks on !strictMatch', async () => {
    const exec = okExec();
    await performAxActionDetailed('Finder', { bounds: [1, 2, 30, 40], strict: true }, 'AXPress', exec);
    const swift = swiftOf(exec);
    expect(swift).toContain('if res != .success && !strictMatch && action as String == "AXPress" {\n    var cur = found');
    expect(swift).toContain('if res != .success && !strictMatch && action as String == "AXPress" {\n    var chListVal');
    // radio/checkbox value-set (acts on found itself) and the cgevent click at found's own center stay ungated
    expect(swift).toContain('if res != .success && (foundRole == "AXRadioButton" || foundRole == "AXCheckBox") {');
    expect(swift).toContain('if res != .success && action as String == "AXPress", let (x, y, w, h) = getBounds(found), w > 0, h > 0 {');
  });

  it('non-strict script equals the stored round-2 script plus only the two new gates', async () => {
    const exec = okExec();
    await performAxActionDetailed('Finder', { index: 3, bounds: [1, 2, 30, 40], role: 'AXButton', label: 'Go "x"' }, 'AXPress', exec);
    const stored = readFileSync(new URL('./fixtures/ax-press-nonstrict-round2.swift.txt', import.meta.url), 'utf8');
    const parent = 'if res != .success && action as String == "AXPress" {\n    var cur = found';
    const child = 'if res != .success && action as String == "AXPress" {\n    var chListVal';
    expect(stored).toContain(parent);
    expect(stored).toContain(child);
    const expected = stored
      .replace(parent, parent.replace('res != .success && ', 'res != .success && !strictMatch && '))
      .replace(child, child.replace('res != .success && ', 'res != .success && !strictMatch && '));
    expect(swiftOf(exec)).toBe(expected);
  });
});
