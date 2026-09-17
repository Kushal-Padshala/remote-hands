import * as path from 'node:path';
import * as os from 'node:os';
import * as fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolveProjectRoot(customRoot?: string | undefined): string {
  if (customRoot) {
    return customRoot;
  }
  const cwd = process.cwd();
  if (fsSync.existsSync(path.join(cwd, 'apps/cloudflare'))) {
    return cwd;
  }
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const cliDir = path.dirname(thisFile);
    const monorepoCandidate = path.resolve(cliDir, '../../..');
    if (fsSync.existsSync(path.join(monorepoCandidate, 'apps/cloudflare'))) {
      return monorepoCandidate;
    }
    const distCandidate = path.resolve(cliDir, '../..');
    if (fsSync.existsSync(path.join(distCandidate, 'apps/cloudflare'))) {
      return distCandidate;
    }
    const pkgCandidate = path.resolve(cliDir, '..');
    if (fsSync.existsSync(path.join(pkgCandidate, 'templates/apps/cloudflare'))) {
      return path.join(pkgCandidate, 'templates');
    }
    if (fsSync.existsSync(path.join(pkgCandidate, 'apps/cloudflare'))) {
      return pkgCandidate;
    }
  } catch {}
  return cwd;
}
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
import { generatePairingCode } from '@remote-hands/control-plane';
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
  once?: boolean | undefined;
}

