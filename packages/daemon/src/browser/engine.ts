import { pickTargetBrowser, type BrowserApp } from './browsers.js';
import { BrowserAutomationError, type TabTarget } from './applescript.js';
import type { AppleScriptTransport, TabInfo } from './transport.js';
import {
  buildActionScript,
  buildExtractScript,
  buildNavigateScript,
  buildReadyProbe,
  buildSnapshotCall,
  buildSnapshotWithProbe,
  type PageOp,
  type PageOpResult,
} from './page-scripts.js';
import { clean, findElements, normalizeSnapshot, renderDelta, renderElement, renderFull, type PageElement, type PageState } from './render.js';
import { okSoFar, type BrowserPort, type DoStep } from './port.js';

export type BrowserTransportLike = Pick<
  AppleScriptTransport,
  'environment' | 'evaluate' | 'listTabs' | 'focusTab' | 'openUrl'
>;

export interface FastBrowserEngineDeps {
  transport: BrowserTransportLike;
  legacy: BrowserPort;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Ctx {
  browser: BrowserApp;
  target: TabTarget | null;
}

/** `origin` is the snapshotted document's performance.timeOrigin (identity guard for actions). */
type FastShown = { mode: 'fast'; state: PageState; origin: number | string | null; targetConcrete: boolean } & Ctx;
type Shown = FastShown | { mode: 'legacy' };

type Resolved = { kind: 'fast'; ctx: Ctx } | { kind: 'legacy'; reason: string | null };

const ENV_TTL_MS = 1000;
const PIN_TTL_MS = 5 * 60_000;
const DISABLE_MS = 60_000;
const FIRST_PROBE_MS = 80;
const PROBE_EVERY_MS = 120;
const STABLE_CAP_MS = 3000;
const MAX_PROBES = 30;
const PROBE_TIMEOUT_MS = 2000;
const MAX_STEPS = 15;
const INDEX_OPS = new Set<DoStep['op']>(['click', 'type', 'select', 'check']);
const ALL_OPS = new Set<string>(['click', 'type', 'select', 'check', 'press', 'scroll', 'wait']);
const STILL_LOADING = 'note: page still loading';
const FIND_MAX_OPTIONS = 40;
const STILL_NAVIGATING = 'note: page is still navigating';
const NAV_PROBE_DELAY_MS = 80;
const FAIL_SETTLE_MS = 150;

interface Probe {
  u: string;
  r: string;
  t: string;
  o: number | string | null;
  p: boolean;
}
/** The value the snapshot shows for password fields. */
const PASSWORD_MASK = '•'.repeat(8);
const UNCONFIRMED = 'note: could not confirm the state change';
const NO_CHANGE_NOTE = 'note: no change detected';
const CONFIRM_DELAY_MS = 150;
/**
 * Whether an action may start a navigation late and needs one confirmation read when it
 * shows no change: 'note' (link/button click: say when nothing happened), 'quiet' (submit
 * or Enter), null (never).
 */
type Confirm = 'note' | 'quiet' | null;

function clickConfirm(el: PageElement): Confirm {
  return el.role === 'link' || el.role === 'button' ? 'note' : null;
}

/** Url without its hash (hash-only changes are in-page navigation). */
function withoutHash(url: string): string {
  const i = url.indexOf('#');
  return i >= 0 ? url.slice(0, i) : url;
}

/** A probe shows a different document: pending unload, new origin, or a new path/query. */
/** Same page for `open`: trailing slashes ignored; the tab's hash is ignored when `wanted` has none. */
function sameUrl(tabUrl: string, wanted: string): boolean {
  const norm = (u: string): string => {
    try {
      const p = new URL(u);
      return `${p.protocol}//${p.host}${p.pathname.replace(/\/+$/, '')}${p.search}${p.hash}`;
    } catch {
      return u;
    }
  };
  const a = wanted.includes('#') ? tabUrl : withoutHash(tabUrl);
  return norm(a) === norm(wanted);
}

function navigatedAway(p: Probe, startUrl: string | null, origin: number | string | null): boolean {
  if (p.p) return true;
  if (origin !== null && p.o !== null && String(p.o) !== String(origin)) return true;
  return startUrl !== null && p.u !== '' && withoutHash(p.u) !== withoutHash(startUrl);
}

/** The active tab of the lowest-index (front) window. */
function frontTab(tabs: TabInfo[]): TabInfo | undefined {
  let front: TabInfo | undefined;
  for (const tab of tabs) if (tab.active && (!front || tab.windowIndex < front.windowIndex)) front = tab;
  return front;
}

function tabId(t: { windowId: string; tabKey: string }): string {
  return `${t.windowId}:${t.tabKey}`;
}

const FOLLOWING_NOTE = 'note: following your current tab';

/** A snapshot result as page state plus its document origin; `{error}` throws. */
function snapshotOf(raw: unknown): { state: PageState; origin: number | string | null } {
  if (raw && typeof raw === 'object' && 'error' in raw) {
    const msg = (raw as { error: unknown }).error;
    throw new Error(typeof msg === 'string' ? msg : 'snapshot failed');
  }
  const key = raw && typeof raw === 'object' ? (raw as { page_key?: unknown }).page_key : undefined;
  const first = Array.isArray(key) ? key[0] : undefined;
  const origin = typeof first === 'number' || typeof first === 'string' ? first : null;
  return { state: normalizeSnapshot(raw), origin };
}

function parseProbe(v: unknown): Probe | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const origin = typeof o.o === 'number' || typeof o.o === 'string' ? o.o : null;
  return { u: String(o.u ?? ''), r: String(o.r ?? ''), t: String(o.t ?? ''), o: origin, p: o.p === true };
}

