import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  CloudflareControlPlaneClient,
  CloudflareTaskStore,
  RealtimeClient,
  ProcessAgentRunner,
  getRuntimeMetadata,
  runDaemonOnce,
} from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';
import { c } from '../output/ui.js';
import { ensureAgyPermissions } from '../system/agy-permissions.js';

interface LocalDaemonConfig {
  cloudflareApiUrl: string;
  sessionToken: string;
  machineId?: string;
  machineName?: string;
}

export async function daemonCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const once = args.includes('--once') || (context as any).once === true;

  const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
  const daemonConfigFile = path.join(configDir, 'daemon.json');

  if (!fs.existsSync(daemonConfigFile)) {
    stderr(`Daemon configuration not found at ${daemonConfigFile}. Run "rh setup" first.`);
    return 1;
  }

  let rawConfig: LocalDaemonConfig;
  try {
    const content = await fs.promises.readFile(daemonConfigFile, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch (err: any) {
    stderr(`Failed to read daemon configuration: ${err.message}`);
    return 1;
  }

  const machineId = rawConfig.machineId || 'primary-machine';
  const machineName = rawConfig.machineName || os.hostname() || 'primary-laptop';

  await ensureAgyPermissions(context.fs);

  const client = new CloudflareControlPlaneClient({
    baseUrl: rawConfig.cloudflareApiUrl,
    sessionToken: rawConfig.sessionToken,
  });

  const store = new CloudflareTaskStore({
    client,
    machineId,
  });

  const runner = new ProcessAgentRunner('agy');
  const runtime = getRuntimeMetadata({
    hostname: () => machineName,
    daemonVersion: '0.1.3',
  });

  try {
    await client.heartbeat(machineId);
    stdout(`${c.brightGreen('✔')} Machine connected: ${machineName} (${machineId})`);
  } catch (err: any) {
    stdout(`[daemon] Initial heartbeat notice: ${err?.message || err}`);
  }

  let realtime: RealtimeClient | null = null;
  try {
    realtime = new RealtimeClient({
      baseUrl: rawConfig.cloudflareApiUrl,
      sessionToken: rawConfig.sessionToken,
    });
    await realtime.connectMachine(machineId);
    stdout(`${c.brightGreen('✔')} Realtime relay connected to Cloudflare edge`);
  } catch {}

  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(machineId);
    } catch {}
  }, 15000);

  let isRunning = true;
  const stop = () => {
    if (!isRunning) return;
    isRunning = false;
    clearInterval(heartbeatInterval);
    try {
      realtime?.close();
    } catch {}
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (isRunning) {
      try {
        const result = await runDaemonOnce({
          userId: 'owner',
          config: {
            supabaseUrl: '',
            supabaseAnonKey: '',
            machineName,
            agyCommand: 'agy',
            workspaceAllowlist: [],
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 15000,
          },
          runtime,
          store,
          runner,
        });

        if (result.claimed) {
          stdout(`[Task ${result.taskId}] Completed with status: ${result.status}`);
        }
      } catch {}

      if (once) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    stop();
  }

  return 0;
}
