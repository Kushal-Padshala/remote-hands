import { createInterface } from 'node:readline';
import {
  AppleScriptTransport,
  BROWSERS,
  BrowserSetup,
  defaultSetupStatePath,
  findBrowser,
  nodeSetupFs,
  readSetupState,
  recordDecision,
  shouldOffer,
  type BrowserApp,
  type SetupDecision,
  type SetupFs,
} from '@remote-hands/daemon';

/** The slice of BrowserSetup the flow needs (injectable in tests). */
export interface BrowserSetupLike {
  inspect: BrowserSetup['inspect'];
  menuState: BrowserSetup['menuState'];
  enableJs: BrowserSetup['enableJs'];
  disableJs: BrowserSetup['disableJs'];
  diagnose?: BrowserSetup['diagnose'];
  windowStatuses?: BrowserSetup['windowStatuses'];
  enableForActiveProfiles?: BrowserSetup['enableForActiveProfiles'];
  requestAutomation?: BrowserSetup['requestAutomation'];
  resetAutomationConsent?: BrowserSetup['resetAutomationConsent'];
  openAutomationPane: BrowserSetup['openAutomationPane'];
  openAccessibilityPane: BrowserSetup['openAccessibilityPane'];
}

export interface BrowserSetupOptions {
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  setup?: BrowserSetupLike | undefined;
  /** Used to find the running browsers (defaults to the real AppleScript transport). */
  transport?: { environment(): Promise<{ frontmost: string | null; running: string[] }> } | undefined;
  ask?: ((question: string) => Promise<string>) | undefined;
  isTTY?: boolean | undefined;
  fs?: SetupFs | undefined;
  statePath?: string | undefined;
  now?: (() => Date) | undefined;
}


const USAGE = [
  'Usage: rh browser setup [--yes] [--disable] [--debug] [--browser <name>]',
  '',
  'Gets the fast browser path ready: checks every running browser (Chrome, Brave, Arc, Edge, Safari)',
  'and, with your permission, turns on its "Allow JavaScript from Apple Events" setting.',
  '  --yes             do not ask before turning the setting on',
  '  --disable         turn the setting back off where it is on',
  '  --browser <name>  only this browser (chrome, brave, arc, edge, safari)',
  '  --debug           print what the browser menu and probe look like (add --yes to also try one click)',
].join('\n');

const WHY =
  'Remote Hands controls your browser tabs through AppleScript. Browsers keep that off until you allow it. ' +
  'While it is on, any app that macOS lets control your browser can run JavaScript in your tabs. ' +
  'I will open an empty window in the browser for a moment to switch it on (for every profile you have open, since browsers keep it per profile), then close those windows. ' +
  'You can switch it off again any time (rh browser setup --disable).';

export type BrowserOutcome = 'ready' | 'declined' | 'skipped' | 'manual' | 'failed';

