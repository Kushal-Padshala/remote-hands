import { describe, it, expect, vi } from 'vitest';
import { performAxAction, getAvailableAxActions, setAxElementValue } from './ax-actions.js';

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
