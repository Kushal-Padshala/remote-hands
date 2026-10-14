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
import { ensureRemoteHandsOperatorSkill } from '../system/operator-skill.js';
import { agyPermissionDisclosure, checkAgyPermissions, ensureAgyPermissions, readAgyConsent } from '../system/agy-permissions.js';
import { ensureMacPermissions } from '../system/mac-permissions.js';
import { ensureCloudflaredBinary } from '../system/tunnel.js';
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
  c,
} from '../output/ui.js';

import { ChromeManager as ChromeLookup, HudServiceManager, SpotlightHudRunner, hudHotkeyLabel, type BrowserExecutable, type ChromeManager, type DynamicPowerManager } from '@remote-hands/daemon';
import { defaultAsk } from './browser-setup.js';
import { beginCommandLineTools, type CommandLineToolsHandle } from '../system/xcode-tools.js';
import { waitForMacHudStatus, type MacHudStatus } from '../system/hud-mac-status.js';
import { openMacPrivacySettings } from '../system/mac-permissions.js';
import { AGY_WINDOWS_INSTALL, agyRunOptions, agyShellCommand, locateAgy } from '../system/agy.js';
import { mcpCommand } from './mcp.js';

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
  chromeManager?: ChromeManager | undefined;
  powerManager?: DynamicPowerManager | undefined;
  client?: any;
  frameSource?: any;
  localStore?: any;
  hudServiceManager?: any | undefined;
  /** Injected pieces of `rh fast-lane` and the HUD's fast lane (tests): the local model service, home folder and memory. */
  fastLane?: {
    inference?: Pick<import('@remote-hands/daemon').FastLaneInference, 'status' | 'install'> | undefined;
    homeDir?: string | undefined;
    totalRamBytes?: number | undefined;
  } | undefined;
  /** Builds the Shift+Cmd+Space helper during HUD setup (tests replace it; mocked runs skip the real build). */
  prepareHotkeyHelper?: (() => { ok: true; path: string } | { ok: false; error: string }) | undefined;
  /** Registers the computer-use tools with agy (tests replace it; a test runner otherwise skips the step). */
  installMcp?: (() => Promise<number>) | undefined;
  /** Windows: where Chrome or Edge is installed (tests replace it). */
  findBrowser?: (() => BrowserExecutable | undefined) | undefined;
  /** Injected AppleScript transport for `rh browser doctor` (tests). */
  browserTransport?: import('./browser-doctor.js').BrowserDoctorTransport | undefined;
  /** Injected pieces of `rh browser setup` (tests): setup service, prompt, TTY flag, state file. */
  browserSetup?: Partial<import('./browser-setup.js').BrowserSetupOptions> | undefined;
  /** Replaces the once-only browser setup offer made by `rh hud` and `rh setup` (tests). */
  browserSetupOffer?: (() => Promise<void>) | undefined;
  /** Starts the Apple Command Line Tools install on a Mac that lacks them (tests replace it; a mocked run skips the step). */
  beginCommandLineTools?: ((out: (message: string) => void) => CommandLineToolsHandle) | undefined;
  /** Reads what the background HUD says about its own permissions after it starts (tests replace it; a mocked run skips the check). */
  verifyMacHud?: (() => Promise<MacHudStatus | null>) | undefined;
  /** Prompt used by `rh setup` to ask what to set up (tests). */
  ask?: ((question: string) => Promise<string>) | undefined;
  /** Whether stdin is a terminal (tests); defaults to process.stdin.isTTY. */
  isTTY?: boolean | undefined;
}

