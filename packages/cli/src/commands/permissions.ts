import {
  checkMacFullDiskAccess,
  checkMacScreenCapture,
  checkMacAccessibility,
  ensureMacPermissions,
} from '../system/mac-permissions.js';
import {
  checkAgyPermissions,
  ensureAgyPermissions,
  readAgyConsent,
  revertAgyPermissions,
} from '../system/agy-permissions.js';
import { HudServiceManager } from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';
import { c } from '../output/ui.js';

export interface PermissionsReport {
  screenCapture: boolean;
  fullDiskAccess: boolean;
  accessibility: boolean;
  antigravity: boolean;
  allGranted: boolean;
}

export async function checkAllPermissions(context: CommandContext = {}): Promise<PermissionsReport> {
  const isDarwin = process.platform === 'darwin';
  const screenCapture = isDarwin ? checkMacScreenCapture() : true;
  const fullDiskAccess = isDarwin ? checkMacFullDiskAccess() : true;
  const accessibility = isDarwin ? checkMacAccessibility() : true;
  const antigravity = await checkAgyPermissions(context.fs);

  const allGranted = screenCapture && fullDiskAccess && accessibility && antigravity;

  return {
    screenCapture,
    fullDiskAccess,
    accessibility,
    antigravity,
    allGranted,
  };
}

export async function permissionsCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const isJson = args.includes('--json');
  // "status", "check" and --json only look: they never change a setting or a recorded choice. Bare "rh permissions" and "fix" do.
  const readOnly = !args.includes('--fix') && !args.includes('fix') && (isJson || args.includes('check') || args.includes('status'));
  const isFix = !readOnly;

  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    stdout('Usage: rh permissions [check|fix|status] [--json]');
    stdout('');
    stdout('Options:');
    stdout('  check   Inspect system and AI agent permissions');
    stdout('  fix     Pre-authorize all automation, files, and AI agent permissions in one step');
    stdout('  status  Show current permission status');
    stdout('  revert  Put the agy settings back the way they were before Remote Hands changed them');
    stdout('  --json  Output results in JSON format');
    stdout('');
    return 0;
  }

  if (args.includes('revert')) {
    // The background HUD goes first: an HUD from an older version rewrites these settings without asking anyone, and could
    // do it between the restore and its removal. If it cannot be stopped, nothing is restored (that would not last).
    const service = context.hudServiceManager ?? new HudServiceManager();
    let hudStopped = false;
    try {
      if (service.isInstalled()) {
        if (service.uninstall() === false) {
          stdout(c.yellow('The background HUD could not be stopped, so the settings were not changed (an HUD from an older version would put them back). Run "rh hud uninstall", or remove it by hand (macOS: launchctl unload ~/Library/LaunchAgents/com.remote-hands.hud.plist; Windows: Settings > Apps > Startup), then run "rh permissions revert" again.'));
          return 1;
        }
        hudStopped = true;
      }
    } catch {
      stdout(c.yellow('The background HUD could not be checked or stopped, so the settings were not changed: run "rh hud uninstall", then "rh permissions revert" again.'));
      return 1;
    }
    const res = await revertAgyPermissions(context.fs);
    if (hudStopped) stdout('The background HUD was stopped, because it cannot run tasks without those settings. "rh setup --hud" brings it back (and asks again).');
    if (res.error) {
      stdout(c.yellow(`Could not revert: ${res.error}`));
      return 1;
    }
    for (const f of res.restored) stdout(`Restored ${f}`);
    for (const s of res.skipped) stdout(`Could not restore ${s.path}: ${s.reason}`);
    stdout(res.restored.length > 0
      ? 'The agy settings are back as they were. Remote Hands will not change them again until you run "rh setup".'
      : 'Nothing to restore: no record of changes by Remote Hands was found (settings made by an older version are not recorded; edit ~/.gemini/antigravity-cli/settings.json by hand to tighten them). Remote Hands will not change them again until you run "rh setup".');
    return res.skipped.length > 0 ? 1 : 0;
  }

  if (isFix && (await readAgyConsent(context.fs)) === 'revoked') {
    // reverting was a decision: only setup, which shows what changes and asks, takes it back
    stdout(c.yellow('You reverted the agy settings. Run "rh setup --hud" to set them up again: it shows what changes and asks first.'));
    return 1;
  }
  if (isFix && !(await ensureAgyPermissions(context.fs, undefined, { explicit: true }))) {
    stdout(c.yellow('Could not set up the agy settings (they were reverted meanwhile, another Remote Hands command is running, or ~/.gemini or ~/.remote-hands cannot be written). Run "rh setup --hud".'));
    return 1;
  }

  if (isFix && process.platform === 'darwin' && !context.runner && !isJson) {
    await ensureMacPermissions(stdout);
  }

  const report = await checkAllPermissions(context);

  if (isJson) {
    stdout(JSON.stringify(report, null, 2));
    return report.allGranted ? 0 : 1;
  }

  stdout('');
  stdout(c.bold('🛡️  Remote Hands System Permissions Status:'));
  stdout(`  Screen & Audio Recording: ${report.screenCapture ? c.brightGreen('✔ Granted') : c.yellow('✘ Missing')}`);
  stdout(`  Full Disk Access:         ${report.fullDiskAccess ? c.brightGreen('✔ Granted') : c.yellow('✘ Missing')}`);
  stdout(`  Accessibility:            ${report.accessibility ? c.brightGreen('✔ Granted') : c.yellow('✘ Missing')}`);
  stdout(`  Browser control:          ${c.dim('optional (run "rh browser setup" for extra speed)')}`);
  stdout(`  Antigravity Permissions:  ${report.antigravity ? c.brightGreen('✔ Blanket Access Enabled') : c.yellow('✘ Missing')}`);
  stdout('');

  if (report.allGranted) {
    stdout(c.brightGreen('✔ All permissions are verified and ready for autonomous computer use.'));
    stdout('');
    return 0;
  }

  stdout(c.yellow('Some permissions still require user authorization. Run "rh permissions fix" to configure.'));
  stdout('');
  return 1;
}
