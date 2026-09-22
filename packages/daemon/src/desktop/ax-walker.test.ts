import { describe, it, expect, vi } from 'vitest';
import { AxWalker, type RawAxNode } from './ax-walker.js';

describe('AxWalker', () => {
  it('instantiates with default options', () => {
    const walker = new AxWalker();
    expect(walker).toBeDefined();
  });

  it('is exported from daemon index', async () => {
    const daemonIndex = await import('../index.js');
    expect(daemonIndex.AxWalker).toBeDefined();
    const walker = new daemonIndex.AxWalker();
    expect(walker).toBeInstanceOf(AxWalker);
  });

  it('prunes invisible or dimensionless nodes', () => {
    const walker = new AxWalker();
    const rawNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'Submit', x: 100, y: 100, width: 80, height: 30 },
      { role: 'AXGroup', label: '', x: 100, y: 100, width: 80, height: 30 },
      { role: 'AXStaticText', label: 'Offscreen', x: -500, y: -500, width: 50, height: 20 },
      { role: 'AXButton', label: 'Hidden', x: 200, y: 200, width: 0, height: 0 },
    ];
    const elements = walker.pruneAndIndex(rawNodes);
    expect(elements.length).toBe(1);
    expect(elements[0]?.index).toBe(1);
    expect(elements[0]?.label).toBe('Submit');
    expect(elements[0]?.role).toBe('AXButton');
  });

  it('prunes elements with visible false or hidden true', () => {
    const walker = new AxWalker();
    const rawNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'Invisible', x: 50, y: 50, width: 60, height: 25, visible: false },
      { role: 'AXButton', label: 'HiddenProp', x: 50, y: 50, width: 60, height: 25, hidden: true },
      { role: 'AXButton', label: 'Visible', x: 50, y: 50, width: 60, height: 25, visible: true },
    ];
    const elements = walker.pruneAndIndex(rawNodes);
    expect(elements.length).toBe(1);
    expect(elements[0]?.label).toBe('Visible');
    expect(elements[0]?.index).toBe(1);
  });

  it('prunes elements with size smaller than 4px', () => {
    const walker = new AxWalker();
    const rawNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'TinyWidth', x: 10, y: 10, width: 3, height: 20 },
      { role: 'AXButton', label: 'TinyHeight', x: 10, y: 10, width: 20, height: 2 },
      { role: 'AXButton', label: 'ValidSize', x: 10, y: 10, width: 20, height: 20 },
    ];
    const elements = walker.pruneAndIndex(rawNodes);
    expect(elements.length).toBe(1);
    expect(elements[0]?.label).toBe('ValidSize');
  });

  it('prunes offscreen elements with negative coordinates', () => {
    const walker = new AxWalker();
    const rawNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'NegativeX', x: -10, y: 50, width: 50, height: 30 },
      { role: 'AXButton', label: 'NegativeY', x: 50, y: -10, width: 50, height: 30 },
      { role: 'AXButton', label: 'Onscreen', x: 0, y: 0, width: 50, height: 30 },
    ];
    const elements = walker.pruneAndIndex(rawNodes);
    expect(elements.length).toBe(1);
    expect(elements[0]?.label).toBe('Onscreen');
  });

  it('prunes nameless layout groups while keeping empty text fields', () => {
    const walker = new AxWalker();
    const rawNodes: RawAxNode[] = [
      { role: 'AXGroup', label: '', x: 10, y: 10, width: 100, height: 100 },
      { role: 'AXGroup', label: '   ', x: 10, y: 10, width: 100, height: 100 },
      { role: 'AXButton', label: '  ', x: 10, y: 10, width: 50, height: 30 },
      { role: 'AXTextField', label: '', x: 10, y: 10, width: 150, height: 30 },
      { role: 'AXGroup', label: 'Named Group', x: 10, y: 10, width: 100, height: 100 },
    ];
    const elements = walker.pruneAndIndex(rawNodes);
    expect(elements.length).toBe(2);
    expect(elements[0]?.role).toBe('AXTextField');
    expect(elements[0]?.label).toBe('');
    expect(elements[0]?.index).toBe(1);
    expect(elements[1]?.role).toBe('AXGroup');
    expect(elements[1]?.label).toBe('Named Group');
    expect(elements[1]?.index).toBe(2);
  });

  it('indexes valid elements sequentially with 1-based integers', () => {
    const walker = new AxWalker();
    const rawNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'First', x: 10, y: 10, width: 50, height: 20 },
      { role: 'AXButton', label: 'Second', x: 70, y: 10, width: 50, height: 20 },
      { role: 'AXButton', label: 'Third', x: 130, y: 10, width: 50, height: 20 },
    ];
    const elements = walker.pruneAndIndex(rawNodes);
    expect(elements.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(elements.map((e) => e.label)).toEqual(['First', 'Second', 'Third']);
    expect(elements[0]?.bounds).toEqual([10, 10, 50, 20]);
  });

  it('formats element table for prompt injection', () => {
    const walker = new AxWalker();
    const table = walker.formatTable([
      { index: 1, role: 'AXButton', label: 'New File', bounds: [10, 20, 80, 40] },
      { index: 2, role: 'AXTextField', label: 'Search', bounds: [90, 20, 200, 40] },
    ]);
    expect(table).toContain('[1] AXButton "New File"');
    expect(table).toContain('[2] AXTextField "Search"');
  });

  it('formats empty element array to empty string', () => {
    const walker = new AxWalker();
    expect(walker.formatTable([])).toBe('');
  });

  it('walkActiveApp calls swift native accessibility engine and parses nodes', async () => {
    const mockNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'Save', x: 20, y: 30, width: 60, height: 25 },
      { role: 'AXTextField', label: 'File Name', x: 90, y: 30, width: 120, height: 25 },
    ];
    const execMock = vi.fn().mockReturnValue({
      stdout: JSON.stringify(mockNodes),
      stderr: '',
      status: 0,
    });
    const walker = new AxWalker({ exec: execMock });
    const elements = await walker.walkActiveApp();
    expect(elements.length).toBe(2);
    expect(elements[0]?.index).toBe(1);
    expect(elements[0]?.label).toBe('Save');
    expect(elements[1]?.index).toBe(2);
    expect(elements[1]?.label).toBe('File Name');
    expect(execMock).toHaveBeenCalledWith('swift', expect.arrayContaining(['-e']));
  });

  it('falls back to bounded JXA when swift returns empty or fails', async () => {
    const mockNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'JXA Button', x: 20, y: 30, width: 60, height: 25 },
    ];
    const execMock = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'swift') {
        return { stdout: '[]', stderr: '', status: 0 };
      }
      if (cmd === 'osascript') {
        return { stdout: JSON.stringify(mockNodes), stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    const walker = new AxWalker({ exec: execMock });
    const elements = await walker.walkActiveApp();
    expect(elements.length).toBe(1);
    expect(elements[0]?.label).toBe('JXA Button');
  });

  it('walkActiveApp supports specific application name', async () => {
    const mockNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'Cancel', x: 10, y: 10, width: 50, height: 20 },
    ];
    const execMock = vi.fn().mockReturnValue({
      stdout: JSON.stringify(mockNodes),
      stderr: '',
      status: 0,
    });
    const walker = new AxWalker({ exec: execMock });
    const elements = await walker.walkActiveApp('TextEdit');
    expect(elements.length).toBe(1);
    expect(execMock).toHaveBeenCalled();
    const script = execMock.mock.calls[0]![1].join(' ');
    expect(script).toContain('TextEdit');
  });

  it('walkActiveApp handles exec failures and invalid json gracefully', async () => {
    const execMock = vi.fn().mockReturnValue({
      stdout: 'not-json-content',
      stderr: 'error occurred',
      status: 1,
    });
    const walker = new AxWalker({ exec: execMock });
    const elements = await walker.walkActiveApp();
    expect(elements).toEqual([]);
  });

  it('walkActiveApp handles non-array json gracefully', async () => {
    const execMock = vi.fn().mockReturnValue({
      stdout: '{"error": true}',
      stderr: '',
      status: 0,
    });
    const walker = new AxWalker({ exec: execMock });
    const elements = await walker.walkActiveApp();
    expect(elements).toEqual([]);
  });

  it('walkActiveApp supports injected exec function directly in call', async () => {
    const mockNodes: RawAxNode[] = [
      { role: 'AXButton', label: 'DirectExec', x: 10, y: 10, width: 50, height: 20 },
    ];
    const execMock = vi.fn().mockReturnValue({
      stdout: JSON.stringify(mockNodes),
      stderr: '',
      status: 0,
    });
    const walker = new AxWalker();
    const elements = await walker.walkActiveApp(execMock);
    expect(elements.length).toBe(1);
    expect(elements[0]?.label).toBe('DirectExec');
    expect(execMock).toHaveBeenCalled();
  });

  it('falls back to walkVisionOcr when JXA returns empty elements', async () => {
    const ocrNodes = [
      { role: 'AXStaticText', label: 'Canvas Button', x: 50, y: 50, width: 80, height: 25 },
    ];
    const execMock = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'osascript') {
        return { stdout: '[]', stderr: '', status: 0 };
      }
      if (cmd === 'screencapture') {
        return { stdout: '', stderr: '', status: 0 };
      }
      if (cmd === 'swift') {
        return { stdout: JSON.stringify(ocrNodes), stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });

    const walker = new AxWalker({ exec: execMock });
    const elements = await walker.walkActiveApp();
    expect(elements.length).toBe(1);
    expect(elements[0]?.label).toBe('Canvas Button');
    expect(elements[0]?.index).toBe(1);
  });
});
