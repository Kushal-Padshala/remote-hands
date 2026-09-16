import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  ensureWranglerLogin,
  loginWrangler,
  createD1Database,
  applyD1Migrations,
  deployWorker,
  deployWebApp,
  type CommandRunner,
} from '../cloudflare/wrangler.js';
import { writeWranglerConfig, defaultFileSystem, type FileSystemAdapter } from '../cloudflare/project.js';
import { generatePairingUrl } from '../pairing/qr.js';
import { formatPairingSummary } from '../output/messages.js';

export interface CommandContext {
  stdout?: ((msg: string) => void) | undefined;
  stderr?: ((msg: string) => void) | undefined;
  env?: Record<string, string | undefined> | undefined;
  runner?: CommandRunner | undefined;
  fs?: FileSystemAdapter | undefined;
  fetchFn?: typeof fetch | undefined;
  projectRoot?: string | undefined;
  configDir?: string | undefined;
}

const defaultRunner: CommandRunner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    const isInteractive = options?.interactive === true;
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      shell: true,
      stdio: isInteractive ? 'inherit' : undefined,
    });
    let stdout = '';
    let stderr = '';
    if (!isInteractive) {
      proc.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
    }
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
    proc.on('error', reject);
  });
};

export async function setupCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const runner = context.runner ?? defaultRunner;
  const fs = context.fs ?? defaultFileSystem;
  const fetchFn = context.fetchFn ?? globalThis.fetch.bind(globalThis);
  const projectRoot = context.projectRoot ?? process.cwd();

  stdout('Setting up Remote Hands on Cloudflare free tier...');

  let loggedIn = await ensureWranglerLogin(runner);
  if (!loggedIn) {
    stdout('');
    stdout('Cloudflare authentication required. Launching login in your browser...');
    stdout('');
    await loginWrangler(runner);
    loggedIn = await ensureWranglerLogin(runner);
    if (!loggedIn) {
      stderr('');
      stderr('Cloudflare authentication was not completed.');
      stderr('Please run "npx wrangler login" and then re-run "npx remote-hands setup --free".');
      stderr('');
      return 1;
    }
    stdout('Cloudflare authentication successful!');
    stdout('');
  }

  stdout('Creating D1 SQLite database...');
  const d1 = await createD1Database('remote-hands-db', runner);

  const wranglerConfigPath = path.join(projectRoot, 'apps/cloudflare/wrangler.jsonc');
  await writeWranglerConfig(wranglerConfigPath, { dbId: d1.databaseId, dbName: d1.databaseName }, fs);

  stdout('Applying database migrations...');
  await applyD1Migrations(d1.databaseName, runner, path.join(projectRoot, 'apps/cloudflare'));

  stdout('Deploying backend Worker...');
  const workerRes = await deployWorker(runner, path.join(projectRoot, 'apps/cloudflare'));
  const apiUrl = workerRes.deploymentUrl ?? 'https://remote-hands-api.workers.dev';

  const ownerSecret = (crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')).slice(0, 32);

  const setupRes = await fetchFn(`${apiUrl}/setup/owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_secret: ownerSecret }),
  });

  if (!setupRes.ok) {
    stderr(`Failed to initialize owner secret on Worker: ${await setupRes.text()}`);
    return 1;
  }

  const pairingRes = await fetchFn(`${apiUrl}/pairing/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerSecret}`,
    },
    body: JSON.stringify({ machine_name: os.hostname() || 'primary-laptop' }),
  });

  let pairingCode = 'PAIR-123456';
  if (pairingRes.ok) {
    const pairingData: any = await pairingRes.json();
    pairingCode = pairingData.pairing_code ?? pairingCode;
  }

  stdout('Deploying phone web app...');
  const webRes = await deployWebApp(runner, path.join(projectRoot, 'apps/web'));
  const webUrl = webRes.pagesUrl ?? 'https://remote-hands-web.pages.dev';

  const pairingUrl = generatePairingUrl(webUrl, pairingCode);
  const summary = formatPairingSummary({
    webUrl,
    pairingUrl,
    pairingCode,
    daemonCommand: 'remote-hands daemon',
  });

  stdout(summary);
  return 0;
}
