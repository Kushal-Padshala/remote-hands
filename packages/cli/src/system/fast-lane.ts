import os from 'node:os';
import {
  FastLane,
  appendRunRecord,
  FastLaneInference,
  MacOsDriver,
  SkillRegistry,
  clearActiveTask,
  createAppCatalog,
  createDefaultComputerSession,
  defaultSkills,
  readFastLaneConfig,
  systemCommandRunner,
  writeActiveTask,
  type ComputerSession,
  type FastLaneDeps,
} from '@remote-hands/daemon';
import { createActionGate } from '../action-gate.js';
import type { CommandContext } from '../commands/setup.js';

export interface ResolvedFastLane {
  fastLane: FastLane;
  /** Stops the local model process; call when the HUD shuts down. */
  dispose(): Promise<void>;
}

/**
 * Builds the HUD's fast lane when the local model is installed. It is returned even while the fast
 * lane is switched off: whether to try it is re-read from the config on every request, so
 * `rh fast-lane enable` takes effect without restarting the HUD. Returns undefined (with one
 * explaining line, only when the user turned it on) when it cannot run.
 */
export async function resolveFastLane(
  context: CommandContext,
  stdout: (message: string) => void,
  overrides: Partial<FastLaneDeps> = {},
): Promise<ResolvedFastLane | undefined> {
  const home = context.fastLane?.homeDir ?? os.homedir();
  const env = context.env ?? process.env;
  const config = readFastLaneConfig(home, env);
  const inference = (context.fastLane?.inference ?? new FastLaneInference({ homeDir: home, tier: config.tier })) as FastLaneInference;

  const status = inference.status();
  if (status.state === 'unsupported') {
    if (config.enabled) stdout(`Fast lane is on but cannot run here: ${status.reason ?? 'unsupported machine'}`);
    return undefined;
  }
  // Not installed yet still gets a fast lane: each request checks the install again, so installing
  // later takes effect without restarting the HUD.
  if (status.state === 'not-installed' && config.enabled) {
    stdout('Fast lane is on but the local model is not installed yet. Run: rh fast-lane install');
  }

  // The approval gate reads the running task from a marker file; the fast lane writes it while it acts.
  const gate = createActionGate({ env: context.env });
  let session: ComputerSession | undefined;
  const macos = new MacOsDriver();
  const registry = new SkillRegistry();
  for (const skill of defaultSkills()) registry.register(skill);

  const deps: FastLaneDeps = {
    enabled: () => readFastLaneConfig(home, env).enabled,
    inference,
    registry,
    skillContext: () => ({ runner: systemCommandRunner, apps: createAppCatalog(), gate }),
    browser: () => (session ??= createDefaultComputerSession(gate)),
    frontmost: async () => {
      const front = await macos.getActiveWindowContext();
      return { app: front.app ?? '', isBrowser: front.isBrowser === true };
    },
    markActive: (id) => writeActiveTask(id),
    // Removes the marker only if it still names this task (a newer task may already own it).
    clearActive: (id) => clearActiveTask(id),
    onRun: (record) => appendRunRecord(home, record),
    ...overrides,
  };

  return { fastLane: new FastLane(deps), dispose: () => inference.dispose() };
}