/** Parses a page-script result (always a JSON string); anything else is a clear error. */
function parsePage(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`unexpected page result: ${text.slice(0, 80)}`);
  }
}

function hostPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.host) return null;
    return `${u.host}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

// Host labels accept Unicode letters so IDN hosts (bücher.de) work; `new URL` punycodes them.
const LABEL = String.raw`[\p{L}\p{N}-]+`;
const HOST_PORT = new RegExp(String.raw`^(?:${LABEL}(?:\.${LABEL})*|\[[0-9a-f:.]+\]):\d+(?:[/?#]|$)`, 'iu');
const BARE_HOST = new RegExp(String.raw`^${LABEL}(?:\.${LABEL})+(?:[/?#]|$)`, 'iu');
const LOCAL_HOST = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])(?:[:/?#]|$)/i;
/** `example.com:8080abc`: a host with a broken port, which `new URL` would read as a scheme. */
const BAD_PORT = /^(?:localhost|[^:/?#]*\.[^:/?#]*):\d/i;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'data:']);

/**
 * Normalises a URL for `open` and enforces the allow-list: http(s), file, data and exactly
 * `about:blank`. Whitespace or control characters anywhere are refused (they let
 * `java\tscript:` slip past naive scheme checks). `host:port` and bare hosts (IDN included)
 * get `https://` (`http://` for localhost, bare or not, and IP literals).
 */
export function normalizeOpenUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Refusing to open an empty URL');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(trimmed)) {
    throw new Error(
      'Refusing to open a URL containing whitespace or control characters (spaces and control characters must be percent-encoded)',
    );
  }
  let candidate = trimmed;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (HOST_PORT.test(trimmed) || (!hasScheme && (BARE_HOST.test(trimmed) || LOCAL_HOST.test(trimmed)))) {
    candidate = `${LOCAL_HOST.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
  } else if (BAD_PORT.test(trimmed)) {
    throw new Error(`Not a valid URL: ${clean(trimmed, 200)}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Not a valid URL: ${clean(trimmed, 200)}`);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (ALLOWED_PROTOCOLS.has(protocol)) return candidate;
  if (protocol === 'about:' && candidate.toLowerCase() === 'about:blank') return candidate;
  throw new Error(`Refusing to open ${protocol} URLs`);
}

function tabLine(t: TabInfo): string {
  return `[w${t.windowIndex}-t${t.tabIndex}] ${t.active ? '(active) ' : ''}${clean(t.title, 200)} - ${clean(t.url, 500)}`;
}

/** BrowserDriver.findTab rules, in priority order across all tabs. */
export function matchTab(tabs: TabInfo[], target: string | number): TabInfo | undefined {
  if (typeof target === 'number') {
    return tabs[target - 1] ?? tabs.find((t) => t.tabIndex === target);
  }
  const norm = target.trim().toLowerCase();
  if (!norm) return undefined;
  const wt = /^w(\d+)-t(\d+)$/.exec(norm);
  if (wt) {
    return tabs.find((t) => t.windowIndex === Number(wt[1]) && t.tabIndex === Number(wt[2]));
  }
  const hp = hostPath(target.trim());
  const rules: Array<(t: TabInfo) => boolean> = [
    (t) => t.tabKey.toLowerCase() === norm,
    (t) => t.url.toLowerCase() === norm,
    (t) => hp !== null && hostPath(t.url) === hp,
    (t) => t.url.toLowerCase().includes(norm),
    (t) => t.title.toLowerCase().includes(norm),
  ];
  for (const rule of rules) {
    const hit = tabs.find(rule);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Drives the user's browser through AppleScript JavaScript evaluation with stable element
 * ids, falling back to the legacy port when no supported browser is running or the fast
 * path is unavailable. Never launches a browser: every chain checks the running list first.
 */
export class FastBrowserEngine implements BrowserPort {
  private readonly t: BrowserTransportLike;
  private readonly legacy: BrowserPort;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private envCache: { at: number; value: { frontmost: string | null; running: string[] } } | null = null;
  private pin: (Ctx & { target: TabTarget; at: number; frontAtPin: string }) | null = null;
  private shown: Shown | null = null;
  private readonly disabled = new Map<string, { until: number; reason: string }>();
  private noteShown = false;

  constructor(deps: FastBrowserEngineDeps) {
    this.t = deps.transport;
    this.legacy = deps.legacy;
    this.env = deps.env ?? process.env;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** Forget the pinned tab, the shown page and the fast-path availability cache. */
  reset(): void {
    this.pin = null;
    this.shown = null;
    this.disabled.clear();
    this.envCache = null;
  }

  private async environment(): Promise<{ frontmost: string | null; running: string[] } | null> {
    const now = this.now();
    if (this.envCache && now - this.envCache.at < ENV_TTL_MS) return this.envCache.value;
    try {
      const value = await this.t.environment();
      this.envCache = { at: now, value };
      return value;
    } catch {
      return null;
    }
  }

  private async resolve(): Promise<Resolved> {
    const env = await this.environment();
    if (!env) return { kind: 'legacy', reason: null };
    const now = this.now();
    let ctx: Ctx | null = null;
    if (this.pin && now - this.pin.at < PIN_TTL_MS && env.running.includes(this.pin.browser.name)) {
      this.pin.at = now;
      ctx = { browser: this.pin.browser, target: this.pin.target };
    } else {
      this.pin = null;
      const browser = pickTargetBrowser({ frontmost: env.frontmost, running: env.running, override: this.env.RH_BROWSER });
      if (browser && env.running.includes(browser.name)) ctx = { browser, target: null };
    }
    if (!ctx) return { kind: 'legacy', reason: null };
    const off = this.disabled.get(ctx.browser.name);
    if (off && off.until > now) return { kind: 'legacy', reason: off.reason };
    if (off) this.disabled.delete(ctx.browser.name);
    return { kind: 'fast', ctx };
  }

  /**
   * Runs the legacy port. `reason` says why the fast path is unavailable: it is noted once
   * on success (unless `note` is false) and always attached when the fallback itself throws.
   */
  private async useLegacy(
    fn: () => Promise<string>,
    reason: string | null,
    markShown: boolean,
    note = true,
  ): Promise<string> {
    let out: string;
    try {
      out = await fn();
    } catch (err) {
      if (!reason) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg} (fast browser path unavailable: ${reason})`);
    }
    if (markShown) this.shown = { mode: 'legacy' };
    if (note && reason && !this.noteShown) {
      this.noteShown = true;
      return `note: fast browser path unavailable (${reason}); using the slower fallback.\n${out}`;
    }
    return out;
  }

  /** Runs `fast` on the resolved target, or `fallback` per the availability rules. */
  private async run(
    fast: (ctx: Ctx) => Promise<string>,
    fallback: () => Promise<string>,
    markShown: boolean,
  ): Promise<string> {
    const r = await this.resolve();
    if (r.kind === 'legacy') return this.useLegacy(fallback, r.reason, markShown);
    try {
      const out = await fast(r.ctx);
      // The fast path works again: a later breakage deserves a fresh note.
      this.noteShown = false;
      return out;
    } catch (err) {
      if (!(err instanceof BrowserAutomationError)) throw err;
      if (err.code === 'js_disabled' || err.code === 'automation_denied') {
        this.disable(r.ctx.browser, err.message);
        return this.useLegacy(fallback, err.message, markShown);
      }
      if (err.code === 'not_running' || err.code === 'no_window') {
        this.envCache = null;
        const name = r.ctx.browser.name;
        const reason = err.code === 'no_window' ? `${name} has no open window; use browser_open` : `${name} is not running`;
        return this.useLegacy(fallback, reason, markShown, false);
      }
      if (err.code === 'no_tab') this.dropTarget();
      throw err;
    }
  }

  private disable(browser: BrowserApp, reason: string): void {
    this.disabled.set(browser.name, { until: this.now() + DISABLE_MS, reason });
  }

  /** Bookkeeping after a transport failure during an action or probe. */
  private transportFailed(ctx: Ctx, err: BrowserAutomationError): void {
    if (err.code === 'js_disabled' || err.code === 'automation_denied') {
      this.disable(ctx.browser, err.message);
      this.shown = null;
    } else if (err.code === 'no_tab') {
      this.dropTarget();
    } else if (err.code === 'not_running' || err.code === 'no_window') {
      this.shown = null;
      this.envCache = null;
      if (err.code === 'not_running') this.pin = null;
    }
  }

  private dropTarget(): void {
    this.pin = null;
    this.shown = null;
  }

  // ---- page primitives ---------------------------------------------------------------

  private async readState(ctx: Ctx): Promise<{ state: PageState; origin: number | string | null }> {
    const res = snapshotOf(parsePage(await this.t.evaluate(ctx.browser, ctx.target, buildSnapshotCall())));
    res.state.browser = ctx.browser.name;
    return res;
  }

  /**
   * One evaluate returning the snapshot and a readiness probe of the same document. Null
   * when the page did not answer (mid-navigation timeout/script error): use the slow path.
   */
  private async readCombined(
    ctx: Ctx,
  ): Promise<{ state: PageState; origin: number | string | null; url: string | null; title: string | null; probe: Probe | null } | null> {
    let v: unknown;
    try {
      v = parsePage(await this.t.evaluate(ctx.browser, ctx.target, buildSnapshotWithProbe()));
    } catch (err) {
      if (err instanceof BrowserAutomationError && (err.code === 'timeout' || err.code === 'script_error')) return null;
      throw err;
    }
    if (!v || typeof v !== 'object') return null;
    const o = v as { snap?: unknown; probe?: unknown };
    const snap = o.snap as Record<string, unknown> | null | undefined;
    // A failed snapshot (e.g. mid-navigation) is not final: let the slow path retry.
    if (snap && typeof snap === 'object' && 'error' in snap) return null;
    const { state, origin } = snapshotOf(snap ?? null);
    state.browser = ctx.browser.name;
    return {
      state,
      origin,
      url: typeof snap?.url === 'string' ? snap.url : null,
      title: typeof snap?.title === 'string' ? snap.title : null,
      probe: parseProbe(o.probe),
    };
  }

  /** Snapshot that becomes the page the model sees (actions resolve ids against it). */
  private async show(ctx: Ctx): Promise<PageState> {
    const { state, origin } = await this.readState(ctx);
    this.shown = { mode: 'fast', browser: ctx.browser, target: ctx.target, state, origin, targetConcrete: ctx.target !== null };
    return state;
  }

  /**
   * Pins an unpinned context to a concrete tab (the active tab of the lowest-index window)
   * so later actions cannot land in a tab the user switched to. Falls back to the front tab
   * (target null) when the tabs cannot be listed; actions then rely on the origin guard.
   */
  private async concrete(ctx: Ctx): Promise<Ctx> {
    if (ctx.target) return ctx;
    let tabs: TabInfo[];
    try {
      tabs = await this.t.listTabs(ctx.browser);
    } catch (err) {
      if (err instanceof BrowserAutomationError && ['automation_denied', 'not_running', 'no_window'].includes(err.code)) throw err;
      return ctx;
    }
    const front = frontTab(tabs);
    return front ? { browser: ctx.browser, target: { windowId: front.windowId, tabKey: front.tabKey } } : ctx;
  }

  /**
   * A pin remembers which tab was in front when it was set (focusing a tab brings it to the
   * front, so by default the pinned tab itself).
   */
  private makePin(browser: BrowserApp, target: TabTarget, front?: TabInfo) {
    return { browser, target, at: this.now(), frontAtPin: tabId(front ?? target) };
  }

  /**
   * Target for snapshot/find. Unpinned: the concrete front tab. Pinned: one listTabs; if the
   * front tab is no longer the one recorded at pin time the user moved on, so the pin is
   * dropped and the front tab followed (with a note); otherwise the pin stays.
   */
  private async target(ctx: Ctx): Promise<{ ctx: Ctx; note: string | null }> {
    const pin = this.pin;
    if (!pin || !ctx.target || tabId(ctx.target) !== tabId(pin.target)) return { ctx: await this.concrete(ctx), note: null };
    let tabs: TabInfo[];
    try {
      tabs = await this.t.listTabs(ctx.browser);
    } catch (err) {
      if (err instanceof BrowserAutomationError && ['automation_denied', 'not_running', 'no_window'].includes(err.code)) throw err;
      return { ctx, note: null };
    }
    const front = frontTab(tabs);
    if (!front || tabId(front) === pin.frontAtPin) return { ctx, note: null };
    this.pin = null;
    return { ctx: { browser: ctx.browser, target: { windowId: front.windowId, tabKey: front.tabKey } }, note: FOLLOWING_NOTE };
  }

  /** Adds the shown document's origin to an op (identity guard). */
  private guarded(op: PageOp, origin: number | string | null): PageOp {
    return origin === null ? op : { ...op, origin };
  }

  private async probe(ctx: Ctx): Promise<Probe | null> {
    try {
      return parseProbe(parsePage(await this.t.evaluate(ctx.browser, ctx.target, buildReadyProbe(), PROBE_TIMEOUT_MS)));
    } catch (err) {
      // A page mid-navigation may not answer; keep polling. Configuration errors propagate.
      if (err instanceof BrowserAutomationError && err.code !== 'timeout' && err.code !== 'script_error') throw err;
      return null;
    }
  }

  /**
   * Polls until the page is `complete` and two probes agree (url, title, document origin).
   * Not stable while a navigation is pending on the old document (`p`), while a different
   * document than `origin` is still loading, or (with `avoidBlank`) while the tab shows
   * about:blank. Returns a note when the 3 s cap is hit.
   */
  private async waitStable(
    ctx: Ctx,
    opts: { origin?: number | string | null; avoidBlank?: boolean; leaveOrigin?: number | string | null } = {},
  ): Promise<string | null> {
    const start = this.now();
    await this.sleep(FIRST_PROBE_MS);
    let prev: Probe | null = null;
    let pending = false;
    for (let i = 0; i < MAX_PROBES; i += 1) {
      const p = await this.probe(ctx);
      if (p) {
        pending = p.p;
        const otherDoc = opts.origin != null && p.o !== null && String(p.o) !== String(opts.origin);
        const stillOld = opts.leaveOrigin != null && p.o !== null && String(p.o) === String(opts.leaveOrigin);
        const busy = stillOld || p.p || (otherDoc && p.r !== 'complete') || (opts.avoidBlank === true && p.u === 'about:blank')
        const agrees = prev !== null && prev.r === 'complete' && prev.u === p.u && prev.t === p.t && String(prev.o) === String(p.o);
        if (!busy && p.r === 'complete' && agrees) return null;
      }
      prev = p;
      if (this.now() - start >= STABLE_CAP_MS) break;
      await this.sleep(PROBE_EVERY_MS);
    }
    return pending ? STILL_NAVIGATING : STILL_LOADING;
  }
  /**
   * Keeps the pin alive for an action on the shown tab. No environment read: every
   * AppleScript call is guarded and raises `not_running` itself (never launching the app),
   * which `act` maps to "<Name> is not running".
   */
  private async ensureRunning(ctx: Ctx): Promise<void> {
    if (this.pin && ctx.target && this.pin.target.windowId === ctx.target.windowId && this.pin.target.tabKey === ctx.target.tabKey) {
      this.pin.at = this.now();
    }
  }

  /** Runs one page op; throws the model-facing message on failure. */
  private async act(ctx: Ctx, op: PageOp, index: number | null): Promise<PageOpResult & { ok: true }> {
    let text: string;
    try {
      text = await this.t.evaluate(ctx.browser, ctx.target, buildActionScript(op));
    } catch (err) {
      if (err instanceof BrowserAutomationError) {
        this.transportFailed(ctx, err);
        if (err.code === 'js_disabled' || err.code === 'automation_denied') {
          throw new Error(`${err.message} Call browser_snapshot to continue on the slower fallback.`);
        }
        if (err.code === 'not_running') {
          throw new Error(`${ctx.browser.name} is not running. Call browser_snapshot.`);
        }
      }
      throw err;
    }
    const res = parsePage(text) as PageOpResult | null;
    if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') {
      throw new Error(`unexpected page result: ${text.slice(0, 80)}`);
    }
    if (res.ok) return res;
    const subject = index !== null ? `Element [${index}]` : `The ${op.op} target`;
    const why = res.message ? clean(res.message, 300) : null;
    switch (res.error) {
      case 'stale':
        // The page guard says why (e.g. 'page changed since the snapshot'); keep its words.
        if (why) throw new Error(`${subject}: ${why}. Call browser_snapshot.`);
        throw new Error(`${subject} no longer on the page. Call browser_snapshot.`);
      case 'changed':
        if (why) throw new Error(`${subject}: ${why}. Call browser_snapshot.`);
        throw new Error(`${subject} changed (now "${clean(res.current ?? '')}"). Call browser_snapshot.`);
      case 'no_snapshot':
        throw new Error('The page was reloaded since the last snapshot. Call browser_snapshot.');
      default: {
        const base = res.message ?? `action failed (${res.error})`;
        // The page reports what the field kept (never for passwords).
        if (res.error === 'failed' && typeof res.current === 'string') {
          throw new Error(`${base} (field now: "${clean(res.current, 200)}")`);
        }
        throw new Error(base);
      }
    }
  }

  /** After an action: settle, re-snapshot, render the delta against `prev`. */
  private async after(
    ctx: Ctx,
    prev: PageState | null,
    unverified: boolean,
    origin: number | string | null = null,
    passwordTyped = false,
    confirm: Confirm = null,
  ): Promise<string> {
    let loading: string | null = null;
    let next: PageState;
    let noChangeNote = false;
    try {
      // Fast path: one combined snapshot+probe evaluate. Accept it when the page is
      // complete, no navigation is pending, and the probe describes the snapshot's page
      // (same document, or a new document that already finished loading).
      await this.sleep(NAV_PROBE_DELAY_MS);
      const c = await this.readCombined(ctx);
      const p = c?.probe ?? null;
      const settled =
        c !== null &&
        p !== null &&
        p.r === 'complete' &&
        !p.p &&
        (origin === null || p.o === null || String(p.o) === String(origin) || String(p.o) === String(c.origin)) &&
        (c.url === null || c.url === p.u) &&
        (c.title === null || c.title === p.t);
      if (c && settled) {
        this.shown = { mode: 'fast', browser: ctx.browser, target: ctx.target, state: c.state, origin: c.origin, targetConcrete: ctx.target !== null };
        next = c.state;
        // A click/submit whose handler fetches first and navigates later can look like a
        // no-op at the first read: confirm once before reporting "no visible change".
        if (confirm && renderDelta(prev, next).endsWith('no visible change')) {
          await this.sleep(CONFIRM_DELAY_MS);
          const c2 = await this.readCombined(ctx);
          const p2 = c2?.probe ?? null;
          const firstUrl = withoutHash(c.url ?? p!.u);
          const moved =
            c2 === null ||
            p2 === null ||
            p2.p ||
            p2.r !== 'complete' ||
            (p2.o !== null && c.origin !== null && String(p2.o) !== String(c.origin)) ||
            withoutHash(p2.u) !== firstUrl ||
            (c2.url !== null && withoutHash(c2.url) !== firstUrl);
          if (moved) {
            loading = await this.waitStable(ctx, { origin });
            next = await this.show(ctx);
          } else {
            this.shown = { mode: 'fast', browser: ctx.browser, target: ctx.target, state: c2.state, origin: c2.origin, targetConcrete: ctx.target !== null };
            next = c2.state;
            noChangeNote = confirm === 'note';
          }
        }
      } else {
        loading = await this.waitStable(ctx, { origin });
        next = await this.show(ctx);
      }
    } catch (err) {
      this.shown = null;
      return `(state unavailable: ${err instanceof Error ? err.message : String(err)}; call browser_snapshot)`;
    }
    const lines = [renderDelta(prev, next)];
    if (passwordTyped && lines[0]!.endsWith('no visible change')) lines[0] = `${lines[0]} (password field: value hidden)`;
    else if (unverified && lines[0]!.endsWith('no visible change')) lines.push(UNCONFIRMED);
    if (noChangeNote && lines[0]!.endsWith('no visible change')) lines.push(NO_CHANGE_NOTE);
    if (loading) lines.push(loading);
    return lines.join('\n');
  }

  /** The shown fast page and the element for `index`, or the model-facing error. */
  private lookup(index: number): { shown: FastShown; el: PageElement & { node: number } } {
    const shown = this.shown;
    const el = shown?.mode === 'fast' ? shown.state.elements.find((e) => e.id === index) : undefined;
    if (!shown || shown.mode !== 'fast' || !el || typeof el.node !== 'number') {
      throw new Error(`Index ${index} is not on the page I last showed. Call browser_snapshot.`);
    }
    return { shown, el: el as PageElement & { node: number } };
  }

  // ---- BrowserPort ---------------------------------------------------------------------

  async snapshot(opts: { text?: boolean } = {}): Promise<string> {
    return this.run(
      async (resolved) => {
        const { ctx, note } = await this.target(resolved);
        const out = renderFull(await this.show(ctx), { text: opts.text === true });
        return note ? `${note}\n${out}` : out;
      },
      () => this.legacy.snapshot(opts),
      true,
    );
  }

  async click(index: number): Promise<string> {
    if (this.shown?.mode === 'legacy') return this.legacy.click(index);
    const { shown, el } = this.lookup(index);
    const ctx: Ctx = { browser: shown.browser, target: shown.target };
    await this.ensureRunning(ctx);
    await this.act(ctx, this.guarded({ op: 'click', node: el.node, label: el.label }, shown.origin), index);
    return `clicked [${index}] ${clean(el.label)}\n${await this.after(ctx, shown.state, false, shown.origin, false, clickConfirm(el))}`;
  }

  async type(index: number, text: string, opts: { submit?: boolean } = {}): Promise<string> {
    if (this.shown?.mode === 'legacy') return this.legacy.type(index, text, opts);
    const { shown, el } = this.lookup(index);
    const ctx: Ctx = { browser: shown.browser, target: shown.target };
    await this.ensureRunning(ctx);
    const op: PageOp = opts.submit
      ? { op: 'type', node: el.node, label: el.label, text, submit: true }
      : { op: 'type', node: el.node, label: el.label, text };
    await this.act(ctx, this.guarded(op, shown.origin), index);
    return `typed into [${index}] ${clean(el.label)}\n${await this.after(ctx, shown.state, false, shown.origin, el.value === PASSWORD_MASK, opts.submit ? 'quiet' : null)}`;
  }

  async find(query: string, limit = 8): Promise<string> {
    return this.run(
      async (resolved) => {
        const { ctx, note } = await this.target(resolved);
        const state = await this.show(ctx);
        const total = state.elements.length;
        const hits = findElements(state, query, limit);
        const lines = note ? [note] : [];
        if (hits.length > 0) {
          lines.push(`found ${hits.length} of ${total} elements for "${clean(query)}":`, ...hits.map((e) => renderElement(e, FIND_MAX_OPTIONS)));
        } else {
          const first = state.elements.slice(0, Math.max(0, limit));
          lines.push(`no match for "${clean(query)}"; first ${first.length} of ${total} elements:`, ...first.map((e) => renderElement(e)));
        }
        return lines.join('\n');
      },
      () => this.legacy.find(query, limit),
      true,
    );
  }

  async extract(maxChars = 4000): Promise<string> {
    return this.run(
      async (resolved) => {
        // Read the page the model is looking at (the snapshot's tab), like find/click do;
        // without a shown page, bind a concrete front tab like snapshot does.
        const shown = this.shown?.mode === 'fast' && this.shown.browser.name === resolved.browser.name ? this.shown : null;
        const ctx: Ctx = shown ? { browser: shown.browser, target: shown.target } : await this.concrete(resolved);
        const text = await this.t.evaluate(ctx.browser, ctx.target, buildExtractScript(maxChars));
        const v = parsePage(text);
        if (!v || typeof v !== 'object') throw new Error(`unexpected page result: ${text.slice(0, 80)}`);
        const o = v as Record<string, unknown>;
        const s = (x: unknown): string => (typeof x === 'string' ? x : '');
        return `${s(o.title)}\n${s(o.url)}\n\n${s(o.text)}`;
      },
      () => this.legacy.extract(maxChars),
      false,
    );
  }

  async tabs(): Promise<string> {
    return this.run(
      async (ctx) => {
        const tabs = await this.t.listTabs(ctx.browser);
        return [`browser: ${ctx.browser.name}`, ...tabs.map(tabLine)].join('\n');
      },
      () => this.legacy.tabs(),
      false,
    );
  }

  async focus(target: string | number): Promise<string> {
    return this.run(
      async (ctx) => {
        const tab = matchTab(await this.t.listTabs(ctx.browser), target);
        if (!tab) throw new Error(`No tab matching "${target}". Call browser_tabs.`);
        return this.focusAndShow(ctx.browser, tab, `focused ${tab.title} - ${tab.url}`);
      },
      () => this.legacy.focus(target),
      true,
    );
  }

  async open(rawUrl: string): Promise<string> {
    const url = normalizeOpenUrl(rawUrl);
    return this.run(
      async (ctx) => {
        const tabs = await this.t.listTabs(ctx.browser);
        const hp = /^(https?|file):/i.test(url.trim()) ? hostPath(url.trim()) : null;
        const same = hp ? tabs.find((t) => hostPath(t.url) === hp) : undefined;
        if (same) {
          if (sameUrl(same.url, url)) return this.focusAndShow(ctx.browser, same, `opened ${url} (reused tab)`);
          return this.navigateReused(ctx.browser, same, url);
        }
        const front = tabs.find((t) => t.windowIndex === 1) ?? tabs[0];
        await this.t.openUrl(ctx.browser, url, front?.windowId);
        const after = await this.t.listTabs(ctx.browser);
        const inFront = (t: TabInfo): boolean => t.active && (!front || t.windowId === front.windowId);
        const isNew = (t: TabInfo): boolean => !tabs.some((o) => o.windowId === t.windowId && o.tabKey === t.tabKey);
        const fresh = after.find((t) => inFront(t) && isNew(t)) ?? after.find(inFront);
        const c: Ctx = { browser: ctx.browser, target: fresh ? { windowId: fresh.windowId, tabKey: fresh.tabKey } : null };
        this.pin = c.target ? this.makePin(c.browser, c.target, frontTab(after)) : null;
        const loading = await this.waitStable(c, { avoidBlank: url.toLowerCase() !== 'about:blank' });
        const state = await this.show(c);
        return [`opened ${url}`, renderFull(state, { text: false }), ...(loading ? [loading] : [])].join('\n');
      },
      () => this.legacy.open(url),
      true,
    );
  }

  /** Focuses an existing same-path tab, navigates it to `url` and renders the new page. */
  private async navigateReused(browser: BrowserApp, tab: TabInfo, url: string): Promise<string> {
    const target: TabTarget = { windowId: tab.windowId, tabKey: tab.tabKey };
    await this.t.focusTab(browser, target);
    this.pin = this.makePin(browser, target);
    const c: Ctx = { browser, target };
    const text = await this.t.evaluate(browser, target, buildNavigateScript(url));
    const res = parsePage(text) as { ok?: unknown; o?: unknown } | null;
    if (!res || res.ok !== true) throw new Error(`unexpected page result: ${text.slice(0, 80)}`);
    // A hash-only change stays in the same document; otherwise wait for a new document.
    const leave = withoutHash(tab.url) !== withoutHash(url) && (typeof res.o === 'number' || typeof res.o === 'string') ? res.o : null;
    const loading = await this.waitStable(c, { avoidBlank: true, leaveOrigin: leave });
    const state = await this.show(c);
    return [`opened ${url} (reused tab)`, renderFull(state, { text: false }), ...(loading ? [loading] : [])].join('\n');
  }

  private async focusAndShow(browser: BrowserApp, tab: TabInfo, head: string): Promise<string> {
    const target: TabTarget = { windowId: tab.windowId, tabKey: tab.tabKey };
    await this.t.focusTab(browser, target);
    this.pin = this.makePin(browser, target);
    const state = await this.show({ browser, target });
    return `${head}\n${renderFull(state, { text: false })}`;
  }

  async do(steps: DoStep[]): Promise<string> {
    if (this.shown?.mode === 'legacy') return this.legacy.do(steps);
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('browser_do needs at least one step. No steps were run.');
    }
    if (steps.length > MAX_STEPS) {
      throw new Error(`browser_do accepts at most ${MAX_STEPS} steps (got ${steps.length}). No steps were run.`);
    }
    const shown = this.shown?.mode === 'fast' ? this.shown : null;
    const plan = steps.map((step, i) => planStep(step, i + 1, shown?.state ?? null));
    let ctx: Ctx;
    if (shown) {
      ctx = { browser: shown.browser, target: shown.target };
      await this.ensureRunning(ctx);
    } else {
      const r = await this.resolve();
      if (r.kind === 'legacy') return this.useLegacy(() => this.legacy.do(steps), r.reason, true);
      ctx = await this.concrete(r.ctx);
    }
    const startUrl = shown?.state.url ?? null;
    const origin = shown?.origin ?? null;
    const done: string[] = [];
    let unverified = false;
    let navigated: string | null = null;
    /** `ran`: step n's action ran and only the check afterwards failed (do not invite a redo). */
    const fail = async (n: number, name: string, err: unknown, ran = false): Promise<never> => {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof BrowserAutomationError) this.transportFailed(ctx, err);
      let state = '';
      if (done.length > 0 && this.shown?.mode === 'fast') {
        // Earlier steps changed the page: show where the batch stopped.
        const before = this.shown;
        try {
          await this.sleep(FAIL_SETTLE_MS);
          state = `\ncurrent state:\n${renderDelta(before.state, await this.show(ctx))}`;
        } catch {
          state = '';
        }
      }
      if (ran) throw new Error(`step ${n} ${name} ran, but checking the page afterwards failed: ${msg} (${okSoFar(n + 1)})${state}`);
      throw new Error(`step ${n} ${name} failed: ${msg} (${okSoFar(n)})${state}`);
    };
    let confirm: Confirm = null;
    for (let i = 0; i < plan.length; i += 1) {
      const p = plan[i]!;
      const n = i + 1;
      if (!p.op) {
        await this.sleep(p.ms);
        done.push(p.name);
        continue;
      }
      let res: PageOpResult & { ok: true };
      try {
        res = await this.act(ctx, this.guarded(p.op, origin), p.index);
      } catch (err) {
        return fail(n, p.name, err);
      }
      if (res.verified === false) unverified = true;
      done.push(p.name);
      if (p.confirm === 'note' || (p.confirm === 'quiet' && confirm === null)) confirm = p.confirm;
      const op = p.op;
      const mayNavigate =
        op.op === 'click' || (op.op === 'type' && op.submit === true) || (op.op === 'press' && op.key === 'Enter');
      if (mayNavigate && i < plan.length - 1) {
        let probe: Probe | null;
        try {
          await this.sleep(NAV_PROBE_DELAY_MS);
          probe = await this.probe(ctx);
        } catch (err) {
          return fail(n, p.name, err, true);
        }
        if (probe && navigatedAway(probe, startUrl, origin)) {
          navigated = `step ${n} ${p.name} ok but the page navigated; remaining steps not run`;
          break;
        }
      }
    }
    const passwordTyped = plan.some((p) => p.masked);
    const body = await this.after(ctx, shown?.state ?? null, unverified, origin, passwordTyped, confirm);
    return [`did: ${done.join(', ')}`, ...(navigated ? [navigated] : []), body].join('\n');
  }
}

