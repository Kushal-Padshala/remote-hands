import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntentResolver } from './intent-resolver.js';

describe('IntentResolver', () => {
  let mockAxWalker: any;
  let resolver: IntentResolver;

  beforeEach(() => {
    mockAxWalker = {
      walkActiveApp: vi.fn().mockResolvedValue([]),
    };
    resolver = new IntentResolver(mockAxWalker);
  });

  it('resolves direct element match from active app AX tree', async () => {
    mockAxWalker.walkActiveApp.mockResolvedValue([
      { index: 1, role: 'AXButton', label: 'Upload File', bounds: [100, 200, 120, 36] },
      { index: 2, role: 'AXButton', label: 'Cancel', bounds: [230, 200, 80, 36] },
    ]);

    const res = await resolver.resolve('where to upload a file', 'Photoshop');
    expect(res.steps.length).toBe(1);
    expect(res.steps[0]?.text).toContain('Upload File');
    expect(res.source).toBe('ax_element');
  });

  it('resolves standard file open heuristic when app has File menu', async () => {
    mockAxWalker.walkActiveApp.mockResolvedValue([]);

    const res = await resolver.resolve('how to upload or open a new file', 'Photoshop');
    expect(res.steps.length).toBeGreaterThanOrEqual(1);
    expect(res.steps[0]?.app).toBe('Photoshop');
    expect(res.steps[0]?.text.toLowerCase()).toContain('file');
  });

  it('resolves export heuristic for export query', async () => {
    mockAxWalker.walkActiveApp.mockResolvedValue([]);

    const res = await resolver.resolve('how to export image as png', 'Photoshop');
    expect(res.steps.length).toBeGreaterThanOrEqual(1);
    expect(res.steps.some((s) => s.text.toLowerCase().includes('export'))).toBe(true);
  });

  it('resolves settings heuristic for preferences/settings query', async () => {
    mockAxWalker.walkActiveApp.mockResolvedValue([]);

    const res = await resolver.resolve('where are settings', 'Photoshop');
    expect(res.steps.length).toBeGreaterThanOrEqual(1);
    expect(res.steps.some((s) => s.text.toLowerCase().includes('settings'))).toBe(true);
  });
});
