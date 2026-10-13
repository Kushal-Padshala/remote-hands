import { ChromeManager } from '../chrome-manager.js';
import { CdpTransport } from './cdp-transport.js';

export interface DefaultCdpTarget {
  host: string;
  port: number;
  /** Only a browser on this computer can be started from here. */
  local: boolean;
}

/** Where the DevTools port is, from `BU_CDP_URL` (default http://127.0.0.1:9222). */
export function cdpTargetFromEnv(env: NodeJS.ProcessEnv = process.env): DefaultCdpTarget {
  const fallback: DefaultCdpTarget = { host: '127.0.0.1', port: 9222, local: true };
  const raw = env.BU_CDP_URL;
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const host = url.hostname || fallback.host;
    const port = url.port ? Number.parseInt(url.port, 10) : fallback.port;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return fallback;
    return { host, port, local: host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' };
  } catch {
    return fallback;
  }
}

/**
 * The browser transport for computers where AppleScript is not available. It uses the browser on the DevTools port and,
 * when nothing answers there, starts Remote Hands' own browser window (its own profile, so the person's everyday browser
 * is left alone).
 */
export function createDefaultCdpTransport(env: NodeJS.ProcessEnv = process.env): CdpTransport {
  const target = cdpTargetFromEnv(env);
  const manager = target.local ? new ChromeManager({ mode: 'dedicated', port: target.port }) : undefined;
  return new CdpTransport({
    host: target.host,
    port: target.port,
    ...(manager
      ? {
          ensureBrowser: async () => {
            const status = await manager.ensureRunning();
            return { available: status.available, error: status.error };
          },
        }
      : {}),
  });
}
