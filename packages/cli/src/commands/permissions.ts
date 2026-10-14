import {
  checkMacFullDiskAccess,
  checkMacScreenCapture,
  checkMacAccessibility,
  ensureMacPermissions,
} from '../system/mac-permissions.js';
import {
  checkAgyPermissions,
  ensureAgyPermissions,
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
  const isFix = args.includes('--fix') || args.includes('fix') || (!isJson && !args.includes('check'));

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
    const res = await revertAgyPermissions(context.fs);
    if (res.error) {
      stdout(c.yellow(`Could not revert: ${res.error}`));
      return 1;
    }
    for (const f of res.restored) stdout(`Restored ${f}`);
    for (const s of res.skipped) stdout(`Could not restore ${s.path}: ${s.reason}`);
    stdout(res.restored.length > 0
      ? 'The agy settings are back as they were. Remote Hands will not change them again until you run "rh setup".'
      : 'Nothing to restore: no record of changes by Remote Hands was found (settings made by an older version are not recorded; edit ~/.gemini/antigravity-cli/settings.json by hand to tighten them). Remote Hands will not change them again until you run "rh setup".');
    // The background HUD cannot run tasks without those settings, and an HUD installed by an older version would put them
    // back at the next login: stop it, so the revert is lasting. "rh setup --hud" brings it back after asking again.
    const service = context.hudServiceManager ?? new HudServiceManager();
    try {
      if (service.isInstalled()) {
        service.uninstall();
        stdout('The background HUD was stopped, because it cannot run tasks without those settings. "rh setup --hud" brings it back (and asks again).');
      }
    } catch {
      // nothing to stop
    }
    return res.skipped.length > 0 ? 1 : 0;
  }

  await ensureAgyPermissions(context.fs, undefined, { explicit: isFix });

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
