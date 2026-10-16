import type { BrowserDriver } from '../browser-driver.js';
import { capLines } from '../computer/compact.js';
import { buildActionScript, buildExtractScript } from './page-scripts.js';
import { normalizeOpenUrl } from './engine.js';
import { clean } from './render.js';
import { okSoFar, type BrowserPort, type DoStep } from './port.js';
import { extractWindow, renderExtract } from './extract.js';
import { ABANDONED, isCallAborted } from '../computer/call-scope.js';

export type LegacyBrowserDriver = Pick<
  BrowserDriver,
  'listTabs' | 'focusTab' | 'openUrl' | 'snapshot' | 'clickIndex' | 'typeIndex'
> &
  Partial<Pick<BrowserDriver, 'executeScript'>>;

const MAX_LINES = 120;
const MAX_STEPS = 30;
const MAX_TOTAL_WAIT_MS = 30_000;
const BATCH_DEADLINE_MS = 60_000;
const LEGACY_OPS = new Set(['click', 'type', 'wait']);

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Script results may arrive as JSON text or already decoded. */
function decode(v: unknown): Record<string, unknown> {
  let o = v;
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v);
    } catch {
      throw new Error(`unexpected page result: ${v.slice(0, 80)}`);
    }
  }
  if (!o || typeof o !== 'object') throw new Error(`unexpected page result: ${String(v).slice(0, 80)}`);
  return o as Record<string, unknown>;
}

/**
 * BrowserPort over the existing CDP/AppleScript BrowserDriver with exactly the browser
 * behaviour ComputerSession had before the fast engine (tab lines, 120-line snapshots,
 * `clicked [i] label` / `typed into [i] label` results).
 */