interface PlannedStep {
  name: string;
  /** A type step into a field the snapshot shows masked (password). */
  masked?: boolean;
  /** Late-navigation confirmation kind for this step (see Confirm). */
  confirm?: Confirm;
  op: PageOp | null;
  index: number | null;
  ms: number;
}

/** Validates one `do` step against the shown page; throws `step N <op> invalid: ...`. */
function planStep(step: DoStep, n: number, state: PageState | null): PlannedStep {
  const name = String((step as { op?: unknown } | null)?.op ?? '');
  const invalid = (reason: string): Error => new Error(`step ${n} ${name} invalid: ${reason}. No steps were run.`);
  if (!ALL_OPS.has(name)) throw invalid('unknown op');
  let el: (PageElement & { node: number }) | undefined;
  if (INDEX_OPS.has(step.op)) {
    if (typeof step.index !== 'number' || !Number.isInteger(step.index)) throw invalid('index is required');
    const found = state?.elements.find((e) => e.id === step.index);
    if (!found || typeof found.node !== 'number') {
      throw invalid(`index ${step.index} is not on the page I last showed`);
    }
    el = found as PageElement & { node: number };
  }
  const confirm: Confirm =
    step.op === 'click' && el
      ? clickConfirm(el)
      : (step.op === 'type' && step.submit === true) || (step.op === 'press' && typeof step.key === 'string' && step.key.toLowerCase() === 'enter')
        ? 'quiet'
        : null;
  const base = { name, index: el ? (step.index as number) : null, ms: 0, masked: step.op === 'type' && el?.value === PASSWORD_MASK, confirm };
  switch (step.op) {
    case 'click':
      return { ...base, op: { op: 'click', node: el!.node, label: el!.label } };
    case 'type': {
      if (typeof step.text !== 'string') throw invalid('text is required');
      const op: PageOp = step.submit === true
        ? { op: 'type', node: el!.node, label: el!.label, text: step.text, submit: true }
        : { op: 'type', node: el!.node, label: el!.label, text: step.text };
      return { ...base, op };
    }
    case 'select':
      if (typeof step.value !== 'string' || !step.value) throw invalid('value is required');
      return { ...base, op: { op: 'select', node: el!.node, label: el!.label, value: step.value } };
    case 'check':
      if (typeof step.checked !== 'boolean') throw invalid('checked is required');
      return { ...base, op: { op: 'check', node: el!.node, label: el!.label, checked: step.checked } };
    case 'press':
      if (typeof step.key !== 'string' || !step.key.trim()) throw invalid('key is required');
      return { ...base, op: { op: 'press', key: step.key.toLowerCase() === 'enter' ? 'Enter' : step.key } };
    case 'scroll':
      if (typeof step.delta !== 'number' || !Number.isFinite(step.delta)) throw invalid('delta is required');
      return { ...base, op: { op: 'scroll', delta: step.delta } };
    case 'wait': {
      const ms = step.ms;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 5000) throw invalid('ms must be between 0 and 5000');
      return { ...base, op: null, ms };
    }
  }
  throw invalid('unknown op');
}
