import { describe, it, expect, vi } from 'vitest';
import { crawlAppMenu, searchAndTriggerMenu } from './menu-crawler.js';

describe('menu-crawler', () => {
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
});
