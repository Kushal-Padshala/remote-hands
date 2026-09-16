import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generatePairingCode } from '@remote-hands/control-plane';
import { generatePairingUrl } from '../pairing/qr.js';
import { renderPairingTui, renderStepError } from '../output/ui.js';
import type { CommandContext } from './setup.js';

export async function pairCommand(args: string[] = [], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const fetchFn = context.fetchFn ?? fetch;

  const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
  const daemonConfigFile = path.join(configDir, 'daemon.json');

  let daemonConfig: { cloudflareApiUrl?: string; sessionToken?: string; machineName?: string } | null = null;
  try {
    const raw = await fs.readFile(daemonConfigFile, 'utf-8');
    daemonConfig = JSON.parse(raw);
  } catch {
    daemonConfig = null;
  }

  if (!daemonConfig?.cloudflareApiUrl || !daemonConfig?.sessionToken) {
    stderr(renderStepError('No active daemon configuration found. Run "rh setup" first.'));
    return 1;
  }

  const apiUrl = daemonConfig.cloudflareApiUrl.replace(/\/+$/, '');
  const webUrl = apiUrl.includes('remote-hands-backend.')
    ? apiUrl.replace('remote-hands-backend.', 'remote-hands-web.')
    : 'https://remote-hands-web.remote-hands-cloudflare.workers.dev';

  let phoneToken = '';
  try {
    const res = await fetchFn(`${apiUrl}/pairing/phone-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemonConfig.sessionToken}`,
      },
    });
    if (res.ok) {
      const data = (await res.json()) as { session_token?: string };
      if (data?.session_token) {
        phoneToken = data.session_token;
      }
    }
  } catch {}

  if (!phoneToken) {
    stderr(renderStepError('Failed to generate phone session. Ensure your backend is reachable.'));
    return 1;
  }

  let pairingCode = '';
  try {
    const startRes = await fetchFn(`${apiUrl}/pairing/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${phoneToken}`,
      },
      body: JSON.stringify({ machine_name: daemonConfig.machineName || os.hostname() || 'MacBook' }),
    });
    if (startRes.ok) {
      const startData = (await startRes.json()) as { pairing_code?: string };
      if (startData?.pairing_code) {
        pairingCode = startData.pairing_code;
      }
    }
  } catch {}

  if (!pairingCode) {
    pairingCode = generatePairingCode();
  }

  const pairingUrl = generatePairingUrl(webUrl, pairingCode, phoneToken, apiUrl);
  const tui = await renderPairingTui({
    webUrl,
    pairingUrl,
    pairingCode,
    daemonCommand: 'rh start (or: remote-hands daemon)',
  });

  stdout(tui);
  return 0;
}
