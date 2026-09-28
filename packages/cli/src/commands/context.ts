import { ContextService } from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';

export async function contextCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;

  const isJson = args.includes('--json');
  let query = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--query=')) {
      query = arg.slice(8);
    } else if (arg === '-q' || arg === '--query') {
      query = args[i + 1] || '';
      i++;
    }
  }

  const service: ContextService = (context as any).contextService ?? new ContextService();

  try {
    const hierarchy = query ? await service.filterTargets(query) : await service.getHierarchy();

    if (isJson) {
      stdout(JSON.stringify(hierarchy, null, 2));
      return 0;
    }

    stdout('=== Browsers & Tabs ===');
    if (hierarchy.browsers.length === 0) {
      stdout('  (No browsers or tabs detected)');
    } else {
      for (const browser of hierarchy.browsers) {
        stdout(`${browser.name}:`);
        for (const profile of browser.profiles) {
          stdout(`  Profile: ${profile.name}`);
          for (const tab of profile.tabs) {
            stdout(`    - ${tab.title} (${tab.url})`);
          }
        }
      }
    }

    stdout('\n=== Running Applications ===');
    if (hierarchy.apps.length === 0) {
      stdout('  (No applications detected)');
    } else {
      for (const app of hierarchy.apps) {
        stdout(`  - ${app.name}`);
      }
    }

    stdout('\n=== Local Files ===');
    if (hierarchy.files.length === 0) {
      stdout('  (No recent files detected)');
    } else {
      for (const file of hierarchy.files) {
        stdout(`  - ${file.name} (${file.path})`);
      }
    }

    return 0;
  } catch (err: any) {
    stderr(`Error retrieving context targets: ${err.message || String(err)}`);
    return 1;
  }
}
