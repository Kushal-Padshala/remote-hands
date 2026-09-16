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
import {
  renderBanner,
  renderStepStart,
  renderStepInfo,
  renderStepAction,
  renderStepSuccess,
  renderStepError,
} from '../output/ui.js';

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

  stdout(renderBanner());

  stdout(renderStepStart(1, 5, 'Cloudflare Authentication'));
  let loggedIn = await ensureWranglerLogin(runner);
  if (!loggedIn) {
    stdout(renderStepAction('Launching Cloudflare OAuth login in your default browser...'));
    stdout(renderStepInfo('Listening silently in the background for authorization...'));

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
      stderr(renderStepError('Cloudflare authentication was not completed.'));
      stderr('Please run "npx wrangler login" and then re-run "npx remote-hands setup --free".');
      return 1;
    }
    stdout(renderStepSuccess('Cloudflare authentication detected'));
  } else {
    stdout(renderStepSuccess('Authenticated with Cloudflare via Wrangler'));
  }

  stdout(renderStepStart(2, 5, 'Browser Automation Engine (browser-use)'));
  stdout(renderStepInfo('Verifying browser-harness and agent skill registration...'));
  await ensureBrowserHarness(runner, projectRoot, (msg) => stdout(renderStepInfo(msg)), stderr, fs);
  stdout(renderStepSuccess('browser-harness is installed and ready'));

  stdout(renderStepStart(3, 5, 'Serverless Database (Cloudflare D1)'));
  stdout(renderStepInfo('Provisioning D1 SQLite database (remote-hands-db)...'));
  const d1 = await createD1Database('remote-hands-db', runner);

  const wranglerConfigPath = path.join(projectRoot, 'apps/cloudflare/wrangler.jsonc');
  await writeWranglerConfig(wranglerConfigPath, { dbId: d1.databaseId, dbName: d1.databaseName }, fs);

  stdout(renderStepInfo('Applying database schema migrations...'));
  await applyD1Migrations(d1.databaseName, runner, path.join(projectRoot, 'apps/cloudflare'));
  stdout(renderStepSuccess('Database created & migrations applied'));

  stdout(renderStepStart(4, 5, 'Edge Worker Backend (Durable Objects)'));
  stdout(renderStepInfo('Deploying worker with SQLite Durable Objects...'));
  const workerRes = await deployWorker(runner, path.join(projectRoot, 'apps/cloudflare'));
  const apiUrl = workerRes.deploymentUrl ?? 'https://remote-hands-api.workers.dev';

  stdout(renderStepInfo('Initializing security credentials on Worker...'));
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
    stderr(renderStepError(`Failed to initialize owner secret on Worker: ${setupRes ? await setupRes.text() : 'network failure'}`));
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
  stdout(renderStepSuccess(`Backend worker live at ${apiUrl}`));

  stdout(renderStepStart(5, 5, 'Phone Web Application'));
  stdout(renderStepInfo('Publishing static PWA assets to Cloudflare edge...'));
  const webRes = await deployWebApp(runner, path.join(projectRoot, 'apps/web'));
  const webUrl = webRes.pagesUrl ?? 'https://remote-hands-web.pages.dev';
  stdout(renderStepSuccess(`Web app live at ${webUrl}`));

  const pairingUrl = generatePairingUrl(webUrl, pairingCode);
  const summary = await formatPairingSummary({
    webUrl,
    pairingUrl,
    pairingCode,
    daemonCommand: 'remote-hands daemon',
  });

  stdout(summary);
  return 0;
}
