import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';

export function findCloudflaredBinary(): string | null {
  const localBin = path.join(os.homedir(), '.remote-hands', 'bin', 'cloudflared');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  const sysWhich = spawnSync('which', ['cloudflared'], { encoding: 'utf-8' });
  if (sysWhich.status === 0 && sysWhich.stdout.trim().length > 0) {
    return sysWhich.stdout.trim();
  }
  return null;
}

export async function ensureCloudflaredBinary(
  stdout?: ((msg: string) => void) | undefined,
): Promise<string | null> {
  const existing = findCloudflaredBinary();
  if (existing) return existing;

  if (process.platform === 'darwin') {
    try {
      stdout?.('Setting up account-less remote tunnel binary...');
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
      const binDir = path.join(os.homedir(), '.remote-hands', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const targetBin = path.join(binDir, 'cloudflared');
      spawnSync('sh', ['-c', `curl -fsSL "${url}" | tar -xz -C "${binDir}"`], { timeout: 30000 });
      if (fs.existsSync(targetBin)) {
        fs.chmodSync(targetBin, 0o755);
        return targetBin;
      }
    } catch {}
  }
  return null;
}

export interface TunnelResult {
  process: ChildProcess;
  url: string | null;
}

export async function startQuickTunnel(
  localPort: number,
  options?: {
    binPath?: string | undefined;
    timeoutMs?: number | undefined;
    stderr?: ((msg: string) => void) | undefined;
  },
): Promise<TunnelResult | null> {
  const bin = options?.binPath ?? (findCloudflaredBinary() || await ensureCloudflaredBinary());
  if (!bin || !fs.existsSync(bin)) return null;

  try {
    const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${localPort}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      options?.stderr?.(`Remote tunnel failed: ${err.message}`);
    });

    const timeout = options?.timeoutMs ?? 7000;
    const url = await new Promise<string | null>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, timeout);

      const capture = (data: Buffer) => {
        if (settled) return;
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && match[0]) {
          settled = true;
          clearTimeout(timer);
          resolve(match[0]);
        }
      };

      proc.stdout?.on('data', capture);
      proc.stderr?.on('data', capture);
    });

    return { process: proc, url };
  } catch {
    return null;
  }
}
