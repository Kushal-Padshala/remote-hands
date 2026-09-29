import { describe, it, expect, vi } from 'vitest';
import { performAxAction, getAvailableAxActions, setAxElementValue } from './ax-actions.js';

describe('ax-actions', () => {
  it('dispatches AXPress via swift script with app and index', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"success":true}\n', stderr: '', status: 0 });
    const success = await performAxAction('Bambu Studio', 5, 'AXPress', execMock);
    expect(success).toBe(true);
    expect(execMock).toHaveBeenCalledWith('swift', expect.arrayContaining(['-e', expect.stringContaining('AXUIElementPerformAction')]));
  });

  it('retrieves available actions for an element index', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '["AXPress","AXShowMenu"]\n', stderr: '', status: 0 });
    const actions = await getAvailableAxActions('Slack', 3, execMock);
    expect(actions).toEqual(['AXPress', 'AXShowMenu']);
  });

  it('sets value directly on an accessible element', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"success":true}\n', stderr: '', status: 0 });
    const success = await setAxElementValue('Notes', 2, 'Project Update', execMock);
    expect(success).toBe(true);
    expect(execMock).toHaveBeenCalledWith('swift', expect.arrayContaining(['-e', expect.stringContaining('kAXValueAttribute')]));
  });

  it('returns false when swift execution fails', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: 'error', status: 1 });
    const success = await performAxAction('Finder', 1, 'AXPress', execMock);
    expect(success).toBe(false);
  });
});