export async function setupCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const runner = context.runner ?? defaultRunner;
  const fs = context.fs ?? defaultFileSystem;
  const fetchFn = context.fetchFn ?? globalThis.fetch.bind(globalThis);
  const projectRoot = resolveProjectRoot(context.projectRoot);

  const TOTAL_STEPS = 6;

  stdout(renderBanner());

  stdout(renderStepStart(1, TOTAL_STEPS, 'Cloudflare Authentication'));
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
      stderr('Please run "npx wrangler login" and then re-run "rh setup" (or "remote-hands setup").');
      return 1;
    }
    stdout(renderStepSuccess('Cloudflare authentication detected'));
  } else {
    stdout(renderStepSuccess('Authenticated with Cloudflare via Wrangler'));
  }

  stdout(renderStepStart(2, TOTAL_STEPS, 'AI Coding Agent (agy)'));
  const agyWhich = await runner('which', ['agy']);
  const agyInstalled = agyWhich.exitCode === 0 && agyWhich.stdout.trim().length > 0;

  if (!agyInstalled) {
    stdout(renderStepAction('agy CLI not found — installing now...'));
    if (process.platform === 'win32') {
      stdout(renderStepInfo('Run this in PowerShell: irm https://antigravity.google/cli/install.ps1 | iex'));
      const winRes = await runner('powershell', ['-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'], { interactive: true });
      if (winRes.exitCode !== 0) {
        stderr(renderStepError('Failed to install agy. Please install manually:'));
        stderr('  PowerShell: irm https://antigravity.google/cli/install.ps1 | iex');
        stderr('Then re-run "rh setup".');
        return 1;
      }
    } else {
      stdout(renderStepInfo('Running: curl -fsSL https://antigravity.google/cli/install.sh | bash'));
      const installRes = await runner('bash', ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'], { interactive: true });
      if (installRes.exitCode !== 0) {
        stderr(renderStepError('Failed to install agy. Please install manually:'));
        stderr('  curl -fsSL https://antigravity.google/cli/install.sh | bash');
        stderr('Then re-run "rh setup".');
        return 1;
      }
    }

    const verifyInstall = await runner('which', ['agy']);
    if (verifyInstall.exitCode !== 0) {
      stdout(renderStepInfo('agy installed but not in PATH yet — running agy install...'));
      await runner('agy', ['install'], { interactive: true });
    }
    stdout(renderStepSuccess('agy CLI installed successfully'));
  } else {
    stdout(renderStepInfo(`agy found at ${agyWhich.stdout.trim()}`));
  }

  stdout(renderStepInfo('Verifying agy authentication...'));
  const agyAuth = await runner('agy', ['-p', 'echo hello', '--print-timeout', '10s']);
  const agyAuthOutput = (agyAuth.stdout + '\n' + agyAuth.stderr).toLowerCase();
  const agyNeedsLogin = agyAuth.exitCode !== 0 ||
    agyAuthOutput.includes('not authenticated') ||
    agyAuthOutput.includes('sign in') ||
    agyAuthOutput.includes('login') ||
    agyAuthOutput.includes('oauth') ||
    agyAuthOutput.includes('authorize');

  if (agyNeedsLogin) {
    stdout(renderStepAction('agy requires sign-in — launching interactive session...'));
    if (process.platform === 'darwin' || process.platform === 'linux') {
      stdout(renderStepInfo('Your browser will open for Google OAuth sign-in.'));
    } else {
      stdout(renderStepInfo('Follow the on-screen instructions to sign in with your Google account.'));
    }
    await runner('agy', [], { interactive: true });

    const agyRecheck = await runner('agy', ['-p', 'echo hello', '--print-timeout', '10s']);
    if (agyRecheck.exitCode !== 0) {
      stderr(renderStepError('agy sign-in was not completed.'));
      stderr('Please run "agy" in your terminal to sign in, then re-run "rh setup".');
      return 1;
    }
    stdout(renderStepSuccess('agy authenticated and ready'));
  } else {
    stdout(renderStepSuccess('agy is installed and authenticated'));
  }

  stdout(renderStepStart(3, TOTAL_STEPS, 'Browser Automation Engine (browser-use)'));
  stdout(renderStepInfo('Verifying browser-harness and agent skill registration...'));
  await ensureBrowserHarness(runner, projectRoot, (msg) => stdout(renderStepInfo(msg)), stderr, fs);
  stdout(renderStepSuccess('browser-harness is installed and ready'));

  stdout(renderStepStart(4, TOTAL_STEPS, 'Serverless Database (Cloudflare D1)'));
  stdout(renderStepInfo('Provisioning D1 SQLite database (remote-hands-db)...'));
  const d1 = await createD1Database('remote-hands-db', runner);

  const wranglerConfigPath = path.join(projectRoot, 'apps/cloudflare/wrangler.jsonc');
  await writeWranglerConfig(wranglerConfigPath, { dbId: d1.databaseId, dbName: d1.databaseName }, fs);

  stdout(renderStepInfo('Applying database schema migrations...'));
  await applyD1Migrations(d1.databaseName, runner, path.join(projectRoot, 'apps/cloudflare'));
  stdout(renderStepSuccess('Database created & migrations applied'));

  stdout(renderStepStart(5, TOTAL_STEPS, 'Edge Worker Backend (Durable Objects)'));
  stdout(renderStepInfo('Deploying worker with SQLite Durable Objects...'));
  const workerRes = await deployWorker(runner, path.join(projectRoot, 'apps/cloudflare'));
  const apiUrl = workerRes.deploymentUrl ?? 'https://remote-hands-api.workers.dev';

  stdout(renderStepInfo('Initializing security credentials on Worker...'));
  const ownerSecret = (crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')).slice(0, 32);

  let setupRes: Response | undefined;
  let ownerSessionToken = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      setupRes = await fetchFn(`${apiUrl}/setup/owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner_secret: ownerSecret }),
      });
      if (setupRes.ok) {
        try {
          const setupData = (await setupRes.json()) as { session_token?: string };
          if (setupData?.session_token) {
            ownerSessionToken = setupData.session_token;
          }
        } catch {}
        break;
      }
      if (setupRes.status === 409) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (!setupRes || (!setupRes.ok && setupRes.status !== 409)) {
    stderr(renderStepError(`Failed to initialize owner secret on Worker: ${setupRes ? await setupRes.text() : 'network failure'}`));
    return 1;
  }

  const effectiveOwnerToken = ownerSessionToken || ownerSecret;

  const machinePairingRes = await fetchFn(`${apiUrl}/pairing/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${effectiveOwnerToken}`,
    },
    body: JSON.stringify({ machine_name: os.hostname() || 'primary-laptop' }),
  });

  let machinePairingCode = '';
  if (machinePairingRes.ok) {
    try {
      const pairingData = (await machinePairingRes.json()) as { pairing_code?: string };
      if (pairingData?.pairing_code) {
        machinePairingCode = pairingData.pairing_code;
      }
    } catch {}
  }
  if (!machinePairingCode) {
    machinePairingCode = generatePairingCode();
  }

  let daemonSessionToken = effectiveOwnerToken;
  let machineId: string | undefined;

  try {
    const claimRes = await fetchFn(`${apiUrl}/pairing/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_code: machinePairingCode,
        hostname: os.hostname() || 'primary-laptop',
        daemon_version: '0.1.0',
        agy_version: '0.2.0',
      }),
    });
    if (claimRes.ok) {
      const claimData = (await claimRes.json()) as { session_token?: string; machine_id?: string };
      if (claimData?.session_token) {
        daemonSessionToken = claimData.session_token;
      }
      machineId = claimData?.machine_id;
    }
  } catch {}

  const activePairingRes = await fetchFn(`${apiUrl}/pairing/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${effectiveOwnerToken}`,
    },
    body: JSON.stringify({ machine_name: os.hostname() || 'primary-laptop' }),
  });

  let activePairingCode = '';
  if (activePairingRes.ok) {
    try {
      const activeData = (await activePairingRes.json()) as { pairing_code?: string };
      if (activeData?.pairing_code) {
        activePairingCode = activeData.pairing_code;
      }
    } catch {}
  }
  if (!activePairingCode) {
    activePairingCode = generatePairingCode();
  }

  const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
  const daemonConfigFile = path.join(configDir, 'daemon.json');
  try {
    await fs.writeFile(
      daemonConfigFile,
      JSON.stringify(
        {
          cloudflareApiUrl: apiUrl,
          sessionToken: daemonSessionToken,
          machineId: machineId,
          machineName: os.hostname() || 'primary-laptop',
        },
        null,
        2,
      ),
    );
  } catch {}
  stdout(renderStepSuccess(`Backend worker live at ${apiUrl}`));

  stdout(renderStepStart(6, TOTAL_STEPS, 'Phone Web Application'));
  stdout(renderStepInfo('Publishing static PWA assets to Cloudflare edge...'));
  const webRes = await deployWebApp(runner, path.join(projectRoot, 'apps/web'));
  const webUrl = webRes.pagesUrl ?? 'https://remote-hands-web.pages.dev';
  stdout(renderStepSuccess(`Web app live at ${webUrl}`));

  const pairingUrl = generatePairingUrl(webUrl, activePairingCode, effectiveOwnerToken, apiUrl);
  const summary = await formatPairingSummary({
    webUrl,
    pairingUrl,
    pairingCode: activePairingCode,
    daemonCommand: 'rh start (or: remote-hands daemon)',
  });

  stdout(summary);
  return 0;
}
