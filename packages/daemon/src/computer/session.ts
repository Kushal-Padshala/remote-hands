import type { IndexedElement } from '../desktop/ax-walker.js';
import { AxWalker } from '../desktop/ax-walker.js';
import { performAxActionDetailed } from '../desktop/ax-actions.js';
import { searchAndTriggerMenu } from '../desktop/menu-crawler.js';
import { MacOsDriver } from '../desktop/macos-driver.js';
import { BrowserDriver } from '../browser-driver.js';
import { FastBrowserEngine } from '../browser/engine.js';
import { AppleScriptTransport } from '../browser/transport.js';
import { LegacyBrowserPort } from '../browser/legacy-port.js';
import type { BrowserPort, DoStep } from '../browser/port.js';
import { compactDesktopElements } from './compact.js';

export interface ComputerSessionDeps {
  desktop: Pick<
    MacOsDriver,
    'openApp' | 'focusWindow' | 'typeText' | 'sendKeyCombo' | 'listWindows' | 'getActiveWindowContext'
  >;
  walker: Pick<AxWalker, 'walkActiveApp'>;
  axAction: typeof performAxActionDetailed;
  menuSearch: typeof searchAndTriggerMenu;
  browser: BrowserPort;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MODIFIER_NAMES: Record<string, string> = {
  cmd: 'command',
  command: 'command',
  shift: 'shift',
  alt: 'option',
  opt: 'option',
  option: 'option',
  ctrl: 'control',
  control: 'control',
};

export class ComputerSession {
  private cache: { app: string; elements: IndexedElement[] } | null = null;

  constructor(private readonly deps: ComputerSessionDeps) {}

  private async settle(): Promise<void> {
    const ms = this.deps.settleMs ?? 150;
    if (ms > 0) await (this.deps.sleep ?? ((n) => new Promise((r) => setTimeout(r, n))))(ms);
  }

  private async resolveApp(app?: string): Promise<string> {
    if (app) return app;
    try {
      const ctx = await this.deps.desktop.getActiveWindowContext();
      return ctx.app || '';
    } catch {
      return '';
    }
  }

  private async walk(app: string): Promise<IndexedElement[]> {
    const elements = await this.deps.walker.walkActiveApp(app || undefined, { allowOcr: false });
    this.cache = { app, elements };
    return elements;
  }

  private async state(app?: string): Promise<string> {
    await this.settle();
    return compactDesktopElements(await this.walk(await this.resolveApp(app)));
  }

  private async safeState(app?: string): Promise<string> {
    try {
      return await this.state(app);
    } catch (err) {
      return `(state unavailable: ${err instanceof Error ? err.message : String(err)}; call desktop_snapshot)`;
    }
  }

  async desktopSnapshot(app?: string, filter?: string): Promise<string> {
    const resolved = await this.resolveApp(app);
    const elements = await this.walk(resolved);
    const header = `app: ${resolved || '(frontmost)'}`;
    return `${header}\n${compactDesktopElements(elements, filter ? { filter } : {})}`;
  }

  async desktopClick(index: number, app?: string): Promise<string> {
    if (!this.cache) throw new Error('No snapshot cached. Call desktop_snapshot first.');
    const cachedApp = this.cache.app;
    if (!cachedApp && !app) throw new Error('Snapshot app is unknown. Call desktop_snapshot with an explicit app.');
    if (app && cachedApp && app.toLowerCase() !== cachedApp.toLowerCase()) {
      throw new Error(`Last snapshot was of ${cachedApp}, not ${app}. Call desktop_snapshot for ${app} first.`);
    }
    const element = this.cache.elements.find((e) => e.index === index);
    if (!element) throw new Error(`Index ${index} not in last snapshot. Call desktop_snapshot again.`);
    const targetApp = cachedApp || app || '';
    const described = `[${element.index}] ${element.role.replace(/^AX/, '')} "${element.label}"`;
    const result = await this.deps.axAction(
      targetApp,
      // Strict matching ignores the label, so none is sent (keeps it out of the Swift script/cache key).
      { bounds: element.bounds, role: element.role, label: '', strict: true },
      'AXPress',
    );
    if (!result.success) {
      if (/not found/i.test(result.error ?? '')) {
        throw new Error(`Element [${element.index}] no longer present. Call desktop_snapshot again.`);
      }
      throw new Error(
        `AX press failed for [${element.index}] (${result.error ?? 'unknown error'}). Call desktop_snapshot and retry.`,
      );
    }
    const note =
      result.method === 'cgevent'
        ? '\nnote: AX press unsupported on this element; used a physical click at its center'
        : '';
    return `clicked ${described}${note}\n${await this.safeState(targetApp)}`;
  }

