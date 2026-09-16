import * as path from 'node:path';
import * as os from 'node:os';
import {
  ensureWranglerLogin,
  loginWrangler,
  waitForWranglerLogin,
  createD1Database,
  applyD1Migrations,
  deployWorker,
  deployWebApp,
  defaultRunner,
  type CommandRunner,
} from '../cloudflare/wrangler.js';
import { writeWranglerConfig, defaultFileSystem, type FileSystemAdapter } from '../cloudflare/project.js';
import { ensureBrowserHarness } from '../system/browser-harness.js';
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
    stdout('Listening silently in the background for authorization...');
    stdout('');

    let loginExited = false;
    const loginPromise = loginWrangler(runner).then((ok) => {
      loginExited = true;
      return ok;
    });

    const pollPromise = (async () => {
      for (let i = 0; i < 120 && !loginExited; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const ok = await ensureWranglerLogin(runner);
        if (ok) return true;
      }
      return false;
    })();

    await Promise.race([loginPromise, pollPromise]);

    loggedIn = await ensureWranglerLogin(runner);
    if (!loggedIn) {
      stderr('');
      stderr('Cloudflare authentication was not completed.');
      stderr('Please run "npx wrangler login" and then re-run "npx remote-hands setup --free".');
      stderr('');
      return 1;
    }
    stdout('Cloudflare authentication detected! Continuing setup...');
    stdout('');
  }

  stdout('Verifying browser automation harness (browser-use)...');
  await ensureBrowserHarness(runner, projectRoot, stdout, stderr, fs);

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

  let setupRes: Response | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      setupRes = await fetchFn(`${apiUrl}/setup/owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner_secret: ownerSecret }),
      });
      if (setupRes.ok || setupRes.status === 409) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (!setupRes || (!setupRes.ok && setupRes.status !== 409)) {
    stderr(`Failed to initialize owner secret on Worker: ${setupRes ? await setupRes.text() : 'network failure'}`);
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

  const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
  const daemonConfigFile = path.join(configDir, 'daemon.json');
  try {
    await fs.writeFile(
      daemonConfigFile,
      JSON.stringify(
        {
          cloudflareApiUrl: apiUrl,
          sessionToken: ownerSecret,
          machineName: os.hostname() || 'primary-laptop',
        },
        null,
        2,
      ),
    );
  } catch {}

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
