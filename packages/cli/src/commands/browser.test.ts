import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserAutomationError, BROWSERS } from '@remote-hands/daemon';
import { browserCommand, ensureChromeAutomationReady } from './browser.js';

const mockSnapshot = vi.fn();
const mockClickIndex = vi.fn();
const mockTypeIndex = vi.fn();
const mockOpenUrl = vi.fn();
const mockListTabs = vi.fn();
const mockFocusTab = vi.fn();
const mockFindTab = vi.fn();

vi.mock('@remote-hands/daemon', async () => ({
  // Real registry, error class and picker (pure modules): the doctor uses them; the rest stays faked.
  ...(await import('../../../daemon/src/browser/browsers.js')),
  ...(await import('../../../daemon/src/browser/applescript.js')),
  BrowserDriver: class {
    snapshot = mockSnapshot;
    clickIndex = mockClickIndex;
    typeIndex = mockTypeIndex;
    openUrl = mockOpenUrl;
    listTabs = mockListTabs;
    focusTab = mockFocusTab;
    findTab = mockFindTab;
  },
  ChromeManager: class {
    static isSystemChromeRunning = vi.fn().mockReturnValue(false);
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

  describe('doctor subcommand', () => {
    const browserByName = (name: string) => BROWSERS.find((b) => b.name === name)!;

    function fakeTransport(opts: {
      frontmost?: string | null;
      running: string[];
      probe?: Record<string, string | BrowserAutomationError>;
    }) {
      const evaluate = vi.fn(async (b: { name: string }) => {
        const r = opts.probe?.[b.name] ?? '1';
        if (r instanceof BrowserAutomationError) throw r;
        return r;
      });
      const environment = vi.fn(async () => ({ frontmost: opts.frontmost ?? null, running: opts.running }));
      return { environment, evaluate };
    }

    const jsDisabled = (name: string) =>
      new BrowserAutomationError(
        'js_disabled',
        name,
        `${name} has JavaScript from Apple Events turned off. Enable it once: ${name} menu bar > View > Developer > Allow JavaScript from Apple Events.`,
      );

    it('prints a ready line for a browser whose probe succeeds and never touches CDP', async () => {
      const transport = fakeTransport({ frontmost: 'Google Chrome', running: ['Google Chrome'] });
      const code = await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
      const out = stdoutMessages.join('\n');
      expect(code).toBe(0);
      expect(out).toContain('✔ Google Chrome');
      expect(out).toContain('fast path ready');
      expect(transport.evaluate).toHaveBeenCalledTimes(1);
      expect(transport.evaluate).toHaveBeenCalledWith(browserByName('Google Chrome'), null, '1');
      expect(fetch).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(stderrMessages).toEqual([]);
    });

    it('prints the cross mark and the menu path for js_disabled, and still exits 0', async () => {
      const transport = fakeTransport({
        frontmost: 'Brave Browser',
        running: ['Brave Browser'],
        probe: { 'Brave Browser': jsDisabled('Brave Browser') },
      });
      const code = await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
      const out = stdoutMessages.join('\n');
      expect(code).toBe(0);
      expect(out).toContain('✖ Brave Browser');
      expect(out).toContain('View > Developer > Allow JavaScript from Apple Events');
      expect(out).toContain('not available');
    });

    it('reports a closed browser as not running without probing it', async () => {
      const transport = fakeTransport({ frontmost: 'Google Chrome', running: ['Google Chrome'] });
      await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
      const out = stdoutMessages.join('\n');
      expect(out).toMatch(/– Safari\s+not running/);
      const probed = transport.evaluate.mock.calls.map((c) => c[0].name);
      expect(probed).toEqual(['Google Chrome']);
    });

    it('says a running browser without a window has an unknown setting', async () => {
      const transport = fakeTransport({
        running: ['Arc'],
        probe: { Arc: new BrowserAutomationError('no_window', 'Arc', 'Arc has no open window.') },
      });
      await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
      const out = stdoutMessages.join('\n');
      expect(out).toContain('Arc has no open window.');
      expect(out).toContain('setting unknown');
    });

    it('maps automation_denied and timeout to the error message', async () => {
      const transport = fakeTransport({
        running: ['Google Chrome', 'Microsoft Edge'],
        probe: {
          'Google Chrome': new BrowserAutomationError('automation_denied', 'Google Chrome', 'macOS blocked this app from controlling Google Chrome. Allow it in System Settings > Privacy & Security > Automation.'),
          'Microsoft Edge': new BrowserAutomationError('timeout', 'Microsoft Edge', 'Microsoft Edge did not answer in time.'),
        },
      });
      const code = await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
      const out = stdoutMessages.join('\n');
      expect(code).toBe(0);
      expect(out).toContain('Privacy & Security > Automation');
      expect(out).toContain('did not answer in time');
    });

    it('prints the target browser and a security note', async () => {
      const transport = fakeTransport({ frontmost: 'Brave Browser', running: ['Google Chrome', 'Brave Browser'] });
      await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
      const out = stdoutMessages.join('\n');
      expect(out).toContain('Target browser: Brave Browser');
      expect(out).toContain('any app with Automation permission can run JavaScript in your tabs');
    });

    it('honours RH_BROWSER for the target', async () => {
      vi.stubEnv('RH_BROWSER', 'chrome');
      try {
        const transport = fakeTransport({ frontmost: 'Brave Browser', running: ['Google Chrome', 'Brave Browser'] });
        await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
        expect(stdoutMessages.join('\n')).toContain('Target browser: Google Chrome');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('prints no target when no browser is running', async () => {
      const transport = fakeTransport({ running: [] });
      await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
      const out = stdoutMessages.join('\n');
      expect(out).toContain('Target browser: none');
      expect(transport.evaluate).not.toHaveBeenCalled();
    });

    it('--json prints one parseable object and nothing else', async () => {
      const transport = fakeTransport({
        frontmost: 'Brave Browser',
        running: ['Brave Browser', 'Google Chrome'],
        probe: { 'Brave Browser': jsDisabled('Brave Browser') },
      });
      const code = await browserCommand(['doctor', '--json'], { ...getCtx(), browserTransport: transport });
      expect(code).toBe(0);
      expect(stdoutMessages).toHaveLength(1);
      const parsed = JSON.parse(stdoutMessages[0]!);
      expect(parsed.target).toBe('Brave Browser');
      expect(parsed.browsers).toHaveLength(BROWSERS.length);
      const brave = parsed.browsers.find((b: any) => b.name === 'Brave Browser');
      expect(brave).toMatchObject({ family: 'chromium', running: true, ready: false, code: 'js_disabled' });
      expect(brave.message).toContain('Allow JavaScript from Apple Events');
      const chrome = parsed.browsers.find((b: any) => b.name === 'Google Chrome');
      expect(chrome).toMatchObject({ running: true, ready: true });
      expect(chrome.code).toBeUndefined();
      const safari = parsed.browsers.find((b: any) => b.name === 'Safari');
      expect(safari).toMatchObject({ running: false, ready: false });
    });

    it('--json reports a null target when nothing runs', async () => {
      const transport = fakeTransport({ running: [] });
      await browserCommand(['doctor', '--json'], { ...getCtx(), browserTransport: transport });
      expect(JSON.parse(stdoutMessages[0]!).target).toBeNull();
    });

    it('rejects unknown doctor arguments as a usage error', async () => {
      const transport = fakeTransport({ running: [] });
      const code = await browserCommand(['doctor', '--bogus'], { ...getCtx(), browserTransport: transport });
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Usage: rh browser doctor [--json]');
      expect(transport.environment).not.toHaveBeenCalled();
    });

    it('exits 0 with a message when the environment cannot be read', async () => {
      const transport = fakeTransport({ running: [] });
      transport.environment.mockRejectedValueOnce(
        new BrowserAutomationError('automation_denied', 'osascript', 'macOS blocked this app.'),
      );
      const code = await browserCommand(['doctor'], { ...getCtx(), browserTransport: transport });
      expect(code).toBe(0);
      expect(stdoutMessages.join('\n')).toContain('macOS blocked this app.');
    });
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

    it('reuses and focuses existing tab when open matches open tab', async () => {
      mockFindTab.mockResolvedValueOnce({
        id: 'tab-9',
        title: 'App Store Connect',
        url: 'https://appstoreconnect.apple.com/apps/6817089779',
      });
      mockFocusTab.mockResolvedValueOnce({
        success: true,
        tab: {
          id: 'tab-9',
          title: 'App Store Connect',
          url: 'https://appstoreconnect.apple.com/apps/6817089779',
        },
      });

      const code = await browserCommand(['open', 'https://appstoreconnect.apple.com/apps/6817089779'], getCtx());
      expect(code).toBe(0);
      expect(mockFocusTab).toHaveBeenCalledWith('tab-9');
      expect(mockOpenUrl).not.toHaveBeenCalled();
      expect(stdoutMessages.join('\n')).toContain('Focused existing tab: [tab-9] App Store Connect');
    });

    it('bypasses reuse and opens new tab when --new is provided', async () => {
      mockOpenUrl.mockResolvedValueOnce({ success: true, url: 'https://example.com' });
      const code = await browserCommand(['open', 'https://example.com', '--new'], getCtx());
      expect(code).toBe(0);
      expect(mockFindTab).not.toHaveBeenCalled();
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

  describe('focus subcommand', () => {
    it('requires target argument', async () => {
      const code = await browserCommand(['focus'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Usage: rh browser focus <index | id | url | title>');
    });

    it('focuses matching tab by query', async () => {
      mockFocusTab.mockResolvedValueOnce({
        success: true,
        tab: {
          id: 'w2-t2',
          title: 'App Store Connect',
          url: 'https://appstoreconnect.apple.com',
        },
      });
      const code = await browserCommand(['focus', 'appstoreconnect'], getCtx());
      expect(code).toBe(0);
      expect(mockFocusTab).toHaveBeenCalledWith('appstoreconnect');
      expect(stdoutMessages.join('\n')).toContain('Focused tab [w2-t2] App Store Connect');
    });

    it('handles focus error gracefully', async () => {
      mockFocusTab.mockRejectedValueOnce(new Error('Tab matching "missing" not found'));
      const code = await browserCommand(['focus', 'missing'], getCtx());
      expect(code).toBe(1);
      expect(stderrMessages.join('\n')).toContain('Tab matching "missing" not found');
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

    it('returns false without launching dedicated instance if system Chrome is already running', async () => {
      const { ChromeManager } = await import('@remote-hands/daemon');
      (ChromeManager.isSystemChromeRunning as any).mockReturnValueOnce(true);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
      const ready = await ensureChromeAutomationReady();
      expect(ready).toBe(false);
    });
  });
});
