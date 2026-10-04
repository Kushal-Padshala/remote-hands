import { describe, it, expect, vi } from 'vitest';
import { crawlAppMenu, searchAndTriggerMenu } from './menu-crawler.js';

describe('menu-crawler', () => {
  it('resolves the full menu label before approval and never presses on rejection', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stderr: '', stdout: JSON.stringify({ success: true, triggeredPath: ['Edit', 'Delete'], appPid: 123 }) });
    const labels: string[] = [];
    await expect(searchAndTriggerMenu('Mail', 'Del', exec, async (label) => {
      labels.push(label);
      throw new Error('Approval rejected');
    })).rejects.toThrow('Approval rejected');
    expect(labels).toEqual(['Delete']);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('presses only after the resolved item is approved', async () => {
    const order: string[] = [];
    const exec = vi.fn(() => {
      order.push(order.length === 0 ? 'resolve' : 'press');
      return { status: 0, stderr: '', stdout: JSON.stringify({ success: true, triggeredPath: ['Edit', 'Delete'], appPid: 123 }) };
    });
    const result = await searchAndTriggerMenu('Mail', 'Del', exec, async (label) => { order.push(`approve ${label}`); });
    expect(order).toEqual(['resolve', 'approve Delete', 'press']);
    expect(result).toEqual({ success: true, triggeredPath: ['Edit', 'Delete'], appPid: 123 });
  });

  it('does not request approval or press when menu resolution fails', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stderr: '', stdout: JSON.stringify({ success: false, error: 'No menu match found' }) });
    const gate = vi.fn();
    expect((await searchAndTriggerMenu('Mail', 'Del', exec, gate)).success).toBe(false);
    expect(gate).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('stops if the approved menu path disappears before pressing', async () => {
    const exec = vi.fn()
      .mockReturnValueOnce({ status: 0, stderr: '', stdout: JSON.stringify({ success: true, triggeredPath: ['Edit', 'Delete'], appPid: 123 }) })
      .mockReturnValueOnce({ status: 0, stderr: '', stdout: JSON.stringify({ success: false, error: 'No menu match found' }) });
    expect(await searchAndTriggerMenu('Mail', 'Del', exec, async () => {})).toEqual({ success: false, error: 'No menu match found' });
  });

  it('crawls hierarchical menu items for target app', async () => {
    const mockTree = [
      {
        title: 'File',
        children: [
          { title: 'New Project', shortcut: 'Cmd+N' },
          { title: 'Import', children: [{ title: 'Import 3D Model', shortcut: 'Cmd+I' }] },
        ],
      },
      {
        title: 'Edit',
        children: [{ title: 'Select All', shortcut: 'Cmd+A' }],
      },
    ];
    const execMock = vi.fn().mockReturnValue({ stdout: JSON.stringify(mockTree) + '\n', stderr: '', status: 0 });
    const items = await crawlAppMenu('Bambu Studio', execMock);
    expect(items.length).toBe(2);
    expect(items[0]?.title).toBe('File');
    expect(items[0]?.children?.[0]?.title).toBe('New Project');
  });

  it('fuzzy matches and triggers menu item by query string', async () => {
    const execMock = vi.fn().mockReturnValue({
      stdout: JSON.stringify({ success: true, triggeredPath: ['File', 'Import', 'Import 3D Model'] }) + '\n',
      stderr: '',
      status: 0,
    });
    const result = await searchAndTriggerMenu('Bambu Studio', 'import 3d model', execMock);
    expect(result.success).toBe(true);
    expect(result.triggeredPath).toEqual(['File', 'Import', 'Import 3D Model']);
  });

  it('returns failure when menu item cannot be found', async () => {
    const execMock = vi.fn().mockReturnValue({
      stdout: JSON.stringify({ success: false, error: 'No menu match found' }) + '\n',
      stderr: '',
      status: 0,
    });
    const result = await searchAndTriggerMenu('Bambu Studio', 'nonexistent menu item', execMock);
    expect(result.success).toBe(false);
    expect(result.error).toBe('No menu match found');
  });

  it('returns empty array when crawlAppMenu fails', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: 'error', status: 1 });
    const items = await crawlAppMenu('Finder', execMock);
    expect(items).toEqual([]);
  });

  it('returns failure when searchAndTriggerMenu execution throws or fails', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: 'Command failed', status: 1 });
    const result = await searchAndTriggerMenu('Finder', 'nonexistent', execMock);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Command failed');
  });

  it('returns failure and does not fall back when target app is not running', async () => {
    const execMock = vi.fn().mockReturnValue({
      stdout: JSON.stringify({ success: false, error: 'App not found' }) + '\n',
      stderr: '',
      status: 0,
    });
    const result = await searchAndTriggerMenu('NonExistentAppXYZ', 'File', execMock);
    expect(result.success).toBe(false);
    expect(result.error).toBe('App not found');
    const swiftCode = execMock.mock.calls[0]![1][1];
    expect(swiftCode).toContain('guard let app = targetApp else');
    expect(swiftCode).toContain('App not found');
  });
});
