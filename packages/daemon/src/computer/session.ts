import { classifyRiskyKey } from '@remote-hands/shared';
import type { IndexedElement } from '../desktop/ax-walker.js';
import { AxWalker } from '../desktop/ax-walker.js';
import { performAxActionDetailed } from '../desktop/ax-actions.js';
import { searchAndTriggerMenu } from '../desktop/menu-crawler.js';
import { MacOsDriver } from '../desktop/macos-driver.js';
import { BrowserDriver } from '../browser-driver.js';
import { FastBrowserEngine } from '../browser/engine.js';
import { AppleScriptTransport } from '../browser/transport.js';
import { createDefaultCdpTransport } from '../browser/default-cdp.js';
import { createAutoEnable } from '../browser/auto-enable.js';
import { LegacyBrowserPort } from '../browser/legacy-port.js';
import type { BrowserPort, DoStep } from '../browser/port.js';
import { compactDesktopElements } from './compact.js';
import type { ActionGate } from '../action-gate.js';
import type { View } from '../desktop/ax-model.js';
import { abandonAwareGate } from './call-scope.js';
import { DesktopEngine, type ClickAction, type ScrollDirection } from './desktop-engine.js';
import { AxHelperClient, axHelperEnabledByDefault } from '../desktop/ax-helper.js';
import { BLIND_NOTE, OCR_ID_BASE, looksBlind } from '../desktop/ocr-model.js';

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
  /** Asked before desktop clicks and menu items; rejecting stops the action (see ActionGate). */
  gate?: ActionGate;
  /** Fast native-app control (the rh-ax helper). Without it, or when it cannot serve, the slower reader is used. */
  engine?: DesktopEngine;
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
  /** Which reader produced the ids the model holds: the helper's, or the slower one's. */
  private mode: 'engine' | 'legacy' = 'legacy';

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
    this.mode = 'legacy';
    this.cache = { app, elements };
    return elements;
  }

  private async state(app?: string, before?: View | null): Promise<string> {
    const engine = this.deps.engine;
    // whatever the action did, the places read by sight before it can no longer be trusted
    engine?.dropOcr();
    if (engine) {
      const wait = this.deps.settleMs;
      const target = app ?? this.cache?.app ?? '';
      const text = await engine.settle(target, before === undefined ? (engine.current()?.view ?? null) : before, {
        ...(wait !== undefined ? { firstMs: wait, gapMs: wait } : {}),
        ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      });
      if (text !== null) {
        this.mode = 'engine';
        this.cache = { app: target || engine.current()?.app || '', elements: [] };
        return text;
      }
    }
    await this.settle();
    return compactDesktopElements(await this.walk(await this.resolveApp(app)));
  }

  private async safeState(app?: string, before?: View | null): Promise<string> {
    try {
      return await this.state(app, before);
    } catch (err) {
      return `(state unavailable: ${err instanceof Error ? err.message : String(err)}; call desktop_snapshot)`;
    }
  }

  async desktopSnapshot(app?: string, filter?: string, index?: number, ocr?: boolean): Promise<string> {
    const engine = this.deps.engine;
    if (ocr) return this.desktopSnapshotBySight(app, filter, index);
    if (index !== undefined) {
      this.rejectSightId('desktop_snapshot with index', index);
      // reading one part of the latest window: the ids it names came from the fast reader
      const fast = this.activeEngine('desktop_snapshot with index');
      this.snapshotApp(app);
      const text = await fast.snapshot('', { ...(filter ? { filter } : {}), index });
      if (text === null) throw new Error('desktop_snapshot with index needs the fast reader, which is not available right now. Take a full desktop_snapshot instead.');
      this.cache = { app: fast.current()?.app || this.cache?.app || '', elements: [] };
      return text;
    }
    if (engine) {
      engine.dropOcr();
      const text = await engine.snapshot(app ?? '', filter ? { filter } : {});
      if (text !== null) {
        this.mode = 'engine';
        this.cache = { app: app || engine.current()?.app || '', elements: [] };
        // A window that shows nothing to Accessibility says how to read it otherwise; nothing is read by sight until asked.
        const view = engine.current()?.view;
        return !filter && view && looksBlind(view) ? `${text}\n${BLIND_NOTE}` : text;
      }
    }
    const resolved = await this.resolveApp(app);
    const elements = await this.walk(resolved);
    const header = `app: ${resolved || '(frontmost)'}`;
    return `${header}\n${compactDesktopElements(elements, filter ? { filter } : {})}`;
  }

  /**
   * LAST RESORT: the Accessibility view of the window plus its text read by sight. Only when the model asks for it, because
   * a picture and Vision take about half a second against a few hundredths for Accessibility.
   */
  private async desktopSnapshotBySight(app?: string, filter?: string, index?: number): Promise<string> {
    if (index !== undefined) throw new Error('ocr reads the whole window: leave out index.');
    const engine = this.deps.engine;
    const unavailable = 'Reading a window by sight needs the fast reader (the accessibility helper), which is not available right now.';
    if (!engine) throw new Error(unavailable);
    // Accessibility goes first, as always: it gives the ids that work, and what is read by sight leaves out the same text.
    const ax = await engine.snapshot(app ?? '', filter ? { filter } : {});
    if (ax === null) throw new Error(unavailable);
    this.mode = 'engine';
    const front = engine.current()?.app || app || '';
    this.cache = { app: app || front, elements: [] };
    const sight = await engine.readOcr(app ?? '', filter ? { filter } : {});
    if (sight === null) throw new Error(unavailable);
    return `${ax}\n${sight}`;
  }

  /** Text read by sight can only be clicked: say so, instead of "not in last snapshot". */
  private rejectSightId(tool: string, index: number): void {
    if (index >= OCR_ID_BASE) {
      throw new Error(`[${index}] was read by sight, so ${tool} cannot use it: only desktop_click can. To type, click the field first, then call desktop_type without an index.`);
    }
  }

  /** The app of the latest snapshot, checked against the one the call names. */
  private snapshotApp(app?: string): string {
    if (!this.cache) throw new Error('No snapshot cached. Call desktop_snapshot first.');
    const cachedApp = this.cache.app;
    if (!cachedApp && !app) throw new Error('Snapshot app is unknown. Call desktop_snapshot with an explicit app.');
    if (app && cachedApp && app.toLowerCase() !== cachedApp.toLowerCase()) {
      throw new Error(`Last snapshot was of ${cachedApp}, not ${app}. Call desktop_snapshot for ${app} first.`);
    }
    return cachedApp || app || '';
  }

  /** The helper's engine when the ids the model holds came from it. */
  private activeEngine(tool: string): DesktopEngine {
    if (this.deps.engine && this.mode === 'engine') return this.deps.engine;
    throw new Error(`${tool} needs the fast reader, which is not available right now. Take a desktop_snapshot and use desktop_click or desktop_key instead.`);
  }

  private describeItem(index: number, role: string, label: string): string {
    return `[${index}] ${role === 'hint' ? 'scroll area' : role}${label ? ` "${label}"` : ''}`;
  }

  async desktopClick(index: number, app?: string, action: ClickAction = 'press'): Promise<string> {
    const targetApp = this.snapshotApp(app);
    if (index >= OCR_ID_BASE) return this.desktopClickBySight(index, targetApp, action);
    if (this.mode === 'engine' && this.deps.engine) {
      const engine = this.deps.engine;
      const item = engine.item(index);
      const before = engine.current()?.view ?? null;
      await this.deps.gate?.(item.gateLabel);
      const result = await engine.click(index, action);
      const verb = action === 'press' ? 'clicked' : action === 'open' ? 'opened' : action === 'menu' ? 'opened the menu of' : action === 'double' ? 'double-clicked' : 'right-clicked';
      return `${verb} ${this.describeItem(item.id, item.role, item.label)}${result.method === 'click' && action === 'press' ? '\nnote: no native press on this element; clicked at its center' : ''}\n${await this.safeState(targetApp, before)}`;
    }
    if (action !== 'press') throw new Error(`desktop_click action "${action}" needs the fast reader, which is not available right now. Use the default press.`);
    const element = this.cache!.elements.find((e) => e.index === index);
    if (!element) throw new Error(`Index ${index} not in last snapshot. Call desktop_snapshot again.`);
    const described = `[${element.index}] ${element.role.replace(/^AX/, '')} "${element.label}"`;
    await this.deps.gate?.(element.label);
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

  /** A click on text that was read by sight: judged by its words like any click, then the window is read again so the model keeps its sight. */
  private async desktopClickBySight(index: number, targetApp: string, action: ClickAction): Promise<string> {
    const engine = this.deps.engine;
    if (!engine || this.mode !== 'engine') throw new Error('Text read by sight can only be clicked with the fast reader, which is not available right now. Take a desktop_snapshot again.');
    const item = engine.ocrItem(index);
    const before = engine.current()?.view ?? null;
    await this.deps.gate?.(item.text);
    await engine.clickOcr(index, action);
    const verb = action === 'press' ? 'clicked' : action === 'open' ? 'opened' : action === 'menu' ? 'opened the menu of' : action === 'double' ? 'double-clicked' : 'right-clicked';
    const changed = await this.safeState(targetApp, before);
    let sight: string;
    try {
      // the window was drawn again by the click; what is shown now is read by sight again so the next click has fresh places
      sight = (await engine.readOcr(targetApp, {})) ?? 'note: could not read the window by sight afterwards; call desktop_snapshot with ocr=true';
    } catch (err) {
      sight = `note: could not read the window by sight afterwards (${err instanceof Error ? err.message : String(err)}); call desktop_snapshot with ocr=true`;
    }
    return `${verb} [${item.id}] text "${item.text.replace(/"/g, "'")}" (read by sight)\n${changed}\n${sight}`;
  }

  async desktopType(text: string, app?: string, opts: { index?: number; replace?: boolean; submit?: boolean } = {}): Promise<string> {
    const { index, replace, submit } = opts;
    if (index === undefined) {
      if (replace) throw new Error('replace needs an index: say which field to replace.');
      await this.deps.desktop.typeText(text);
      if (submit) await this.deps.desktop.sendKeyCombo(['return'], []);
      return `typed ${text.length} characters${submit ? ' and pressed Return' : ''}\n${await this.safeState(app ?? (this.cache?.app || undefined))}`;
    }
    this.rejectSightId('desktop_type', index);
    const targetApp = this.snapshotApp(app);
    const engine = this.activeEngine('desktop_type with an index');
    const item = engine.item(index);
    if (!item.editable) throw new Error(`[${item.id}] ${item.role} is not a text field. Click it first, then type without an index.`);
    const before = engine.current()?.view ?? null;
    // writing into a labelled field, and submitting it, are judged by the field's full label like a click
    if (replace || submit) await this.deps.gate?.(item.gateLabel);
    let how = 'typed into';
    if (replace) {
      const done = await engine.setValue(item.id, text);
      if (done.set) {
        how = 'set';
      } else {
        // the field would not take the value directly: select everything in it and type over it
        await engine.focus(item.id);
        await engine.pressKey('selectAll', item.id);
        await engine.typeText(text, item.id);
        how = 'replaced';
      }
    } else {
      await engine.focus(item.id);
      await engine.typeText(text, item.id);
    }
    if (submit) {
      // the field must have the cursor, whichever way the text got in
      await engine.focus(item.id);
      await engine.pressKey('return', item.id);
    }
    const what = `${[...text].length} characters`;
    return `${how} [${item.id}] ${item.role}${item.label ? ` "${item.label}"` : ''}: ${what}${submit ? ', pressed Return' : ''}\n${await this.safeState(targetApp, before)}`;
  }

  async desktopScroll(index: number, direction: ScrollDirection, amount: number, app?: string): Promise<string> {
    this.rejectSightId('desktop_scroll', index);
    const targetApp = this.snapshotApp(app);
    const engine = this.activeEngine('desktop_scroll');
    const item = engine.item(index);
    const before = engine.current()?.view ?? null;
    const moved = await engine.scroll(index, direction, amount);
    const pct = (n: number): string => `${Math.round(n * 100)}%`;
    const note =
      moved.before !== undefined && moved.after !== undefined
        ? Math.abs(moved.after - moved.before) < 0.001
          ? ' (nothing moved: already at the end)'
          : ` (${pct(moved.before)} -> ${pct(moved.after)} of the way down)`
        : '';
    return `scrolled ${direction} in ${this.describeItem(item.id, item.role, item.label)}${note}\n${await this.safeState(targetApp, before)}`;
  }

  async desktopRead(index: number, maxChars?: number, app?: string): Promise<string> {
    this.rejectSightId('desktop_read', index);
    this.snapshotApp(app);
    const engine = this.activeEngine('desktop_read');
    const item = engine.item(index);
    if (item.secure) throw new Error('That is a password field; its contents are never read.');
    const got = await engine.readText(item.id, maxChars);
    const body = got.text || '(empty)';
    return `${this.describeItem(item.id, item.role, item.label)}${got.truncated ? ' (cut short)' : ''}\n${body}${got.selected ? `\nselected: ${got.selected}` : ''}`;
  }

  async desktopDrag(fromIndex: number, toIndex: number, app?: string): Promise<string> {
    this.rejectSightId('desktop_drag', fromIndex);
    this.rejectSightId('desktop_drag', toIndex);
    const targetApp = this.snapshotApp(app);
    const engine = this.activeEngine('desktop_drag');
    const from = engine.item(fromIndex);
    const to = engine.item(toIndex);
    const before = engine.current()?.view ?? null;
    await this.deps.gate?.(`drag ${from.gateLabel} to ${to.gateLabel}`);
    await engine.drag(fromIndex, toIndex);
    return `dragged ${this.describeItem(from.id, from.role, from.label)} to ${this.describeItem(to.id, to.role, to.label)}\n${await this.safeState(targetApp, before)}`;
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
    const kind = classifyRiskyKey(combo);
    if (kind) await this.deps.gate?.(combo, { kind });
    await this.deps.desktop.sendKeyCombo([key], modifiers);
    return `pressed ${combo}\n${await this.safeState(app ?? (this.cache?.app || undefined))}`;
  }

  async desktopOpen(app: string): Promise<string> {
    await this.deps.desktop.openApp(app);
    await this.deps.desktop.focusWindow(app).catch(() => {});
    return `opened ${app}\n${await this.safeState(app)}`;
  }

  async desktopMenu(app: string, query: string): Promise<string> {
    const res = await this.deps.menuSearch(app, query, undefined, this.deps.gate);
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

  browserSnapshot(opts?: { text?: boolean }): Promise<string> {
    return opts === undefined ? this.deps.browser.snapshot() : this.deps.browser.snapshot(opts);
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

/** The fast reader for native apps: macOS only, off with RH_AX_HELPER=0; the helper is built in the background on first use. */
export function createDefaultDesktopEngine(): DesktopEngine | undefined {
  if (!axHelperEnabledByDefault(process.env, process.platform)) return undefined;
  return new DesktopEngine(new AxHelperClient());
}

export function createDefaultComputerSession(rawGate?: ActionGate): ComputerSession {
  // An approval that arrives after the tool call timed out must not let the action run (legacy driver included).
  const gate = rawGate ? abandonAwareGate(rawGate) : undefined;
  const desktop = new MacOsDriver();
  // Mac: the person's own browsers through AppleScript. Elsewhere: a Chrome-family browser through its DevTools port.
  const mac = process.platform === 'darwin';
  const transport = mac ? new AppleScriptTransport() : createDefaultCdpTransport();
  const engine = createDefaultDesktopEngine();
  return new ComputerSession({
    desktop,
    walker: new AxWalker({ driver: desktop }),
    axAction: performAxActionDetailed,
    menuSearch: searchAndTriggerMenu,
    browser: new FastBrowserEngine({
      transport,
      legacy: new LegacyBrowserPort({
        driver: new BrowserDriver({ cdpUrl: process.env.BU_CDP_URL || 'http://127.0.0.1:9222', gate }),
      }),
      ...(mac ? { autoEnable: createAutoEnable({ transport: transport as AppleScriptTransport }) } : {}),
      ...(gate ? { gate } : {}),
    }),
    ...(gate ? { gate } : {}),
    ...(engine ? { engine } : {}),
  });
}
