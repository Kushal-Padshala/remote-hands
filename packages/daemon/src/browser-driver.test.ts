import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserDriver, type BrowserTab } from './browser-driver.js';

describe('BrowserDriver', () => {
  let driver: BrowserDriver;
  const mockTabs = [
    {
      id: 'tab-1',
      type: 'page',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    },
    {
      id: 'bg-1',
      type: 'background_page',
      title: 'Extension',
      url: 'chrome-extension://xyz',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/bg-1',
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('discovers tabs from CDP HTTP endpoint and filters non-page targets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockTabs,
      }),
    );
    driver = new BrowserDriver({ cdpUrl: 'http://127.0.0.1:9222/' });
    const tabs = await driver.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    });
  });

  it('throws error when listing tabs fails HTTP request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error',
      }),
    );
    driver = new BrowserDriver();
    await expect(driver.listTabs()).rejects.toThrow('Failed to list CDP targets: Internal Server Error');
  });

  it('returns first active tab when available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockTabs,
      }),
    );
    driver = new BrowserDriver();
    const activeTab = await driver.getActiveTab();
    expect(activeTab.id).toBe('tab-1');
  });

  it('throws error when getActiveTab finds no page tabs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ type: 'service_worker', id: 'sw-1' }],
      }),
    );
    driver = new BrowserDriver();
    await expect(driver.getActiveTab()).rejects.toThrow('No open Chrome tabs found on CDP port');
  });

  it('takes a snapshot and parses the result', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver as any, 'executeScript').mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      elements: [{ index: 1, id: 10, role: 'button', label: 'Click Me', tag: 'BUTTON' }],
    });

    const snap = await driver.snapshot();
    expect(snap.url).toBe('https://example.com');
    expect(snap.title).toBe('Example');
    expect(snap.elements).toHaveLength(1);
    expect(snap.formattedTable).toContain('[1] button   Click Me');
  });

  it('clicks indexed element successfully', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'snapshot').mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      elements: [{ index: 1, id: 42, role: 'button', label: 'Submit Form', tag: 'BUTTON' }],
      formattedTable: '',
    });
    const execSpy = vi.spyOn(driver as any, 'executeScript').mockResolvedValue(true);

    const result = await driver.clickIndex(1);
    expect(result).toEqual({ success: true, label: 'Submit Form' });
    expect(execSpy).toHaveBeenCalledTimes(1);
    const script = execSpy.mock.calls[0]?.[0] as string;
    expect(script).toContain('window.__rhFast?.nodes.get(42)');
    expect(script).toContain('node.click()');
  });

  it('falls back to role for clickIndex label when label is empty', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'snapshot').mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      elements: [{ index: 2, id: 43, role: 'link', label: '', tag: 'A' }],
      formattedTable: '',
    });
    vi.spyOn(driver as any, 'executeScript').mockResolvedValue(true);

    const result = await driver.clickIndex(2);
    expect(result).toEqual({ success: true, label: 'link' });
  });

  it('rejects clickIndex with descriptive error when index is not found', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'snapshot').mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      elements: [{ index: 1, id: 1, role: 'button', label: 'Submit', tag: 'BUTTON' }],
      formattedTable: '',
    });
    await expect(driver.clickIndex(99)).rejects.toThrow(
      'Index 99 not found. Run snapshot to view current indexed elements.',
    );
  });

  it('types text into indexed element successfully', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'snapshot').mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      elements: [{ index: 1, id: 55, role: 'textbox', label: 'Username', tag: 'INPUT' }],
      formattedTable: '',
    });
    const execSpy = vi.spyOn(driver as any, 'executeScript').mockResolvedValue(true);

    const result = await driver.typeIndex(1, 'hello "world"');
    expect(result).toEqual({ success: true, label: 'Username' });
    expect(execSpy).toHaveBeenCalledTimes(1);
    const script = execSpy.mock.calls[0]?.[0] as string;
    expect(script).toContain('window.__rhFast?.nodes.get(55)');
    expect(script).toContain('insertText');
    expect(script).toContain('"hello \\"world\\""');
  });

  it('rejects typeIndex with descriptive error when index is not found', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'snapshot').mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      elements: [{ index: 1, id: 1, role: 'textbox', label: 'Search', tag: 'INPUT' }],
      formattedTable: '',
    });
    await expect(driver.typeIndex(404, 'test')).rejects.toThrow(
      'Index 404 not found. Run snapshot to view current indexed elements.',
    );
  });

  it('executes openUrl over WebSocket and resolves successfully', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    });

    class MockWs {
      on(event: string, cb: any) {
        if (event === 'open') {
          setTimeout(cb, 0);
        }
        if (event === 'message') {
          this.messageCb = cb;
        }
      }
      send(data: string) {
        const parsed = JSON.parse(data);
        setTimeout(() => {
          this.messageCb?.(Buffer.from(JSON.stringify({ id: parsed.id, result: {} })));
        }, 0);
      }
      close() {}
      private messageCb: any;
    }

    vi.spyOn(driver as any, 'createWebSocket').mockReturnValue(new MockWs());

    const res = await driver.openUrl('https://google.com');
    expect(res).toEqual({ success: true, url: 'https://google.com' });
  });

  it('throws error in openUrl if active tab lacks webSocketDebuggerUrl', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
    });
    await expect(driver.openUrl('https://example.com')).rejects.toThrow(
      'Active tab does not provide webSocketDebuggerUrl',
    );
  });

  it('throws error in executeScript if active tab lacks webSocketDebuggerUrl', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
    });
    await expect((driver as any).executeScript('1 + 1')).rejects.toThrow(
      'Active tab does not provide webSocketDebuggerUrl',
    );
  });

  it('handles executeScript cdp error message', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    });

    class MockWs {
      on(event: string, cb: any) {
        if (event === 'open') {
          setTimeout(cb, 0);
        }
        if (event === 'message') {
          this.messageCb = cb;
        }
      }
      send(data: string) {
        const parsed = JSON.parse(data);
        setTimeout(() => {
          this.messageCb?.(Buffer.from(JSON.stringify({ id: parsed.id, error: { message: 'Method not found' } })));
        }, 0);
      }
      close() {}
      private messageCb: any;
    }

    vi.spyOn(driver as any, 'createWebSocket').mockReturnValue(new MockWs());
    await expect((driver as any).executeScript('badCode()')).rejects.toThrow('Method not found');
  });

  it('handles executeScript javascript exceptionDetails', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    });

    class MockWs {
      on(event: string, cb: any) {
        if (event === 'open') {
          setTimeout(cb, 0);
        }
        if (event === 'message') {
          this.messageCb = cb;
        }
      }
      send(data: string) {
        const parsed = JSON.parse(data);
        setTimeout(() => {
          this.messageCb?.(
            Buffer.from(
              JSON.stringify({
                id: parsed.id,
                result: { exceptionDetails: { text: 'Uncaught TypeError: Cannot read property' } },
              }),
            ),
          );
        }, 0);
      }
      close() {}
      private messageCb: any;
    }

    vi.spyOn(driver as any, 'createWebSocket').mockReturnValue(new MockWs());
    await expect((driver as any).executeScript('badCode()')).rejects.toThrow(
      'Uncaught TypeError: Cannot read property',
    );
  });

  it('handles executeScript websocket error', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    });

    class MockWs {
      on(event: string, cb: any) {
        if (event === 'error') {
          setTimeout(() => cb(new Error('Connection terminated')), 0);
        }
      }
      send() {}
      close() {}
    }

    vi.spyOn(driver as any, 'createWebSocket').mockReturnValue(new MockWs());
    await expect((driver as any).executeScript('1 + 1')).rejects.toThrow('Connection terminated');
  });

  it('handles openUrl websocket error', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    });

    class MockWs {
      on(event: string, cb: any) {
        if (event === 'error') {
          setTimeout(() => cb(new Error('Navigation connection error')), 0);
        }
      }
      send() {}
      close() {}
    }

    vi.spyOn(driver as any, 'createWebSocket').mockReturnValue(new MockWs());
    await expect(driver.openUrl('https://example.com')).rejects.toThrow('Navigation connection error');
  });

  it('rejects openUrl when navigation returns errorText', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    });

    class MockWs {
      on(event: string, cb: any) {
        if (event === 'open') {
          setTimeout(() => cb(), 0);
        }
      }
      send(payload: string) {
        const parsed = JSON.parse(payload);
        setTimeout(() => {
          this.messageCb(JSON.stringify({
            id: parsed.id,
            result: { errorText: 'net::ERR_NAME_NOT_RESOLVED' },
          }));
        }, 0);
      }
      messageCb: any;
      close() {}
    }

    const mockWs = new MockWs();
    mockWs.on = (event: string, cb: any) => {
      if (event === 'open') setTimeout(() => cb(), 0);
      if (event === 'message') mockWs.messageCb = cb;
    };

    vi.spyOn(driver as any, 'createWebSocket').mockReturnValue(mockWs);
    await expect(driver.openUrl('https://nonexistent.domain')).rejects.toThrow('Navigation failed: net::ERR_NAME_NOT_RESOLVED');
  });

  it('rejects executeScript when websocket closes before response', async () => {
    driver = new BrowserDriver();
    vi.spyOn(driver, 'getActiveTab').mockResolvedValue({
      id: 'tab-1',
      title: 'Home',
      url: 'https://example.com',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1',
    });

    class MockWs {
      on(event: string, cb: any) {
        if (event === 'close') {
          setTimeout(() => cb(), 0);
        }
      }
      send() {}
      close() {}
    }

    vi.spyOn(driver as any, 'createWebSocket').mockReturnValue(new MockWs());
    await expect((driver as any).executeScript('1 + 1')).rejects.toThrow('WebSocket connection closed before CDP response was received');
  });
});
