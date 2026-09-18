import { ChromeManager } from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';
import { c } from '../output/ui.js';

export async function profilesCommand(args: string[], context?: CommandContext): Promise<number> {
  const stdout = context?.stdout ?? console.log;
  const chromeManager =
    context?.chromeManager ??
    new ChromeManager({
      mode: 'active',
      port: 9222,
    });
  if (context) {
    context.chromeManager = chromeManager;
  }

  const profiles = ChromeManager.listProfiles();
  const status = await chromeManager.checkDebuggerStatus();

  stdout('');
  stdout(c.bold(c.cyan('Chrome Browser Profiles')));
  stdout(c.dim('─'.repeat(50)));

  if (profiles.length === 0) {
    stdout(c.yellow('No Chrome profiles found in default User Data directory.'));
  } else {
    stdout(`Found ${c.bold(String(profiles.length))} profile${profiles.length === 1 ? '' : 's'}:`);
    stdout('');
    for (const p of profiles) {
      const defaultTag = p.isDefault ? c.dim(' (default)') : '';
      const emailInfo = p.email ? c.dim(` <${p.email}>`) : '';
      stdout(`  • ${c.bold(c.white(p.name))}${emailInfo}${defaultTag}`);
      stdout(`    ${c.dim('Directory:')} ${p.directory}  ${c.dim('ID:')} ${p.id}`);
    }
  }

  stdout('');
  stdout(c.dim('Debugger Status:'));
  if (status.available) {
    stdout(`  ${c.brightGreen('✔')} Remote debugging active on port ${status.port} (mode: ${status.mode})`);
  } else {
    stdout(`  ${c.dim('○')} Remote debugging inactive (port ${status.port}, mode: ${status.mode})`);
  }

  stdout('');
  stdout(c.dim('Launch with a profile:'));
  const sampleName = profiles[0]?.name ?? 'Default';
  stdout(`  rh start --browser-profile=${sampleName}`);
  stdout(`  rh daemon --browser-profile=${sampleName}`);
  stdout(`  rh browser --browser-profile=${sampleName}`);
  stdout('');

  return 0;
}
