import type { BrowserApp } from './browsers.js';
import {
  BrowserSetup,
  defaultSetupStatePath,
  nodeSetupFs,
  readSetupState,
  type SetupFs,
  type ToggleOutcome,
} from './setup.js';
import type { AppleScriptTransport } from './transport.js';

export interface AutoEnableResult {
  ok: boolean;
  message?: string;
}

export type AutoEnable = (browser: BrowserApp) => Promise<AutoEnableResult>;

export interface AutoEnableDeps {
  transport: Pick<AppleScriptTransport, 'evaluate' | 'environment' | 'listTabs' | 'closeTab'>;
  /** Replaces the real BrowserSetup (tests). */
  setup?: Pick<BrowserSetup, 'enableJs'>;
  fs?: SetupFs;
  statePath?: string;
  platform?: NodeJS.Platform;
}

/**
 * Self-healing at task time: when a browser the user already approved during `rh browser
 * setup` (decision `enabled`) reports that JavaScript from Apple Events is off (typically a
 * profile that was not open during setup), switch it on the same way setup does. Never runs
 * for a browser the user declined or was never asked about, never asks questions, and never
 * leaves the user to click (a failure just falls back to the slower path).
 */
export function createAutoEnable(deps: AutoEnableDeps): AutoEnable {
  const fs = deps.fs ?? nodeSetupFs;
  const statePath = deps.statePath ?? defaultSetupStatePath();
  const platform = deps.platform ?? process.platform;
  const setup = deps.setup ?? new BrowserSetup({ transport: deps.transport });

  return async (browser) => {
    if (platform !== 'darwin') return { ok: false };
    const state = await readSetupState(fs, statePath);
    if (state.browsers[browser.name]?.decision !== 'enabled') return { ok: false };
    let res: ToggleOutcome;
    try {
      res = await setup.enableJs(browser);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    return res.ok ? { ok: true } : { ok: false, message: res.message };
  };
}
