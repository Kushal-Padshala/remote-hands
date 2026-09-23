import { GuidanceManager, type GuideStep } from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';

export interface GuideCommandContext extends CommandContext {
  manager?: GuidanceManager | undefined;
}

let sharedManager: GuidanceManager | null = null;

function getSharedManager(): GuidanceManager {
  if (!sharedManager) {
    sharedManager = new GuidanceManager();
  }
  return sharedManager;
}

export async function executeGuideCommand(
  args: string[],
  manager?: GuidanceManager,
  context: GuideCommandContext = {}
): Promise<number> {
  const resolvedManager = manager ?? context.manager ?? getSharedManager();
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const subcommand = args[0] || 'status';

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    stdout('Usage: rh guide <show|next|dismiss|status> [options]');
    stdout('');
    stdout('Commands:');
    stdout('  show     Point spotlight and visual arrow to target element');
    stdout('  next     Advance to the next step in guidance sequence');
    stdout('  dismiss  Dismiss active guidance overlay');
    stdout('  status   Show current guidance session status');
    stdout('');
    stdout('Options:');
    stdout('  --browser       Target browser element (default)');
    stdout('  --desktop       Target desktop element');
    stdout('  --target=<sel>  Selector or element target');
    stdout('  --index=<idx>   Snapshot index number');
    stdout('  --app=<app>     macOS application name');
    stdout('  --text=<msg>    Annotation label message');
    return 0;
  }

  if (subcommand === 'dismiss') {
    await resolvedManager.dismiss();
    stdout('✓ Visual guidance dismissed');
    return 0;
  }

  if (subcommand === 'next') {
    const session = await resolvedManager.next();
    if (session) {
      stdout(`✓ Advanced to step ${session.currentStepIndex + 1} of ${session.steps.length}`);
    } else {
      stdout('✓ Guidance session completed and dismissed');
    }
    return 0;
  }

  if (subcommand === 'status') {
    const status = resolvedManager.getStatus();
    if (status) {
      stdout(`Active guidance session: Step ${status.currentStepIndex + 1} of ${status.steps.length}`);
    } else {
      stdout('No active guidance session');
    }
    return 0;
  }

  if (subcommand === 'show') {
    let isDesktop = false;
    let target = '';
    let app = '';
    let index: number | undefined;
    let text = '';

    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--desktop') {
        isDesktop = true;
      } else if (arg === '--browser') {
        isDesktop = false;
      } else if (arg.startsWith('--target=')) {
        target = arg.slice(9);
      } else if (arg === '--target' && i + 1 < args.length) {
        target = args[++i]!;
      } else if (arg.startsWith('--app=')) {
        app = arg.slice(6);
      } else if (arg === '--app' && i + 1 < args.length) {
        app = args[++i]!;
      } else if (arg.startsWith('--index=')) {
        const parsed = parseInt(arg.slice(8), 10);
        if (!isNaN(parsed)) index = parsed;
      } else if (arg === '--index' && i + 1 < args.length) {
        const parsed = parseInt(args[++i]!, 10);
        if (!isNaN(parsed)) index = parsed;
      } else if (arg.startsWith('--text=')) {
        text = arg.slice(7);
      } else if (arg === '--text' && i + 1 < args.length) {
        text = args[++i]!;
      } else if (!text && !arg.startsWith('--')) {
        text = arg;
      }
    }

    const step: GuideStep = {
      type: isDesktop ? 'desktop' : 'browser',
      text: text || 'Click here',
      selector: target || undefined,
      index,
      app: app || undefined,
      target: target || undefined,
    };

    await resolvedManager.startSession([step]);
    stdout(`✓ Pointing arrow to ${isDesktop ? 'desktop element' : 'browser element'}: "${step.text}"`);
    return 0;
  }

  stderr(`Unknown guide subcommand: ${subcommand}`);
  return 1;
}

export async function guideCommand(
  args: string[],
  context: GuideCommandContext = {}
): Promise<number> {
  return executeGuideCommand(args, context.manager, context);
}