  async desktopType(text: string, app?: string): Promise<string> {
    await this.deps.desktop.typeText(text);
    return `typed ${text.length} characters\n${await this.safeState(app ?? (this.cache?.app || undefined))}`;
  }

  async desktopKey(combo: string, app?: string): Promise<string> {
    const parts = combo
      .toLowerCase()
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean);
    const key = parts.pop();
    if (!key) throw new Error(`Invalid key combo "${combo}"`);
    const modifiers = parts.map((p) => {
      const mapped = MODIFIER_NAMES[p];
      if (!mapped) throw new Error(`Unknown modifier "${p}" in "${combo}"`);
      return mapped;
    });
    await this.deps.desktop.sendKeyCombo([key], modifiers);
    return `pressed ${combo}\n${await this.safeState(app ?? (this.cache?.app || undefined))}`;
  }

  async desktopOpen(app: string): Promise<string> {
    await this.deps.desktop.openApp(app);
    await this.deps.desktop.focusWindow(app).catch(() => {});
    return `opened ${app}\n${await this.safeState(app)}`;
  }

  async desktopMenu(app: string, query: string): Promise<string> {
    const res = await this.deps.menuSearch(app, query);
    if (!res.success) throw new Error(res.error ?? `No menu item matching "${query}" in ${app}`);
    return `menu ${(res.triggeredPath ?? []).join(' > ')}\n${await this.safeState(app)}`;
  }

  async desktopWindows(): Promise<string> {
    const wins = await this.deps.desktop.listWindows();
    return wins.map((w) => `${w.app} - ${w.title}`).join('\n') || '(no windows)';
  }

  browserTabs(): Promise<string> {
    return this.deps.browser.tabs();
  }

  browserFocus(target: string | number): Promise<string> {
    return this.deps.browser.focus(target);
  }

  browserOpen(url: string): Promise<string> {
    return this.deps.browser.open(url);
  }

  browserSnapshot(): Promise<string> {
    return this.deps.browser.snapshot();
  }

  browserClick(index: number): Promise<string> {
    return this.deps.browser.click(index);
  }

  browserType(index: number, text: string, submit?: boolean): Promise<string> {
    return this.deps.browser.type(index, text, submit === undefined ? undefined : { submit });
  }

  browserFind(query: string, limit?: number): Promise<string> {
    return this.deps.browser.find(query, limit);
  }

  browserDo(steps: DoStep[]): Promise<string> {
    return this.deps.browser.do(steps);
  }

  browserExtract(maxChars?: number): Promise<string> {
    return this.deps.browser.extract(maxChars);
  }
}

export function createDefaultComputerSession(): ComputerSession {
  const desktop = new MacOsDriver();
  return new ComputerSession({
    desktop,
    walker: new AxWalker({ driver: desktop }),
    axAction: performAxActionDetailed,
    menuSearch: searchAndTriggerMenu,
    browser: new FastBrowserEngine({
      transport: new AppleScriptTransport(),
      legacy: new LegacyBrowserPort({
        driver: new BrowserDriver({ cdpUrl: process.env.BU_CDP_URL || 'http://127.0.0.1:9222' }),
      }),
    }),
  });
}
