import { describe, it, expect, vi } from 'vitest';
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