async function setupAgentAndPermissions(
  args: string[],
  context: CommandContext,
  runner: CommandRunner,
  fs: FileSystemAdapter,
  projectRoot: string,
  stdout: (msg: string) => void,
  stderr: (msg: string) => void,
  stepNum: number,
  totalSteps: number,
): Promise<number | null> {
  stdout(renderStepStart(stepNum, totalSteps, 'AI Coding Agent (agy)'));
  // A Mac without Apple's Command Line Tools starts their (long) download now, while the agent is set up below
  let commandLineTools: CommandLineToolsHandle | undefined;
  if (process.platform === 'darwin') {
    const info = (message: string): void => stdout(renderStepInfo(message));
    if (context.beginCommandLineTools) commandLineTools = context.beginCommandLineTools(info);
    else if (!context.runner) commandLineTools = beginCommandLineTools({ stdout: info });
  }
  const agyFound = await locateAgy(runner);
  const agyInstalled = agyFound !== undefined;
  let agyPath = agyFound;

  if (!agyInstalled) {
    stdout(renderStepAction('agy CLI not found — installing now...'));
    if (process.platform === 'win32') {
      stdout(renderStepInfo(`Running in PowerShell: ${AGY_WINDOWS_INSTALL.manual}`));
      const winRes = await runner(AGY_WINDOWS_INSTALL.command, AGY_WINDOWS_INSTALL.args, { interactive: true });
      if (winRes.exitCode !== 0) {
        stderr(renderStepError('Failed to install agy. Please install manually:'));
        stderr(`  PowerShell: ${AGY_WINDOWS_INSTALL.manual}`);
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

    const verified = await locateAgy(runner);
    agyPath = verified;
    if (verified === undefined) {
      if (process.platform === 'win32') {
        stderr(renderStepError('agy was installed but cannot be found yet.'));
        stderr('Close this window, open a new PowerShell window, and run "rh setup" again.');
        return 1;
      }
      stdout(renderStepInfo('agy installed but not in PATH yet — running agy install...'));
      await runner('agy', ['install'], { interactive: true });
    }
    stdout(renderStepSuccess('agy CLI installed successfully'));
  } else {
    stdout(renderStepInfo(`agy found at ${agyFound}`));
  }
  // On Windows the full path (a new terminal is not needed for it); elsewhere the plain name, as always.
  const agy = agyShellCommand(agyPath);
  // Windows: the program is run directly, not through a shell
  const agyOpts = agyRunOptions(agyPath);

  stdout(renderStepInfo('Verifying agy authentication...'));
  const agyNeedsLogin = await agyNeedsSignIn(runner, agy, agyOpts);

  if (agyNeedsLogin) {
    stdout(renderStepAction('agy requires sign-in — launching interactive session...'));
    if (process.platform === 'darwin' || process.platform === 'linux') {
      stdout(renderStepInfo('Your browser will open: sign in with your Google account there.'));
    } else {
      stdout(renderStepInfo('Follow the on-screen instructions to sign in with your Google account.'));
    }
    stdout(renderStepInfo('When agy shows that you are signed in (a box where you can type), press Ctrl+C to come back here. Setup then carries on by itself.'));
    // Ctrl+C reaches this program too (same terminal): it is meant for agy, so setup must not end with it.
    const ignoreInterrupt = (): void => {};
    process.on('SIGINT', ignoreInterrupt);
    try {
      await runner(agy, [], { interactive: true, ...agyOpts });
    } finally {
      process.off('SIGINT', ignoreInterrupt);
    }

    const agyRecheck = await (agyOpts ? runner(agy, ['-p', 'reply with ok', '--print-timeout', '60s'], agyOpts) : runner(agy, ['-p', 'reply with ok', '--print-timeout', '60s']));
    if (agyRecheck.exitCode !== 0) {
      stderr(renderStepError('agy sign-in was not completed.'));
      stderr('Please run "agy" in your terminal to sign in, then re-run "rh setup".');
      return 1;
    }
    stdout(renderStepSuccess('agy authenticated and ready'));
  } else {
    stdout(renderStepSuccess('agy is installed and authenticated'));
  }

  // The agy settings change is shown and agreed to first (a terminal is asked; --yes or no terminal goes ahead, as before)
  const alreadyApplied = (await readAgyConsent(fs)) === 'granted' || (await checkAgyPermissions(fs));
  if (!alreadyApplied) {
    for (const line of agyPermissionDisclosure()) stdout(renderStepInfo(line));
    const interactive = context.isTTY ?? Boolean(process.stdin.isTTY);
    if (interactive && !args.includes('--yes')) {
      const answer = (await (context.ask ?? defaultAsk)('Allow this? [Y/n] ')).trim().toLowerCase();
      if (answer !== '' && answer !== 'y' && answer !== 'yes') {
        stderr(renderStepError('Remote Hands cannot run tasks without these agy settings, so setup stops here. Nothing was changed.'));
        stderr('Run "rh setup" again whenever you are ready.');
        return 1;
      }
    }
  }
  const permissionsOk = await ensureAgyPermissions(fs, projectRoot, { explicit: true });
  if (permissionsOk) {
    stdout(renderStepSuccess('Configured headless tool permissions and trusted workspaces for agy'));
  }

  if (commandLineTools && !(await commandLineTools.wait())) {
    stderr(renderStepError('The Command Line Tools install did not finish.'));
    stderr('Finish the macOS install window (or run "xcode-select --install"), then run "rh setup" again.');
    return 1;
  }

  if (process.platform === 'darwin' && !context.runner && !args.includes('--skip-permissions')) {
    stdout(renderStepAction('Verifying macOS system permissions (Screen Recording, Full Disk Access, Accessibility)...'));
    await ensureMacPermissions((msg) => stdout(msg), 74, { fullDiskAccessOptional: true });
  }

  return null;
}

export async function setupCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const runner = context.runner ?? defaultRunner;
  const fs = context.fs ?? defaultFileSystem;
  const fetchFn = context.fetchFn ?? globalThis.fetch.bind(globalThis);
  const projectRoot = resolveProjectRoot(context.projectRoot);

  if (args.includes('--help') || args.includes('-h')) {
    stdout('Usage: rh setup [--hud | --remote] [--yes] [--local] [--skip-permissions]');
    stdout('');
    stdout('Guided setup. Without a flag it asks what to set up first:');
    stdout('  --hud     Desktop HUD on this computer: agent, permissions, tools, background service');
    stdout('  --remote  Remote use from your phone: Cloudflare Worker, D1 and pairing');
    stdout('  --yes     do not ask before changing settings');
    return 0;
  }

  const isLocal = args.includes('--local') || (context as any).local === true;

  // `rh setup` asks what to set up first. The desktop HUD flow does everything it needs
  // up front; remote (phone) use keeps the existing Cloudflare flow. Without a terminal
  // and without a flag the old behaviour is unchanged.
  if (!isLocal) {
    let mode: 'hud' | 'remote' | 'default' = args.includes('--hud') ? 'hud' : args.includes('--remote') ? 'remote' : 'default';
    if (mode === 'default' && (context.isTTY ?? Boolean(process.stdin.isTTY))) {
      mode = await askSetupMode(context.ask ?? defaultAsk, stdout);
    }
    if (mode === 'hud') {
      return hudSetupFlow(args, context, runner, fs, projectRoot, stdout, stderr);
    }
  }

  if (isLocal) {
    const LOCAL_STEPS = 4;
    stdout(renderBanner());

    const agyErr = await setupAgentAndPermissions(args, context, runner, fs, projectRoot, stdout, stderr, 1, LOCAL_STEPS);
    if (agyErr !== null) return agyErr;

    stdout(renderStepStart(2, LOCAL_STEPS, 'Browser Automation Engine (browser-use)'));
    stdout(renderStepInfo('Verifying browser-harness and agent skill registration...'));
    await ensureBrowserHarness(runner, projectRoot, (msg) => stdout(renderStepInfo(msg)), stderr, fs);
    await ensureRemoteHandsOperatorSkill(fs, projectRoot);
    stdout(renderStepSuccess('browser-harness and remote-hands-operator skills are ready'));

    stdout(renderStepStart(3, LOCAL_STEPS, 'Account-less Remote Tunnel (cloudflared)'));
    if (!context.runner) {
      await ensureCloudflaredBinary((msg) => stdout(renderStepInfo(msg)));
    }
    stdout(renderStepSuccess('Tunnel binary ready for zero-account remote access'));

    stdout(renderStepStart(4, LOCAL_STEPS, `Desktop Overlay Assistant (${hudHotkeyLabel()})`));
    const skipHud = args.includes('--no-hud') || args.includes('--skip-hud');
    const hudService = context.hudServiceManager ?? (context.runner ? {
      install: () => ({ success: true, plistPath: '/mock/LaunchAgents/com.remote-hands.hud.plist' }),
      isInstalled: () => true,
      isRunning: () => true,
    } : new HudServiceManager());

    if (!skipHud && process.platform === 'darwin') {
      const installRes = hudService.install();
      if (installRes.success) {
        stdout(renderStepSuccess(`Desktop Overlay Assistant installed and active (${hudHotkeyLabel()})`));
      } else {
        stdout(renderStepInfo(`Desktop Overlay note: ${installRes.error || 'could not auto-load LaunchAgent'}`));
      }
    } else if (skipHud) {
      stdout(renderStepInfo('Desktop Overlay installation skipped via flag'));
    } else {
      stdout(renderStepInfo('Desktop Overlay hotkey service is supported on macOS'));
    }

    const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
    const daemonConfigFile = path.join(configDir, 'daemon.json');
    const tokenFile = path.join(configDir, 'local-token.txt');
    let pairingToken = crypto.randomUUID().replace(/-/g, '');
    try {
      if (await fs.exists(tokenFile)) {
        pairingToken = (await fs.readFile(tokenFile)).trim() || pairingToken;
      } else {
        await fs.writeFile(tokenFile, pairingToken);
      }
    } catch {}
    try {
      await fs.writeFile(
        daemonConfigFile,
        JSON.stringify({ mode: 'local' }, null, 2),
      );
    } catch {}

    stdout('\n' + renderStepSuccess('Zero-account local setup complete!'));
    stdout(`\n  ${c.bold('1. Desktop Use (Active now):')}`);
    stdout(`     Press ${c.bold(hudHotkeyLabel())} anywhere to open the prompt textbox overlay.`);
    stdout(`     It works in the background on any app or browser with zero idle CPU.`);
    stdout(`     No need to run "rh start" while working on your computer.\n`);
    stdout(`  ${c.bold('2. Remote Mobile Use:')}`);
    stdout(`     Run "${c.cyan('rh start')}" only when stepping away from your computer to pair your phone.\n`);
    return 0;
  }

  const TOTAL_STEPS = 7;

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

  const agyErr = await setupAgentAndPermissions(args, context, runner, fs, projectRoot, stdout, stderr, 2, TOTAL_STEPS);
  if (agyErr !== null) return agyErr;

  stdout(renderStepStart(3, TOTAL_STEPS, 'Browser Automation Engine (browser-use)'));
  stdout(renderStepInfo('Verifying browser-harness and agent skill registration...'));
  await ensureBrowserHarness(runner, projectRoot, (msg) => stdout(renderStepInfo(msg)), stderr, fs);
  await ensureRemoteHandsOperatorSkill(fs, projectRoot);
  stdout(renderStepSuccess('browser-harness and remote-hands-operator skills are ready'));

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
  try {
    await fs.writeFile(
      daemonConfigFile,
      JSON.stringify(
        {
          cloudflareApiUrl: apiUrl,
          sessionToken: daemonSessionToken,
          machineId: machineId,
          machineName: os.hostname() || 'primary-laptop',
          webAppUrl: webUrl,
        },
        null,
        2,
      ),
    );
  } catch {}
  stdout(renderStepSuccess(`Web app live at ${webUrl}`));

  stdout(renderStepStart(7, TOTAL_STEPS, `Desktop Overlay Assistant (${hudHotkeyLabel()})`));
  const skipHud = args.includes('--no-hud') || args.includes('--skip-hud');
  const hudService = context.hudServiceManager ?? (context.runner ? {
    install: () => ({ success: true, plistPath: '/mock/LaunchAgents/com.remote-hands.hud.plist' }),
    isInstalled: () => true,
    isRunning: () => true,
  } : new HudServiceManager());

  if (!skipHud && process.platform === 'darwin') {
    const installRes = hudService.install();
    if (installRes.success) {
      stdout(renderStepSuccess(`Desktop Overlay Assistant installed and active (${hudHotkeyLabel()})`));
    } else {
      stdout(renderStepInfo(`Desktop Overlay note: ${installRes.error || 'could not auto-load LaunchAgent'}`));
    }
  } else if (skipHud) {
    stdout(renderStepInfo('Desktop Overlay installation skipped via flag'));
  } else {
    stdout(renderStepInfo('Desktop Overlay hotkey service is supported on macOS'));
  }

  const pairingUrl = generatePairingUrl(webUrl, activePairingCode, effectiveOwnerToken, apiUrl);
  const summary = await formatPairingSummary({
    webUrl,
    pairingUrl,
    pairingCode: activePairingCode,
    daemonCommand: 'rh start (or: remote-hands daemon)',
  });

  stdout(summary);
  stdout(`\n  ${c.bold('Desktop vs Remote Use:')}`);
  stdout(`  • ${c.bold('Desktop Use:')} Press ${c.bold(hudHotkeyLabel())} anywhere to use the overlay assistant directly.`);
  stdout(`    It is active in the background. You do not need to run "rh start" while at your computer.`);
  stdout(`  • ${c.bold('Remote Use:')} Run "${c.cyan('rh start')}" when stepping away to connect from your phone over any network.\n`);
  return 0;
}

const AUTH_HINTS = ['not authenticated', 'sign in', 'sign-in', 'log in', 'login', 'oauth', 'authorize'];

/**
 * Is sign-in needed? `agy models` answers quickly when signed in, so it is tried first.
 * Only when it does not settle the question a real prompt is sent, with a generous
 * timeout (a cold agy takes a while to load its MCP servers: a slow answer is not a
 * missing sign-in). Sign-in is requested only when agy's own output asks for it.
 */
async function agyNeedsSignIn(runner: CommandRunner, agy = 'agy', opts?: { shell: false }): Promise<boolean> {
  const models = await (opts ? runner(agy, ['models'], opts) : runner(agy, ['models']));
  const modelsText = `${models.stdout}\n${models.stderr}`.toLowerCase();
  if (models.exitCode === 0 && /gemini|claude|gpt/.test(modelsText) && !AUTH_HINTS.some((h) => modelsText.includes(h))) {
    return false;
  }
  const probe = await (opts ? runner(agy, ['-p', 'reply with ok', '--print-timeout', '60s'], opts) : runner(agy, ['-p', 'reply with ok', '--print-timeout', '60s']));
  const text = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
  return AUTH_HINTS.some((h) => text.includes(h));
}

async function askSetupMode(
  ask: (question: string) => Promise<string>,
  stdout: (msg: string) => void,
): Promise<'hud' | 'remote'> {
  stdout(renderBanner());
  stdout('What do you want to set up right now?\n');
  stdout(`  ${c.bold('1) Desktop HUD')}   Press ${hudHotkeyLabel()} on this computer and tell it what to do (recommended)`);
  stdout(`  ${c.bold('2) Remote use')}    Control this computer from your phone (needs a free Cloudflare account)\n`);
  for (;;) {
    const answer = (await ask('Choose 1 or 2 [1]: ')).trim().toLowerCase();
    if (answer === '' || answer === '1' || answer === 'hud') return 'hud';
    if (answer === '2' || answer === 'remote') return 'remote';
    stdout('Please type 1 or 2.');
  }
}

/**
 * macOS gives Screen Recording to one specific program. The HUD runs as a login service with its own Node, not as the
 * terminal this setup runs in, so the permission just granted may not reach it. The service reports what it found; when it
 * is missing the person is told exactly which program to switch on, and the service is restarted to check again.
 */
async function verifyMacServicePermission(
  firstStatus: MacHudStatus | null,
  readAgain: () => Promise<MacHudStatus | null>,
  restart: () => boolean,
  interactive: boolean,
  ask: (question: string) => Promise<string>,
  stdout: (msg: string) => void,
): Promise<'ok' | 'missing' | 'unknown'> {
  let status = firstStatus;
  if (!status) {
    stdout(renderStepInfo('The background HUD has not reported its permissions yet: check later with "rh doctor".'));
    return 'unknown';
  }
  for (let round = 0; ; round += 1) {
    if (status.screenRecording) return 'ok';
    stdout(renderStepInfo('The background HUD does not have Screen & System Audio Recording yet. macOS gives it to one program at a time, and the HUD runs as its own:'));
    stdout(renderStepInfo(`  switch ON "node"   (${status.node})`));
    stdout(renderStepInfo('  in System Settings -> Privacy & Security -> Screen & System Audio Recording (click [+] and press Cmd+Shift+G to paste the path if it is not listed).'));
    openMacPrivacySettings('ScreenCapture');
    if (!interactive || round >= 3) return 'missing';
    const answer = (await ask('Press Enter once it is switched on (or type s to skip): ')).trim().toLowerCase();
    if (answer === 's' || answer === 'skip') return 'missing';
    const since = Date.now();
    restart();
    status = await readAgain();
    if (!status || status.at < since) {
      stdout(renderStepInfo('The background HUD did not answer after the restart.'));
      return 'unknown';
    }
  }
}

/**
 * Everything the desktop HUD needs, in one pass and in this order: the agent and its
 * permissions, macOS permissions, the computer-use
 * tools registered with the agent, then the background HUD service. Each step explains
 * what it does and asks before changing anything that matters.
 */
async function hudSetupFlow(
  args: string[],
  context: CommandContext,
  runner: CommandRunner,
  fs: FileSystemAdapter,
  projectRoot: string,
  stdout: (msg: string) => void,
  stderr: (msg: string) => void,
): Promise<number> {
  // Windows has one more step: the browser Remote Hands drives
  const windows = process.platform === 'win32';
  const TOTAL = windows ? 5 : 4;
  stdout(renderBanner());

  const agyErr = await setupAgentAndPermissions(args, context, runner, fs, projectRoot, stdout, stderr, 1, TOTAL);
  if (agyErr !== null) return agyErr;

  stdout(renderStepStart(2, TOTAL, 'Computer-use tools for the agent'));
  const mcpOpts: Parameters<typeof mcpCommand>[1] = {
    stdout: (msg) => stdout(renderStepInfo(msg)),
    stderr,
  };
  // What must work for the HUD to do anything. On Windows a missing piece stops "ready" from being claimed.
  const blockers: string[] = [];
  if (context.runner && !context.installMcp) {
    stdout(renderStepInfo('Skipped in test mode'));
  } else {
    const mcpCode = await (context.installMcp ?? (() => mcpCommand(['install'], mcpOpts)))();
    if (mcpCode === 0) {
      stdout(renderStepSuccess('Registered the rh-computer tools with agy'));
    } else {
      stdout(renderStepInfo('Could not register the computer-use tools; run "rh mcp install" after fixing the message above.'));
      if (windows) blockers.push('the browser tools could not be registered with the agent (run "rh mcp install")');
    }
  }

  let step = 3;
  if (windows) {
    stdout(renderStepStart(step, TOTAL, 'Browser for Remote Hands'));
    const browser = (context.findBrowser ?? (() => ChromeLookup.findBrowserExecutable()))();
    if (browser) {
      stdout(renderStepSuccess(browser.kind === 'chrome' ? 'Google Chrome found' : 'Microsoft Edge found (used because Google Chrome is not installed)'));
      stdout(renderStepInfo('Remote Hands opens its own browser window the first time you ask for something on the web. Sign in to the sites you want it to use in that window, once; it remembers.'));
    } else {
      stdout(renderStepInfo('No Chrome or Edge was found. Install Google Chrome from https://www.google.com/chrome and run "rh setup" again.'));
      blockers.push('no Chrome or Edge browser was found');
    }
    step += 1;
  }
  stdout(renderStepStart(step, TOTAL, 'Desktop HUD background service'));
  const hudService =
    context.hudServiceManager ??
    (context.runner
      ? {
          install: () => ({ success: true, plistPath: '/mock/LaunchAgents/com.remote-hands.hud.plist' }),
          isInstalled: () => true,
          isRunning: () => true,
        }
      : new HudServiceManager());
  let helperError: string | null = null;
  let unconfirmed = false;
  let screenMissing = false;
  let shortcutNote: string | null = null;
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    stdout(renderStepInfo('The desktop HUD hotkey service is supported on macOS and Windows.'));
  } else {
    // Build the hotkey helper now so a missing toolchain is reported here, not as a silent hotkey later.
    const prepare =
      context.prepareHotkeyHelper ??
      (context.runner ? () => ({ ok: true as const, path: '/mock/rh-spotlight' }) : () => new SpotlightHudRunner().prepare());
    const helper = prepare();
    if (helper.ok) {
      stdout(renderStepSuccess(`${hudHotkeyLabel()} helper is built`));
    } else {
      helperError = helper.error;
      stdout(renderStepInfo(`${hudHotkeyLabel()} helper: ${helper.error}`));
    }
    const installedAt = Date.now();
    const res = hudService.install();
    if (res.success) {
      stdout(renderStepSuccess('Desktop HUD installed and running in the background'));
      if (process.platform === 'darwin' && (context.verifyMacHud || !context.runner)) {
        stdout(renderStepInfo('Checking the background HUD can use Screen Recording...'));
        const read = context.verifyMacHud ?? (() => waitForMacHudStatus({ since: installedAt }));
        const outcome = await verifyMacServicePermission(
          await read(),
          context.verifyMacHud ?? (() => waitForMacHudStatus({ since: Date.now() - 1 })),
          () => (typeof (hudService as { restart?: () => boolean }).restart === 'function' ? (hudService as { restart: () => boolean }).restart() : false),
          context.isTTY ?? Boolean(process.stdin.isTTY),
          context.ask ?? defaultAsk,
          stdout,
        );
        if (outcome === 'ok') stdout(renderStepSuccess('The background HUD can use Screen Recording'));
        if (outcome === 'missing') screenMissing = true;
      }
      // Say whether the HUD really holds its shortcut before telling the person to press it
      const wait = (hudService as { waitForHotkey?: (timeoutMs?: number) => Promise<{ state: string } | null> }).waitForHotkey;
      if ((process.platform === 'win32' || process.platform === 'darwin') && typeof wait === 'function') {
        const status = await wait.call(hudService, process.platform === 'darwin' ? 20_000 : undefined);
        if (status?.state === 'failed') {
          if (process.platform === 'win32') {
            helperError = 'the shortcut (Ctrl + Shift + Space, or Ctrl + Alt + Space) is already used by another program: close that program or change its shortcut, then run "rh hud install"';
            stdout(renderStepInfo(`Shortcut: ${helperError}`));
          } else {
            shortcutNote = `${hudHotkeyLabel()} is already used by another app (for example Raycast or Alfred), so the HUD may not open with it: change that app's shortcut, then run "rh hud install"`;
            stdout(renderStepInfo(`Shortcut: ${shortcutNote}`));
          }
        } else if (!status) {
          unconfirmed = true;
          stdout(renderStepInfo('The HUD has not confirmed its shortcut yet: check it in a minute with "rh doctor".'));
        }
      }
    } else {
      stdout(renderStepInfo(`Desktop HUD note: ${res.error || 'could not auto-load the LaunchAgent'}`));
      if (windows) blockers.push(`the HUD could not be installed (${res.error || 'unknown reason'})`);
    }
  }

  stdout(renderStepStart(TOTAL, TOTAL, 'Done'));
  if (blockers.length > 0) {
    for (const b of blockers) stdout(renderStepInfo(`Not ready: ${b}.`));
    stdout(renderStepInfo('Fix that, then run "rh setup --hud" again.'));
    return 1;
  }
  if (helperError) {
    stdout(renderStepInfo('Desktop HUD is installed but the hotkey will not work yet (see above).'));
    return 1;
  }
  if (screenMissing) {
    stdout(renderStepInfo(`Desktop HUD is installed and ${hudHotkeyLabel()} works, but tasks that need to see the screen will not until Screen Recording is switched on for the program above.`));
    stdout(renderStepInfo('When it is, run "rh hud install" to restart the HUD, then check with "rh doctor".'));
    return 0;
  }
  if (shortcutNote) {
    stdout(renderStepInfo(`Desktop HUD is installed, but ${shortcutNote}.`));
    return 0;
  }
  if (unconfirmed) {
    stdout(renderStepInfo('Desktop HUD is installed, but its shortcut is not confirmed yet. Give it a minute, then check with "rh doctor".'));
    return 0;
  }
  stdout(renderStepSuccess('Desktop HUD is ready'));
  stdout(`\n  Press ${c.bold(hudHotkeyLabel())} anywhere and type what you want done.`);
  stdout('  The first request after logging in takes a few seconds longer while the agent starts.');
  stdout(`  Check that it is running any time with "${c.cyan('rh hud status')}".`);
  stdout(`  Remote (phone) use is not set up yet: run "${c.cyan('rh setup --remote')}" when you want it.\n`);
  return 0;
}
