import os from 'node:os';
import {
  FastLane,
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
  if (status.state === 'unsupported' || status.state === 'not-installed') {
    if (config.enabled) {
      stdout(
        status.state === 'unsupported'
          ? `Fast lane is on but cannot run here: ${status.reason ?? 'unsupported machine'}`
          : 'Fast lane is on but the local model is not installed yet. Run: rh fast-lane install',
      );
    }
    return undefined;
  }

  // The approval gate reads the running task from a marker file; the fast lane writes it while it acts.
  const gate = createActionGate({ env: context.env });
  let session: ComputerSession | undefined;
  let running: string | null = null;
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
    setActiveTask: (id) => {
      if (id !== null) {
        writeActiveTask(id);
        running = id;
      } else if (running !== null) {
        clearActiveTask(running);
        running = null;
      }
    },
    ...overrides,
  };

  return { fastLane: new FastLane(deps), dispose: () => inference.dispose() };
}
