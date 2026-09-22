import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  CloudflareControlPlaneClient,
  CloudflareTaskStore,
  RealtimeClient,
  ProcessAgentRunner,
  getRuntimeMetadata,
  runDaemonOnce,
  ChromeManager,
  LocalServer,
  LocalTaskStore,
  type ChromeProfileMode,
  type AgentRunner,
} from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';
import { c } from '../output/ui.js';
import { ensureAgyPermissions } from '../system/agy-permissions.js';
import { ensureMacPermissions } from '../system/mac-permissions.js';

interface LocalDaemonConfig {
  cloudflareApiUrl: string;
  sessionToken: string;
  machineId?: string;
  machineName?: string;
}

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const netList = nets[name];
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function findWebDist(customRoot?: string): string | undefined {
  const candidates = [
    customRoot ? path.resolve(customRoot, 'apps/web/dist') : '',
    path.resolve(process.cwd(), 'apps/web/dist'),
    path.resolve(fileURLToPath(import.meta.url), '../../../../apps/web/dist'),
    path.resolve(fileURLToPath(import.meta.url), '../../../apps/web/dist'),
    path.resolve(fileURLToPath(import.meta.url), '../../apps/web/dist'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parsePort(args: string[], context: CommandContext): number {
  const portArgIdx = args.findIndex((a) => a === '--port' || a.startsWith('--port='));
  if (portArgIdx !== -1) {
    const arg = args[portArgIdx];
    if (arg && arg.startsWith('--port=')) {
      const val = Number(arg.slice('--port='.length));
      if (!isNaN(val)) return val;
    } else if (portArgIdx + 1 < args.length) {
      const val = Number(args[portArgIdx + 1]);
      if (!isNaN(val)) return val;
    }
  }
  if ((context as any).port !== undefined) {
    const val = Number((context as any).port);
    if (!isNaN(val)) return val;
  }
  return 3000;
}

function resolveProfileSettings(args: string[]): { profileMode: ChromeProfileMode; targetProfile?: string | undefined } {
  const browserProfileIdx = args.findIndex((a) => a === '--browser-profile' || a.startsWith('--browser-profile='));
  let rawProfile: string | undefined;
  if (browserProfileIdx !== -1) {
    const arg = args[browserProfileIdx];
    if (arg && arg.startsWith('--browser-profile=')) {
      rawProfile = arg.slice('--browser-profile='.length);
    } else if (browserProfileIdx + 1 < args.length) {
      rawProfile = args[browserProfileIdx + 1];
    }
  }
  let profileMode: ChromeProfileMode = 'active';
  let targetProfile: string | undefined;

  if (rawProfile) {
    if (rawProfile === 'dedicated' || rawProfile === 'none' || rawProfile === 'active') {
      profileMode = rawProfile;
    } else {
      profileMode = 'active';
      targetProfile = rawProfile;
    }
  }
  return { profileMode, targetProfile };
}

async function runLocalDaemon(
  args: string[],
  context: CommandContext,
  options: {
    configDir: string;
    isRemote: boolean;
    once: boolean;
    stdout: (msg: string) => void;
    stderr: (msg: string) => void;
  },
): Promise<number> {
  try {
    fs.mkdirSync(options.configDir, { recursive: true });
  } catch {}

  const dbPath = path.join(options.configDir, 'local.db');
  const store: LocalTaskStore = (context as any).taskStore ?? new LocalTaskStore({ dbPath });

  const tokenFile = path.join(options.configDir, 'local-token.txt');
  let pairingToken = '';
  try {
    if (fs.existsSync(tokenFile)) {
      pairingToken = fs.readFileSync(tokenFile, 'utf-8').trim();
    }
  } catch {}
  if (!pairingToken) {
    pairingToken = crypto.randomUUID().replace(/-/g, '');
    try {
      fs.writeFileSync(tokenFile, pairingToken, 'utf-8');
    } catch {}
  }

  const staticDir = findWebDist(context.projectRoot);
  const portToUse = parsePort(args, context);

  const localServer = new LocalServer({
    port: portToUse,
    pairingToken,
    store,
    staticDir,
  });

  const actualPort = await localServer.start();
  const localIp = getLocalIp();
  const localUrl = `http://${localIp}:${actualPort}/?token=${pairingToken}`;

  let cloudflaredProc: ChildProcess | null = null;
  let remoteUrl: string | null = null;

  if (options.isRemote) {
    try {
      cloudflaredProc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${actualPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      cloudflaredProc.on('error', (err) => {
        options.stderr(`Cloudflare tunnel failed to start: ${err.message}`);
      });
      const captureTunnelUrl = (data: Buffer) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !remoteUrl) {
          remoteUrl = match[0];
          options.stdout(`${c.brightMagenta('🌐')} Public Tunnel: ${remoteUrl}/?token=${pairingToken}`);
        }
      };
      cloudflaredProc.stdout?.on('data', captureTunnelUrl);
      cloudflaredProc.stderr?.on('data', captureTunnelUrl);
    } catch (err: any) {
      options.stderr(`Cloudflare tunnel error: ${err.message}`);
    }
  }

  const termWidth = Math.max(
    48,
    Math.min(
      typeof process !== 'undefined' && process.stdout?.columns ? process.stdout.columns : 74,
      74,
    ),
  );
  const hr = '─'.repeat(termWidth - 2);

  options.stdout(`${c.brightGreen('✔')} Starting Remote Hands daemon in local embedded mode`);
  options.stdout(
    '\n' +
      c.brightCyan(`╭─ ${c.bold('⚡ Remote Hands Local Server online')} ${'─'.repeat(Math.max(2, termWidth - 36))}\n`) +
      `${c.brightCyan('│')}  ${c.brightGreen('✔')} ${c.white(`Local Server online: ${localUrl}`)}\n` +
      `${c.brightCyan('│')}  ${c.dim(`Serving PWA from: ${staticDir || 'embedded API mode'}`)}\n` +
      (remoteUrl ? `${c.brightCyan('│')}  ${c.brightMagenta('🌐')} ${c.white(`Public Tunnel: ${remoteUrl}/?token=${pairingToken}`)}\n` : '') +
      `${c.brightCyan('│')}  ${c.dim('Open the URL above on your phone (same Wi-Fi) to control this machine.')}\n` +
      c.brightCyan(`╰${hr}\n`),
  );

  await ensureAgyPermissions(context.fs);

  if (process.platform === 'darwin' && !context.runner && !options.once && !args.includes('--skip-permissions')) {
    await ensureMacPermissions(options.stdout, 74);
  }

  const { profileMode, targetProfile } = resolveProfileSettings(args);

  const chromeManager =
    context.chromeManager ??
    new ChromeManager({
      mode: profileMode,
      profile: targetProfile,
      port: 9222,
    });
  context.chromeManager = chromeManager;

  const runner: AgentRunner = (context as any).agentRunner ?? new ProcessAgentRunner('agy');
  const machineName = os.hostname() || 'localhost';
  const runtime = getRuntimeMetadata({
    hostname: () => machineName,
    daemonVersion: '0.1.3',
  });

  const originalAppendEvent = store.appendEvent.bind(store);
  store.appendEvent = async (taskId, input) => {
    const event = await originalAppendEvent(taskId, input);
    localServer.broadcastEvent(taskId, event);
    return event;
  };

  const originalPushFrame = store.pushFrame?.bind(store);
  if (originalPushFrame) {
    store.pushFrame = async (taskId, frame) => {
      await originalPushFrame(taskId, frame);
      localServer.broadcastFrame(taskId, frame);
    };
  }

  let isRunning = true;
  const stop = async () => {
    if (!isRunning) return;
    isRunning = false;
    if (cloudflaredProc) {
      try {
        cloudflaredProc.kill('SIGTERM');
      } catch {}
      cloudflaredProc = null;
    }
    try {
      await localServer.stop();
    } catch {}
    try {
      store.close();
    } catch {}
    try {
      chromeManager?.close();
    } catch {}
  };

  const sigHandler = () => {
    stop().catch(() => {});
  };
  process.once('SIGINT', sigHandler);
  process.once('SIGTERM', sigHandler);

  const lastHeartbeatAtRef = { current: 0 };
  try {
    while (isRunning) {
      try {
        const result = await runDaemonOnce({
          userId: 'local-user',
          config: {
            supabaseUrl: '',
            supabaseAnonKey: '',
            machineName,
            agyCommand: 'agy',
            workspaceAllowlist: [],
            pollIntervalMs: 1000,
            heartbeatIntervalMs: 60000,
          },
          runtime,
          store,
          runner,
          chromeManager,
          lastHeartbeatAtRef,
          onFrame: (frame) => {
            localServer.broadcastFrame('primary', frame);
          },
        });

        if (result.claimed) {
          options.stdout(`[Task ${result.taskId}] Completed with status: ${result.status}`);
          continue;
        }
      } catch {}

      if (options.once) {
        break;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    process.removeListener('SIGINT', sigHandler);
    process.removeListener('SIGTERM', sigHandler);
    await stop();
  }

  return 0;
}

export async function daemonCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const once = args.includes('--once') || (context as any).once === true;
  const isLocal = args.includes('--local') || (context as any).local === true;
  const isRemote = args.includes('--remote') || (context as any).remote === true;

  const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
  const daemonConfigFile = path.join(configDir, 'daemon.json');

  let hasDaemonConfig = false;
  if (context.fs) {
    if (typeof (context.fs as any).existsSync === 'function') {
      hasDaemonConfig = (context.fs as any).existsSync(daemonConfigFile);
    } else {
      hasDaemonConfig = await context.fs.exists(daemonConfigFile);
    }
  } else {
    hasDaemonConfig = fs.existsSync(daemonConfigFile);
  }

  if (isLocal || !hasDaemonConfig) {
    return await runLocalDaemon(args, context, {
      configDir,
      isRemote,
      once,
      stdout,
      stderr,
    });
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

  if (process.platform === 'darwin' && !context.runner && !once && !args.includes('--skip-permissions')) {
    await ensureMacPermissions(stdout, 74);
  }

  const client = new CloudflareControlPlaneClient({
    baseUrl: rawConfig.cloudflareApiUrl,
    sessionToken: rawConfig.sessionToken,
  });

  const store = new CloudflareTaskStore({
    client,
    machineId,
  });

  const runner: AgentRunner = (context as any).agentRunner ?? new ProcessAgentRunner('agy');
  const runtime = getRuntimeMetadata({
    hostname: () => machineName,
    daemonVersion: '0.1.3',
  });

  let connected = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.heartbeat(machineId);
      connected = true;
      stdout(`${c.brightGreen('✔')} Machine connected: ${machineName} (${machineId})`);
      break;
    } catch (err: any) {
      if (attempt === 3) {
        stdout(c.yellow(`[daemon] Initial heartbeat pending (${err?.message || err}). Retrying in background...`));
      } else {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  let realtime: RealtimeClient | null = null;
  try {
    realtime = new RealtimeClient({
      baseUrl: rawConfig.cloudflareApiUrl,
      sessionToken: rawConfig.sessionToken,
    });
    await realtime.connectMachine(machineId);
    stdout(`${c.brightGreen('✔')} Realtime relay connected to Cloudflare edge`);
  } catch {
    stdout(c.dim(`[daemon] Realtime relay pending. Connecting in background...`));
  }

  let triggerClaim: (() => void) | null = null;
  const waitForNextPoll = (ms: number) =>
    new Promise<void>((resolve) => {
      let timer: any = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        triggerClaim = null;
        resolve();
      };
      triggerClaim = done;
      timer = setTimeout(done, ms);
    });

  if (realtime) {
    realtime.onMessage(() => {
      if (triggerClaim) {
        triggerClaim();
      }
    });
  }

  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(machineId);
      if (!connected) {
        connected = true;
        stdout(`${c.brightGreen('✔')} Machine connected: ${machineName} (${machineId})`);
      }
    } catch {}
  }, 15000);

  const { profileMode, targetProfile } = resolveProfileSettings(args);

  const chromeManager =
    context.chromeManager ??
    new ChromeManager({
      mode: profileMode,
      profile: targetProfile,
      port: 9222,
    });
  context.chromeManager = chromeManager;

  let isRunning = true;
  const stop = () => {
    if (!isRunning) return;
    isRunning = false;
    clearInterval(heartbeatInterval);
    if (triggerClaim) {
      triggerClaim();
    }
    try {
      realtime?.close();
    } catch {}
    try {
      chromeManager?.close();
    } catch {}
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const lastHeartbeatAtRef = { current: 0 };
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
            pollIntervalMs: 1000,
            heartbeatIntervalMs: 60000,
          },
          runtime,
          store,
          runner,
          chromeManager,
          lastHeartbeatAtRef,
        });

        if (result.claimed) {
          stdout(`[Task ${result.taskId}] Completed with status: ${result.status}`);
          continue;
        }
      } catch {}

      if (once) {
        break;
      }

      await waitForNextPoll(1000);
    }
  } finally {
    stop();
  }

  return 0;
}
