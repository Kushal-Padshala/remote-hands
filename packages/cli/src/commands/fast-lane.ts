import os from 'node:os';
import {
  FastLaneInference,
  MODELS,
  readFastLaneConfig,
  writeFastLaneConfig,
  type ModelEntry,
  type ModelTier,
} from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';

const USAGE = [
  'Usage: rh fast-lane <status|install|enable|disable>',
  '',
  'The fast lane runs a small model on this Mac so simple requests (open an app, a note, a message,',
  'clicking through a web page) finish in a second or two. Anything it is unsure about goes to the',
  'agent as before. It is off until you turn it on.',
  '',
  '  status            Show whether it is installed and on',
  '  install           Download the local model once (about 1.3-2.5GB, free)',
  '  install --tier=standard|lite   Choose the model size (default: by your memory)',
  '  enable            Turn it on',
  '  disable           Turn it off (requests go straight to the agent)',
];

const gb = (bytes: number): string => `${Math.round(bytes / 2 ** 30)}GB`;
const modelFor = (id: string | undefined): ModelEntry | undefined => MODELS.find((m) => m.id === id);

export async function fastLaneCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const env = context.env ?? process.env;
  const home = context.fastLane?.homeDir ?? os.homedir();
  const sub = args[0] ?? 'status';

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    for (const line of USAGE) stdout(line);
    return 0;
  }
  if (!['status', 'install', 'enable', 'disable'].includes(sub)) {
    stderr(`Unknown command "${sub}".`);
    for (const line of USAGE) stderr(line);
    return 1;
  }

  const config = readFastLaneConfig(home, env);
  let tier: ModelTier | undefined = config.tier;

  if (sub === 'install') {
    const flag = args.find((a) => a.startsWith('--tier='))?.slice('--tier='.length);
    if (flag !== undefined) {
      if (flag !== 'standard' && flag !== 'lite') {
        stderr('The model size must be standard or lite.');
        return 1;
      }
      tier = flag;
      writeFastLaneConfig(home, { tier });
    }
  }

  const inference = context.fastLane?.inference ?? new FastLaneInference({ homeDir: home, tier });
  const status = inference.status();
  const model = modelFor(status.model);

  if (sub === 'status') {
    const fromEnv = env.RH_FAST_LANE !== undefined && ['1', 'true', 'on', '0', 'false', 'off'].includes(env.RH_FAST_LANE.trim().toLowerCase());
    stdout(`Fast lane: ${config.enabled ? 'on' : 'off'}${fromEnv ? ' (set by RH_FAST_LANE)' : ''}`);
    if (status.state === 'unsupported') {
      stdout(`State:     not supported - ${status.reason ?? 'this machine cannot run it'}`);
      return 0;
    }
    stdout(`State:     ${status.state === 'not-installed' ? 'not installed' : 'ready - the local model is installed'}`);
    if (model) stdout(`Model:     ${model.label} (${status.tier ?? model.tier} size, ${(model.bytes / 1e9).toFixed(1)}GB download)`);
    stdout(`Memory:    ${gb(context.fastLane?.totalRamBytes ?? os.totalmem())}`);
    if (status.state === 'not-installed') stdout('Next:      rh fast-lane install');
    else stdout(`Next:      ${config.enabled ? 'rh fast-lane disable to turn it off' : 'rh fast-lane enable'}`);
    return 0;
  }

  if (sub === 'install') {
    if (status.state === 'unsupported') {
      stderr(`The fast lane cannot run on this machine: ${status.reason ?? 'unsupported'}`);
      return 1;
    }
    const lastDecile = new Map<string, number>();
    try {
      stdout(`Installing the fast lane${model ? ` (${model.label})` : ''}. This downloads about ${model ? (model.bytes / 1e9).toFixed(1) : '2'}GB once.`);
      await inference.install((stage, done, total) => {
        const decile = total > 0 ? Math.floor((done / total) * 10) : 0;
        if (lastDecile.get(stage) === decile) return;
        lastDecile.set(stage, decile);
        stdout(`  ${stage === 'runtime' ? 'Runtime' : 'Model'}: ${decile * 10}%`);
      });
    } catch (err) {
      stderr(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    stdout('Installed. Turn it on with: rh fast-lane enable');
    return 0;
  }

  if (sub === 'enable') {
    if (status.state === 'unsupported') {
      stderr(`The fast lane cannot run on this machine: ${status.reason ?? 'unsupported'}`);
      return 1;
    }
    if (status.state === 'not-installed') {
      stderr('The local model is not installed yet. Run: rh fast-lane install');
      return 1;
    }
    writeFastLaneConfig(home, { enabled: true });
    stdout('Fast lane is on. New requests in the HUD try it first; anything it is unsure about goes to the agent.');
    return 0;
  }

  writeFastLaneConfig(home, { enabled: false });
  stdout('Fast lane is off. Requests go straight to the agent, as before.');
  return 0;
}
