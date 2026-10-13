import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdpTransport } from './cdp-transport.js';
import { FastBrowserEngine } from './engine.js';
import { ChromeManager } from '../chrome-manager.js';
import type { BrowserPort } from './port.js';

/**
 * Drives a real Chromium browser through the DevTools transport (the same protocol Windows uses). Off unless
 * RH_LIVE_CDP=1; it starts its own headless browser with a throw-away profile and never touches the person's browser.
 */
const live = process.env.RH_LIVE_CDP === '1';
const PORT = 9341;

const PAGE = `<!doctype html><title>Live page</title><body>
<h1>Hello</h1>
<label>Name <input id="name" aria-label="Name"></label>
<button id="go" onclick="document.getElementById('out').textContent='Hi ' + document.getElementById('name').value">Greet</button>
<p id="out">nobody yet</p></body>`;

const refuse = (what: string) => async () => {
  throw new Error(`the slower path was used for ${what}`);
};
const legacy: BrowserPort = {
  tabs: refuse('tabs'), focus: refuse('focus'), open: refuse('open'), snapshot: refuse('snapshot'), click: refuse('click'),
  type: refuse('type'), find: refuse('find'), do: refuse('do'), extract: refuse('extract'),
};

describe.skipIf(!live)('CdpTransport against a real browser', () => {
  let server: http.Server;
  let chrome: ChildProcess | undefined;
  let profile: string;
  let url: string;
  const transport = new CdpTransport({ port: PORT });

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-live-cdp-'));
    const exe = process.env.RH_LIVE_CHROME ?? ChromeManager.findBrowserExecutable()?.path;
    if (!exe) throw new Error('no Chrome found; set RH_LIVE_CHROME');
    chrome = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], {
      stdio: 'ignore',
      // the test setup points HOME at a throw-away folder, which stops a browser from loading pages
      env: { ...process.env, HOME: os.userInfo().homedir },
    });
    for (let i = 0; i < 50; i++) {
      if ((await transport.environment()).running.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
      if (i === 49) throw new Error('the browser did not start');
    }
    // A browser that was just started takes a few seconds for its first network request: wait that out once.
    const b = { name: 'Google Chrome', family: 'chromium', aliases: [] } as const;
    await transport.openUrl(b, url);
    for (let i = 0; i < 100; i++) {
      if ((await transport.listTabs(b)).some((t) => t.active && t.url === url && t.title === 'Live page')) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 60_000);

  afterAll(() => {
    transport.dispose();
    chrome?.kill('SIGKILL');
    server?.close();
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  });

  it('opens a page, reads it, types, clicks and sees the result, without the slower path', async () => {
    const engine = new FastBrowserEngine({ transport, legacy });
    const opened = await engine.open(url);
    expect(opened).toContain('Greet');
    const nameId = /\[(\d+)\][^\n]*"?Name/.exec(opened)?.[1];
    const buttonId = /\[(\d+)\][^\n]*Greet/.exec(opened)?.[1];
    expect(nameId).toBeDefined();
    expect(buttonId).toBeDefined();
    await engine.type(Number(nameId), 'Ada');
    const after = await engine.click(Number(buttonId));
    expect(after).toContain('Hi Ada');
    expect(await engine.extract()).toContain('Hi Ada');
    expect(await engine.tabs()).toContain('Live page');
  }, 60_000);

  it('lists tabs with stable labels, opens a second tab and switches between them', async () => {
    const engine = new FastBrowserEngine({ transport, legacy });
    await engine.open(url);
    const second = await engine.open(`${url}?second=1`);
    expect(second).toContain('opened');
    const tabs = await engine.tabs();
    expect(tabs.split('\n').filter((l) => l.startsWith('[w')).length).toBeGreaterThanOrEqual(2);
    const first = await engine.focus(1);
    expect(first).toContain('focused');
  }, 60_000);

  it('keeps a query string and a fragment in the address it opens', async () => {
    const engine = new FastBrowserEngine({ transport, legacy });
    await engine.open(`${url}?a=1&b=two#frag`);
    const tabs = await transport.listTabs({ name: 'Google Chrome', family: 'chromium', aliases: [] });
    expect(tabs.some((t) => t.url === `${url}?a=1&b=two#frag`)).toBe(true);
  }, 60_000);

  it('says the tab is gone for an id that does not exist', async () => {
    const browser = { name: 'Google Chrome', family: 'chromium', aliases: [] } as const;
    await expect(transport.evaluate(browser, { windowId: '1', tabKey: 'does-not-exist' }, '1+1')).rejects.toMatchObject({ code: 'no_tab' });
  });
});
