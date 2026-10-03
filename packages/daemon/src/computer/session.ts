import type { IndexedElement } from '../desktop/ax-walker.js';
import { AxWalker } from '../desktop/ax-walker.js';
import { performAxAction } from '../desktop/ax-actions.js';
import { searchAndTriggerMenu } from '../desktop/menu-crawler.js';
import { MacOsDriver } from '../desktop/macos-driver.js';
import { BrowserDriver } from '../browser-driver.js';
import { capLines, compactDesktopElements } from './compact.js';

export interface ComputerSessionDeps {
  desktop: Pick<
    MacOsDriver,
    'openApp' | 'focusWindow' | 'clickAt' | 'typeText' | 'sendKeyCombo' | 'listWindows'
  >;
  walker: Pick<AxWalker, 'walkActiveApp'>;
  axAction: typeof performAxAction;
  menuSearch: typeof searchAndTriggerMenu;
  browser: Pick<BrowserDriver, 'listTabs' | 'focusTab' | 'openUrl' | 'snapshot' | 'clickIndex' | 'typeIndex'>;
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

const BROWSER_MAX_LINES = 120;

export class ComputerSession {
  private cache: { app: string; elements: IndexedElement[] } | null = null;

  constructor(private readonly deps: ComputerSessionDeps) {}

  private async settle(): Promise<void> {
    const ms = this.deps.settleMs ?? 150;
    if (ms > 0) await (this.deps.sleep ?? ((n) => new Promise((r) => setTimeout(r, n))))(ms);
  }

  private async walk(app?: string): Promise<IndexedElement[]> {
    const elements = await this.deps.walker.walkActiveApp(app, { allowOcr: false });
    this.cache = { app: app ?? '', elements };
    return elements;
  }

  private async state(app?: string): Promise<string> {
    await this.settle();
    return compactDesktopElements(await this.walk(app));
  }

  async desktopSnapshot(app?: string, filter?: string): Promise<string> {
    const elements = await this.walk(app);
    const header = `app: ${app ?? '(frontmost)'}`;
    return `${header}\n${compactDesktopElements(elements, filter ? { filter } : {})}`;
  }

  async desktopClick(index: number, app?: string): Promise<string> {
    if (!this.cache) throw new Error('No snapshot cached. Call desktop_snapshot first.');
    const element = this.cache.elements.find((e) => e.index === index);
    if (!element) throw new Error(`Index ${index} not in last snapshot. Call desktop_snapshot again.`);
    const targetApp = app ?? this.cache.app;
    const described = `[${element.index}] ${element.role.replace(/^AX/, '')} "${element.label}"`;
    const pressed = await this.deps.axAction(
      targetApp,
      { index: element.index, bounds: element.bounds, role: element.role, label: element.label },
      'AXPress',
    );
    let note = '';
    if (!pressed) {
      const [x, y, w, h] = element.bounds;
      const cx = Math.round(x + w / 2);
      const cy = Math.round(y + h / 2);
      await this.deps.desktop.clickAt(cx, cy);
      note = `\nnote: AX press failed; used physical click at ${cx},${cy}`;
    }
    return `clicked ${described}${note}\n${await this.state(targetApp || undefined)}`;
  }

  async desktopType(text: string, app?: string): Promise<string> {
    await this.deps.desktop.typeText(text);
    return `typed ${text.length} characters\n${await this.state(app ?? (this.cache?.app || undefined))}`;
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
    return `pressed ${combo}\n${await this.state(app ?? (this.cache?.app || undefined))}`;
  }

  async desktopOpen(app: string): Promise<string> {
    await this.deps.desktop.openApp(app);
    await this.deps.desktop.focusWindow(app).catch(() => {});
    return `opened ${app}\n${await this.state(app)}`;
  }

  async desktopMenu(app: string, query: string): Promise<string> {
    const res = await this.deps.menuSearch(app, query);
    if (!res.success) throw new Error(res.error ?? `No menu item matching "${query}" in ${app}`);
    return `menu ${(res.triggeredPath ?? []).join(' > ')}\n${await this.state(app)}`;
  }

  async desktopWindows(): Promise<string> {
    const wins = await this.deps.desktop.listWindows();
    return wins.map((w) => `${w.app} - ${w.title}`).join('\n') || '(no windows)';
  }

  async browserTabs(): Promise<string> {
    const tabs = await this.deps.browser.listTabs();
    return tabs
      .map((t) => `[w${t.windowIndex ?? 1}-t${t.tabIndex ?? '?'}] ${t.active ? '(active) ' : ''}${t.title} - ${t.url}`)
      .join('\n');
  }

  async browserFocus(target: string | number): Promise<string> {
    const res = await this.deps.browser.focusTab(target);
    return `focused ${res.tab.title} - ${res.tab.url}\n${await this.browserSnapshot()}`;
  }

  async browserOpen(url: string): Promise<string> {
    const res = await this.deps.browser.openUrl(url);
    return `opened ${res.url}\n${await this.browserSnapshot()}`;
  }

  async browserSnapshot(): Promise<string> {
    const snap = await this.deps.browser.snapshot();
    return capLines(snap.formattedTable, BROWSER_MAX_LINES);
  }

  async browserClick(index: number): Promise<string> {
    const res = await this.deps.browser.clickIndex(index);
    await this.settle();
    return `clicked [${index}] ${res.label}\n${await this.browserSnapshot()}`;
  }

  async browserType(index: number, text: string): Promise<string> {
    const res = await this.deps.browser.typeIndex(index, text);
    await this.settle();
    return `typed into [${index}] ${res.label}\n${await this.browserSnapshot()}`;
  }
}

export function createDefaultComputerSession(): ComputerSession {
  const desktop = new MacOsDriver();
  return new ComputerSession({
    desktop,
    walker: new AxWalker({ driver: desktop }),
    axAction: performAxAction,
    menuSearch: searchAndTriggerMenu,
    browser: new BrowserDriver({ cdpUrl: process.env.BU_CDP_URL || 'http://127.0.0.1:9222' }),
  });
}