export class LegacyBrowserPort implements BrowserPort {
  private readonly driver: LegacyBrowserDriver;
  private readonly settleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: { driver: LegacyBrowserDriver; settleMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }) {
    this.now = deps.now ?? Date.now;
    this.driver = deps.driver;
    this.settleMs = deps.settleMs ?? 150;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async settle(): Promise<void> {
    if (this.settleMs > 0) await this.sleep(this.settleMs);
  }

  private async safeState(): Promise<string> {
    try {
      return await this.snapshot();
    } catch (err) {
      return `(state unavailable: ${err instanceof Error ? err.message : String(err)}; call browser_snapshot)`;
    }
  }

  async tabs(): Promise<string> {
    const tabs = await this.driver.listTabs();
    return tabs
      .map((t) => `[w${t.windowIndex ?? 1}-t${t.tabIndex ?? '?'}] ${t.active ? '(active) ' : ''}${t.title} - ${t.url}`)
      .join('\n');
  }

  async focus(target: string | number): Promise<string> {
    const res = await this.driver.focusTab(target);
    return `focused ${res.tab.title} - ${res.tab.url}\n${await this.snapshot()}`;
  }

  async open(rawUrl: string): Promise<string> {
    const url = normalizeOpenUrl(rawUrl);
    const res = await this.driver.openUrl(url);
    return `opened ${res.url}\n${await this.snapshot()}`;
  }

  async snapshot(_opts?: { text?: boolean }): Promise<string> {
    const snap = await this.driver.snapshot();
    return capLines(snap.formattedTable, MAX_LINES);
  }

  async click(index: number): Promise<string> {
    const res = await this.driver.clickIndex(index);
    await this.settle();
    return `clicked [${index}] ${res.label}\n${await this.safeState()}`;
  }

  async type(index: number, text: string, opts: { submit?: boolean } = {}): Promise<string> {
    if (opts.submit && !this.driver.executeScript) throw new Error('submit is not supported on the legacy path');
    const res = await this.driver.typeIndex(index, text);
    if (opts.submit) await this.pressEnter();
    await this.settle();
    return `typed into [${index}] ${res.label}\n${await this.safeState()}`;
  }

  private async pressEnter(): Promise<void> {
    const run = this.driver.executeScript;
    if (!run) throw new Error('submit is not supported on the legacy path');
    const res = decode(await run.call(this.driver, buildActionScript({ op: 'press', key: 'Enter' })));
    if (res.ok !== true) throw new Error(typeof res.message === 'string' ? res.message : 'pressing Enter failed');
  }

  async find(query: string, limit = 8): Promise<string> {
    const snap = await this.driver.snapshot();
    const lines = snap.formattedTable.split('\n').filter((l) => l.startsWith('['));
    const tokens = words(query);
    const scored = lines
      .map((line, i) => {
        const hay = words(line);
        const hits = tokens.filter((t) => hay.some((w) => w.startsWith(t))).length;
        return { line, i, score: hits === 0 ? 0 : hits + (hits === tokens.length ? 100 : 0) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, Math.max(0, limit));
    if (scored.length > 0) {
      return [`found ${scored.length} of ${lines.length} elements for "${clean(query)}":`, ...scored.map((s) => s.line)].join('\n');
    }
    const first = lines.slice(0, Math.max(0, limit));
    return [`no match for "${clean(query)}"; first ${first.length} of ${lines.length} elements:`, ...first].join('\n');
  }

  async extract(maxChars?: number, offset?: number): Promise<string> {
    const run = this.driver.executeScript;
    if (!run) throw new Error('extract is not supported on the legacy path');
    const win = extractWindow(maxChars, offset);
    return renderExtract(decode(await run.call(this.driver, buildExtractScript(win.limit))), win);
  }

  async do(steps: DoStep[]): Promise<string> {
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('browser_do needs at least one step. No steps were run.');
    if (steps.length > MAX_STEPS) {
      throw new Error(`browser_do accepts at most ${MAX_STEPS} steps (got ${steps.length}). No steps were run.`);
    }
    let totalWait = 0;
    steps.forEach((step, i) => {
      const invalid = (reason: string): Error =>
        new Error(`step ${i + 1} ${String(step?.op)} invalid: ${reason}. No steps were run.`);
      if (!LEGACY_OPS.has(step?.op)) throw invalid('not supported on the legacy path');
      if (step.target !== undefined) throw invalid('target is not supported on the slower fallback; use index from browser_snapshot');
      if (step.op === 'wait') {
        if (typeof step.ms !== 'number' || !(step.ms >= 0 && step.ms <= 5000)) throw invalid('ms must be between 0 and 5000');
        totalWait += step.ms;
        if (totalWait > MAX_TOTAL_WAIT_MS) throw invalid(`waits add up to more than ${MAX_TOTAL_WAIT_MS} ms per call`);
        return;
      }
      if (typeof step.index !== 'number' || !Number.isInteger(step.index)) throw invalid('index is required');
      if (step.op === 'type') {
        if (typeof step.text !== 'string') throw invalid('text is required');
        if (step.submit && !this.driver.executeScript) throw invalid('submit is not supported on the legacy path');
      }
    });
    const done: string[] = [];
    const deadline = this.now() + BATCH_DEADLINE_MS;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!;
      const n = i + 1;
      try {
        if (isCallAborted()) throw new Error(`${ABANDONED}; remaining steps not run`);
        if (this.now() > deadline) throw new Error('this call ran out of time (60 s); remaining steps not run');
        if (step.op === 'wait') {
          await this.sleep(step.ms ?? 0);
        } else if (step.op === 'click') {
          const res = await this.driver.clickIndex(step.index!);
          if (!res.success) throw new Error(`could not click [${step.index}]`);
        } else {
          const res = await this.driver.typeIndex(step.index!, step.text ?? '');
          if (!res.success) throw new Error(`could not type into [${step.index}]`);
          if (step.submit) await this.pressEnter();
        }
      } catch (err) {
        throw new Error(`step ${n} ${step.op} failed: ${err instanceof Error ? err.message : String(err)} (${okSoFar(n)})`);
      }
      done.push(step.op);
    }
    await this.settle();
    return `did: ${done.join(', ')}\n${await this.safeState()}`;
  }
}