export function defaultAsk(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

interface Ctx {
  out: (m: string) => void;
  setup: BrowserSetupLike;
  ask: (q: string) => Promise<string>;
  yes: boolean;
  interactive: boolean;
  record: (b: BrowserApp, d: SetupDecision) => Promise<void>;
}

/**
 * Chromium keeps the setting per profile. When some window still has it off, switch it on
 * for every profile in use (an empty window of each profile is opened and closed again).
 * Nothing changes without a terminal or --yes; consent was given when the setting was offered.
 */
async function ensureAllWindows(b: BrowserApp, ctx: Ctx): Promise<void> {
  if (!ctx.setup.windowStatuses) return;
  const off = (await ctx.setup.windowStatuses(b)).filter((w) => w.status === 'js_disabled');
  if (off.length === 0) return;
  if (!ctx.setup.enableForActiveProfiles || (!ctx.yes && !ctx.interactive)) {
    ctx.out(`  Note: ${off.length} ${b.name} window${off.length === 1 ? '' : 's'} (${off.map((w) => w.windowIndex).join(', ')}) still ha${off.length === 1 ? 's' : 've'} it off (another profile). Run "rh browser setup" in a terminal to switch it on there too.`);
    return;
  }
  ctx.out(`  ${b.name} keeps this setting per profile; switching it on for the profiles you have open...`);
  const results = await ctx.setup.enableForActiveProfiles(b, {
    onGuide: (m) => ctx.out(`  ${m}`),
    onProgress: (m) => ctx.out(`  ${m}`),
  });
  for (const r of results) {
    const who = r.profile.email ? `${r.profile.name} (${r.profile.email})` : r.profile.name;
    ctx.out(r.ok ? `  ✔ ${who}${r.changed ? '  switched on' : '  already on'}` : `  ✖ ${who}  ${r.message ?? 'failed'}`);
  }
  const stillOff = (await ctx.setup.windowStatuses(b)).filter((w) => w.status === 'js_disabled');
  if (stillOff.length > 0) {
    ctx.out(`  Note: ${stillOff.length} window${stillOff.length === 1 ? '' : 's'} (${stillOff.map((w) => w.windowIndex).join(', ')}) still ha${stillOff.length === 1 ? 's' : 've'} it off. Bring one to the front and run "rh browser setup" again.`);
  }
}

async function enableFlow(b: BrowserApp, ctx: Ctx): Promise<BrowserOutcome> {
  if (!ctx.yes && !ctx.interactive) {
    ctx.out(`– ${b.name}  the fast path is off; run "rh browser setup" in a terminal to turn it on (nothing was changed).`);
    return 'skipped';
  }
  if (!ctx.yes) {
    ctx.out(WHY);
    const answer = (await ctx.ask(`Enable it in ${b.name} now? [Y/n] `)).trim().toLowerCase();
    if (answer !== '' && answer !== 'y' && answer !== 'yes') {
      await ctx.record(b, 'declined');
      ctx.out(`– ${b.name}  left as it is. You can run "rh browser setup" any time.`);
      return 'declined';
    }
  }

  // Clicking the browser's menu goes through System Events: let macOS show its Allow pop-up now (no reset: that would also forget the browsers).
  if (ctx.setup.requestAutomation) {
    if (ctx.interactive) ctx.out('  If macOS asks to let your terminal control System Events, click Allow.');
    await ctx.setup.requestAutomation({ name: 'System Events' } as BrowserApp, ctx.interactive ? 120_000 : 8_000);
  }

  let res = await ctx.setup.enableJs(b, { onGuide: (m) => ctx.out(`  ${m}`) });
  // Greyed-out menu item: no usable window on this desktop. Let the user fix it and retry.
  for (let retry = 0; !res.ok && res.reason === 'menu_disabled' && ctx.interactive && retry < 3; retry += 1) {
    ctx.out(`✖ ${b.name}  ${res.message}`);
    const answer = (
      await ctx.ask(`  Bring a normal ${b.name} window to the front on this desktop, then press Enter to try again (or type n to skip). `)
    )
      .trim()
      .toLowerCase();
    if (answer === 'n' || answer === 'no') break;
    res = await ctx.setup.enableJs(b, { onGuide: (m) => ctx.out(`  ${m}`) });
  }
  if (!res.ok) {
    ctx.out(`✖ ${b.name}  ${res.message}`);
    if (res.reason === 'accessibility_denied') {
      await ctx.setup.openAccessibilityPane().catch(() => {});
      ctx.out('  I opened System Settings > Accessibility. Switch on the app that runs Remote Hands, then run "rh browser setup" again.');
    } else if (res.reason === 'system_events_denied') {
      await ctx.setup.openAutomationPane().catch(() => {});
      ctx.out('  I opened System Settings > Automation. Switch on System Events under the app that runs Remote Hands, then run "rh browser setup" again.');
    } else if (res.reason === 'menu_missing') {
      await ctx.record(b, 'manual');
    }
    return res.reason === 'menu_missing' ? 'manual' : 'failed';
  }

  const after = await ctx.setup.inspect(b);
  if (after.status === 'ready') {
    await ctx.record(b, 'enabled');
    ctx.out(`✔ ${b.name}  fast path is on${res.changed ? '' : ' (it already was)'}. Undo: rh browser setup --disable`);
    await ensureAllWindows(b, ctx);
    return 'ready';
  }
  ctx.out(`✖ ${b.name}  turned the setting on but the probe still fails: ${after.message}`);
  return 'failed';
}

/**
 * Gets macOS to ask "let your terminal control <browser>?" with its own Allow button and waits for
 * the answer, so there is no trip to System Settings. A remembered "Don't Allow" is cleared for this
 * terminal only, then asked again. Returns false when the permission is still missing.
 */
async function ensureAutomationAccess(b: BrowserApp, ctx: Ctx): Promise<boolean> {
  if (!ctx.setup.requestAutomation) return true;
  const wait = ctx.interactive ? 120_000 : 8_000;
  if (ctx.interactive) ctx.out(`  If macOS asks to let your terminal control ${b.name}, click Allow.`);
  let access = await ctx.setup.requestAutomation(b, wait);
  if (access === 'denied' && ctx.interactive && ctx.setup.resetAutomationConsent) {
    ctx.out('  macOS remembers an earlier "Don\'t Allow". Clearing that for this terminal so the pop-up can show again - click Allow.');
    if (await ctx.setup.resetAutomationConsent()) access = await ctx.setup.requestAutomation(b, wait);
  }
  if (access !== 'denied') return true;
  ctx.out(`✖ ${b.name}  skipped: macOS did not allow this terminal to control it.`);
  await ctx.setup.openAutomationPane().catch(() => {});
  ctx.out('  I opened System Settings > Automation. Switch on your terminal there, then run "rh browser setup" again.');
  return false;
}

async function ensureReady(b: BrowserApp, ctx: Ctx): Promise<BrowserOutcome> {
  if (!(await ensureAutomationAccess(b, ctx))) return 'failed';
  let res = await ctx.setup.inspect(b);

  if (res.status === 'not_running') {
    ctx.out(`– ${b.name}  not running (open it and run "rh browser setup" again)`);
    return 'skipped';
  }

  if (res.status === 'automation_denied') {
    ctx.out(`✖ ${b.name}  ${res.message}`);
    if (!ctx.interactive) return 'failed';
    await ctx.setup.openAutomationPane().catch(() => {});
    await ctx.ask('  I opened System Settings > Automation. Allow it, then press Enter to check again. ');
    res = await ctx.setup.inspect(b);
  }

  if (res.status === 'ready') {
    await ctx.record(b, 'enabled');
    ctx.out(`✔ ${b.name}  fast path ready`);
    await ensureAllWindows(b, ctx);
    return 'ready';
  }
  if (res.status === 'no_window') {
    ctx.out(`– ${b.name}  no open window; open a normal window and run "rh browser setup" again`);
    return 'skipped';
  }
  if (res.status === 'js_disabled') return enableFlow(b, ctx);

  ctx.out(`✖ ${b.name}  ${res.message}`);
  return 'failed';
}

async function disableFlow(b: BrowserApp, ctx: Ctx): Promise<void> {
  const res = await ctx.setup.disableJs(b);
  if (!res.ok) {
    ctx.out(res.reason === 'not_running' ? `– ${b.name}  not running` : `✖ ${b.name}  ${res.message}`);
    return;
  }
  ctx.out(res.changed ? `✔ ${b.name}  turned off` : `– ${b.name}  already off`);
}

function buildCtx(opts: BrowserSetupOptions, flags: { yes: boolean }): { ctx: Ctx; transport: NonNullable<BrowserSetupOptions['transport']> } {
  const real = new AppleScriptTransport();
  const transport = opts.transport ?? real;
  const setup = opts.setup ?? new BrowserSetup({ transport: real });
  const fs = opts.fs ?? nodeSetupFs;
  const statePath = opts.statePath ?? defaultSetupStatePath();
  const ctx: Ctx = {
    out: opts.stdout,
    setup,
    ask: opts.ask ?? defaultAsk,
    yes: flags.yes,
    interactive: opts.isTTY ?? Boolean(process.stdin.isTTY),
    record: async (b, d) => {
      try {
        await recordDecision(fs, statePath, b.name, d, opts.now);
      } catch {
        // remembering is best effort
      }
    },
  };
  return { ctx, transport };
}

/** `rh browser setup [--yes] [--disable] [--browser <name>]` */
export async function browserSetupCommand(args: string[], opts: BrowserSetupOptions): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    opts.stdout(USAGE);
    return 0;
  }
  let yes = false;
  let disable = false;
  let debug = false;
  let only: BrowserApp | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--disable') disable = true;
    else if (a === '--debug') debug = true;
    else if (a === '--browser') {
      const name = args[i + 1];
      only = name ? findBrowser(name) : undefined;
      if (!only) {
        opts.stderr(`Unknown browser${name ? ` "${name}"` : ''}. Use one of: chrome, brave, arc, edge, safari.`);
        return 1;
      }
      i += 1;
    } else {
      opts.stderr(USAGE);
      return 1;
    }
  }

  const { ctx, transport } = buildCtx(opts, { yes });
  let running: string[];
  try {
    running = (await transport.environment()).running;
  } catch (err) {
    opts.stderr(`Could not list running apps: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const targets = (only ? [only] : [...BROWSERS]).filter((b) => running.includes(b.name) || only);
  if (targets.length === 0) {
    ctx.out('No supported browser is running. Open Chrome, Brave, Arc, Edge or Safari and run "rh browser setup" again.');
    return 0;
  }

  let anyFailed = false;
  for (const b of targets) {
    if (debug) {
      ctx.out(`--- ${b.name}`);
      if (!running.includes(b.name)) {
        ctx.out('not running');
        continue;
      }
      const lines = ctx.setup.diagnose ? await ctx.setup.diagnose(b, { click: yes }) : ['diagnostics unavailable'];
      for (const l of lines) ctx.out(l);
      continue;
    }
    if (disable) {
      await disableFlow(b, ctx);
      continue;
    }
    const outcome = await ensureReady(b, ctx);
    if (outcome === 'failed') anyFailed = true;
    if (only && outcome !== 'ready') anyFailed = true;
  }
  return only && anyFailed ? 1 : 0;
}

/**
 * Called from `rh hud install|listen` and `rh setup`: offers the setup once per browser,
 * only on a terminal, and never for a browser the user already decided on. Never throws.
 */
export async function offerBrowserSetupOnce(opts: BrowserSetupOptions): Promise<void> {
  const interactive = opts.isTTY ?? Boolean(process.stdin.isTTY);
  if (!interactive) return;
  try {
    const { ctx, transport } = buildCtx(opts, { yes: false });
    const fs = opts.fs ?? nodeSetupFs;
    const statePath = opts.statePath ?? defaultSetupStatePath();
    const state = await readSetupState(fs, statePath);
    const running = (await transport.environment()).running;
    const pending = BROWSERS.filter((b) => running.includes(b.name) && shouldOffer(state, b.name));
    if (pending.length === 0) return;
    ctx.out('Checking your browsers for the fast browser path (run "rh browser setup" any time to redo this)...');
    for (const b of pending) await ensureReady(b, ctx);
  } catch (err) {
    opts.stderr(`Browser setup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Offer used by `rh hud install|listen` and `rh setup`: injectable, macOS only, never throws. */
export async function offerForContext(ctx: {
  stdout?: ((msg: string) => void) | undefined;
  stderr?: ((msg: string) => void) | undefined;
  browserSetupOffer?: (() => Promise<void>) | undefined;
  browserSetup?: Partial<BrowserSetupOptions> | undefined;
}): Promise<void> {
  try {
    if (ctx.browserSetupOffer) {
      await ctx.browserSetupOffer();
      return;
    }
    if (process.platform !== 'darwin') return;
    await offerBrowserSetupOnce({
      ...ctx.browserSetup,
      stdout: ctx.stdout ?? console.log,
      stderr: ctx.stderr ?? console.error,
    });
  } catch (err) {
    (ctx.stderr ?? console.error)(`Browser setup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
