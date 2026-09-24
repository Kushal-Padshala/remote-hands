import {
  checkMacFullDiskAccess,
  checkMacScreenCapture,
  checkMacAccessibility,
  grantMacAutomationPermissions,
  ensureMacPermissions,
} from '../system/mac-permissions.js';
import {
  checkAgyPermissions,
  ensureAgyPermissions,
} from '../system/agy-permissions.js';
import type { CommandContext } from './setup.js';
import { c } from '../output/ui.js';

export interface PermissionsReport {
  screenCapture: boolean;
  fullDiskAccess: boolean;
  accessibility: boolean;
  antigravity: boolean;
  automation: boolean;
  allGranted: boolean;
}

export async function checkAllPermissions(context: CommandContext = {}): Promise<PermissionsReport> {
  const isDarwin = process.platform === 'darwin';
  const screenCapture = isDarwin ? checkMacScreenCapture() : true;
  const fullDiskAccess = isDarwin ? checkMacFullDiskAccess() : true;
  const accessibility = isDarwin ? checkMacAccessibility() : true;
  const antigravity = await checkAgyPermissions(context.fs);
  const automation = isDarwin ? grantMacAutomationPermissions() : true;

  const allGranted = screenCapture && fullDiskAccess && accessibility && antigravity;

  return {
    screenCapture,
    fullDiskAccess,
    accessibility,
    antigravity,
    automation,
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
    stdout('  --json  Output results in JSON format');
    stdout('');
    return 0;
  }

  await ensureAgyPermissions(context.fs);
  grantMacAutomationPermissions();

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
  stdout(`  App & Browser Automation: ${report.automation ? c.brightGreen('✔ Pre-authorized (Arc, Chrome, Safari, Notes, System Events)') : c.yellow('✘ Not configured')}`);
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
