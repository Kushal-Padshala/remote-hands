import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { browserCommand, ensureChromeAutomationReady } from './browser.js';

const mockSnapshot = vi.fn();
const mockClickIndex = vi.fn();
const mockTypeIndex = vi.fn();
const mockOpenUrl = vi.fn();
const mockListTabs = vi.fn();

vi.mock('@remote-hands/daemon', () => ({
  BrowserDriver: class {
    snapshot = mockSnapshot;
    clickIndex = mockClickIndex;
    typeIndex = mockTypeIndex;
    openUrl = mockOpenUrl;
    listTabs = mockListTabs;
  },
  ChromeManager: class {
    ensureRunning = vi.fn().mockResolvedValue({ available: true });
  },
  MacOsDriver: class {
    focusWindow = vi.fn().mockResolvedValue(undefined);
  },
}));

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

describe('browserCommand', () => {
  let stdoutMessages: string[] = [];
  let stderrMessages: string[] = [];

  beforeEach(() => {
    stdoutMessages = [];
    stderrMessages = [];
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }));
  });

  const getCtx = () => ({
    stdout: (m: string) => stdoutMessages.push(m),
    stderr: (m: string) => stderrMessages.push(m),
  });

  describe('snapshot subcommand', () => {
    it('prints indexed snapshot table', async () => {
      mockSnapshot.mockResolvedValueOnce({
        url: 'https://test.local',
        title: 'Test',
        formattedTable: '[1] button   Deploy',
      });
      const code = await browserCommand(['snapshot'], getCtx());
      expect(code).toBe(0);
      expect(stdoutMessages.join('\n')).toContain('[1] button   Deploy');
      expect(mockSnapshot).toHaveBeenCalledTimes(1);
    });

    it('prints json when --json flag is passed', async () => {
      const mockResult = {
        url: 'https://test.local',
        title: 'Test',
        elements: [{ index: 1, role: 'button', label: 'Deploy' }],
        formattedTable: '[1] button   Deploy',
      };
      mockSnapshot.mockResolvedValueOnce(mockResult);
      const code = await browserCommand(['snapshot', '--json'], getCtx());
      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutMessages.join('\n'));
      expect(parsed.url).toBe('https://test.local');
      expect(parsed.elements[0].label).toBe('Deploy');
    });

    it('handles snapshot error gracefully', async () => {
      mockSnapshot.mockRejectedValueOnce(new Error('Snapshot failed'));
      const code = await browserCommand(['snapshot'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Snapshot failed');
    });
  });

  describe('click subcommand', () => {
    it('requires index argument', async () => {
      const code = await browserCommand(['click'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Usage: rh browser click <index>');
      expect(mockClickIndex).not.toHaveBeenCalled();
    });

    it('rejects non-integer index', async () => {
      const code = await browserCommand(['click', 'invalid'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Usage: rh browser click <index>');
      expect(mockClickIndex).not.toHaveBeenCalled();
    });

    it('clicks valid index and prints confirmation', async () => {
      mockClickIndex.mockResolvedValueOnce({ success: true, label: 'Submit Button' });
      const code = await browserCommand(['click', '1'], getCtx());
      expect(code).toBe(0);
      expect(mockClickIndex).toHaveBeenCalledWith(1);
      expect(stdoutMessages.join('\n')).toContain('Clicked [1] Submit Button');
    });

    it('handles click error gracefully', async () => {
      mockClickIndex.mockRejectedValueOnce(new Error('Index 99 not found'));
      const code = await browserCommand(['click', '99'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Index 99 not found');
    });
  });

  describe('type subcommand', () => {
    it('requires index and text arguments', async () => {
      const code = await browserCommand(['type'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Usage: rh browser type <index> <text>');
      expect(mockTypeIndex).not.toHaveBeenCalled();
    });

    it('requires text argument when index is given', async () => {
      const code = await browserCommand(['type', '1'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Usage: rh browser type <index> <text>');
      expect(mockTypeIndex).not.toHaveBeenCalled();
    });

    it('rejects non-integer index', async () => {
      const code = await browserCommand(['type', 'abc', 'hello'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Usage: rh browser type <index> <text>');
      expect(mockTypeIndex).not.toHaveBeenCalled();
    });

    it('types into valid index and prints confirmation', async () => {
      mockTypeIndex.mockResolvedValueOnce({ success: true, label: 'Email Input' });
      const code = await browserCommand(['type', '2', 'test@example.com'], getCtx());
      expect(code).toBe(0);
      expect(mockTypeIndex).toHaveBeenCalledWith(2, 'test@example.com');
      expect(stdoutMessages.join('\n')).toContain('Typed "test@example.com" into [2] Email Input');
    });

    it('handles multi-word text argument', async () => {
      mockTypeIndex.mockResolvedValueOnce({ success: true, label: 'Search Input' });
      const code = await browserCommand(['type', '2', 'hello', 'world', 'query'], getCtx());
      expect(code).toBe(0);
      expect(mockTypeIndex).toHaveBeenCalledWith(2, 'hello world query');
      expect(stdoutMessages.join('\n')).toContain('Typed "hello world query" into [2] Search Input');
    });

    it('handles type error gracefully', async () => {
      mockTypeIndex.mockRejectedValueOnce(new Error('Target node no longer connected'));
      const code = await browserCommand(['type', '1', 'hello'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Target node no longer connected');
    });
  });

  describe('open subcommand', () => {
    it('requires url argument', async () => {
      const code = await browserCommand(['open'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Usage: rh browser open <url>');
      expect(mockOpenUrl).not.toHaveBeenCalled();
    });

    it('rejects invalid url format', async () => {
      const code = await browserCommand(['open', 'not-a-valid-url'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Invalid URL');
      expect(mockOpenUrl).not.toHaveBeenCalled();
    });

    it('navigates to valid url and prints confirmation', async () => {
      mockOpenUrl.mockResolvedValueOnce({ success: true, url: 'https://example.com' });
      const code = await browserCommand(['open', 'https://example.com'], getCtx());
      expect(code).toBe(0);
      expect(mockOpenUrl).toHaveBeenCalledWith('https://example.com');
      expect(stdoutMessages.join('\n')).toContain('Opened https://example.com');
    });

    it('handles navigation error gracefully', async () => {
      mockOpenUrl.mockRejectedValueOnce(new Error('Navigation timed out'));
      const code = await browserCommand(['open', 'https://example.com'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Navigation timed out');
    });
  });

  describe('tabs subcommand', () => {
    it('lists open tabs', async () => {
      mockListTabs.mockResolvedValueOnce([
        { id: 'tab-1', title: 'Home', url: 'https://example.com' },
        { id: 'tab-2', title: 'Dashboard', url: 'https://app.example.com' },
      ]);
      const code = await browserCommand(['tabs'], getCtx());
      expect(code).toBe(0);
      expect(stdoutMessages.join('\n')).toContain('[tab-1] Home - https://example.com');
      expect(stdoutMessages.join('\n')).toContain('[tab-2] Dashboard - https://app.example.com');
    });

    it('prints message when no tabs exist', async () => {
      mockListTabs.mockResolvedValueOnce([]);
      const code = await browserCommand(['tabs'], getCtx());
      expect(code).toBe(0);
      expect(stdoutMessages.join('\n')).toContain('No open tabs found.');
    });

    it('prints json tabs when --json is provided', async () => {
      mockListTabs.mockResolvedValueOnce([
        { id: 'tab-1', title: 'Home', url: 'https://example.com' },
      ]);
      const code = await browserCommand(['tabs', '--json'], getCtx());
      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutMessages.join('\n'));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('tab-1');
    });

    it('handles tabs error gracefully', async () => {
      mockListTabs.mockRejectedValueOnce(new Error('Failed to list CDP targets'));
      const code = await browserCommand(['tabs'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Failed to list CDP targets');
    });
  });

  describe('fallback to browser-harness', () => {
    it('spawns browser-harness when no subcommand is provided', async () => {
      const mockChild = new EventEmitter();
      mockSpawn.mockReturnValueOnce(mockChild);
      setTimeout(() => mockChild.emit('close', 0), 10);

      const code = await browserCommand([], getCtx());
      expect(code).toBe(0);
      expect(mockSpawn).toHaveBeenCalledWith(
        'browser-harness',
        [],
        expect.objectContaining({
          env: expect.objectContaining({ BU_CDP_URL: 'http://127.0.0.1:9222' }),
        }),
      );
    });

    it('spawns browser-harness with non-indexed command arguments', async () => {
      const mockChild = new EventEmitter();
      mockSpawn.mockReturnValueOnce(mockChild);
      setTimeout(() => mockChild.emit('close', 0), 10);

      const code = await browserCommand(['run-test.py', '--arg'], getCtx());
      expect(code).toBe(0);
      expect(mockSpawn).toHaveBeenCalledWith(
        'browser-harness',
        ['run-test.py', '--arg'],
        expect.any(Object),
      );
    });

    it('handles spawn error gracefully', async () => {
      const mockChild = new EventEmitter();
      mockSpawn.mockReturnValueOnce(mockChild);
      setTimeout(() => mockChild.emit('error', new Error('Command not found')), 10);

      const code = await browserCommand(['test.py'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Error running browser-harness: Command not found');
    });
  });

  describe('ensureChromeAutomationReady', () => {
    it('uses custom cdpUrl when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url === 'http://127.0.0.1:9225/json/version') {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error('connection refused'));
      }));
      const ready = await ensureChromeAutomationReady({ cdpUrl: 'http://127.0.0.1:9225' });
      expect(ready).toBe(true);
    });
  });
});
