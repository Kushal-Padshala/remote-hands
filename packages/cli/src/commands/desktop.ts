import type { CommandContext } from './setup.js';
import {
  MacOsDriver,
  AxWalker,
  DesktopActEngine,
} from '@remote-hands/daemon';

export interface DesktopCommandContext extends CommandContext {
  desktopDriver?: MacOsDriver | any;
  walker?: AxWalker | any;
  actEngine?: DesktopActEngine | any;
}

export async function desktopCommand(
  args: string[],
  context: DesktopCommandContext = {}
): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const driver: MacOsDriver = context.desktopDriver ?? new MacOsDriver();
  const walker: AxWalker = context.walker ?? new AxWalker({ driver });
  const engine: DesktopActEngine = context.actEngine ?? new DesktopActEngine(driver);

  const sub = args[0];
  if (!sub) {
    stdout('Usage: rh desktop <act|open|window|snapshot|screenshot|click|type|key|menu> [args]');
    stdout('');
    stdout('Commands:');
    stdout('  open <app>                  Launch or activate an application');
    stdout('  window <list|focus|close>   Manage windows');
    stdout('  snapshot [--json]           Inspect UI elements of the active application');
    stdout('  screenshot [--path|--b64]   Capture full desktop screenshot');
    stdout('  click <index|x,y>           Click an element by index or coordinate');
    stdout('  type <text>                 Type text into the active element');
    stdout('  key <combo>                 Send keystroke or shortcut (e.g. return, cmd+s)');
    stdout('  menu <app> <menu> <item>    Select a menu item in an application');
    stdout('  act <goal>                  Execute a natural language desktop goal');
    stdout('');
    return 1;
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    stdout('Usage: rh desktop <act|open|window|snapshot|screenshot|click|type|key|menu> [args]');
    stdout('');
    stdout('Commands:');
    stdout('  open <app>                  Launch or activate an application');
    stdout('  window <list|focus|close>   Manage windows');
    stdout('  snapshot [--json]           Inspect UI elements of the active application');
    stdout('  screenshot [--path|--b64]   Capture full desktop screenshot');
    stdout('  click <index|x,y>           Click an element by index or coordinate');
    stdout('  type <text>                 Type text into the active element');
    stdout('  key <combo>                 Send keystroke or shortcut (e.g. return, cmd+s)');
    stdout('  menu <app> <menu> <item>    Select a menu item in an application');
    stdout('  act <goal>                  Execute a natural language desktop goal');
    stdout('');
    return 0;
  }

  try {
    if (sub === 'open') {
      const app = args.slice(1).join(' ').trim();
      if (!app) {
        stderr('Missing app name. Usage: rh desktop open <app>');
        return 1;
      }
      await driver.openApp(app);
      stdout(`Opened ${app}`);
      return 0;
    }

    if (sub === 'window') {
      const action = args[1];
      if (!action) {
        stderr('Usage: rh desktop window <list|focus|close> [app]');
        return 1;
      }
      if (action === 'list') {
        const wins = await driver.listWindows();
        stdout(JSON.stringify(wins, null, 2));
        return 0;
      }
      if (action === 'focus') {
        const app = args.slice(2).join(' ').trim();
        if (!app) {
          stderr('Missing app name. Usage: rh desktop window focus <app>');
          return 1;
        }
        await driver.focusWindow(app);
        stdout(`Focused ${app}`);
        return 0;
      }
      if (action === 'close') {
        const app = args.slice(2).join(' ').trim();
        if (!app) {
          stderr('Missing app name. Usage: rh desktop window close <app>');
          return 1;
        }
        await driver.closeWindow(app);
        stdout(`Closed window for ${app}`);
        return 0;
      }
      stderr(`Unknown window action: ${action}. Usage: rh desktop window <list|focus|close> [app]`);
      return 1;
    }

    if (sub === 'snapshot') {
      const isJson = args.includes('--json');
      const filtered = args.slice(1).filter((a) => a !== '--json');
      const app = filtered.join(' ').trim() || undefined;
      const elements = await walker.walkActiveApp(app);
      if (isJson) {
        stdout(JSON.stringify(elements, null, 2));
      } else {
        stdout(walker.formatTable(elements));
      }
      return 0;
    }

    if (sub === 'screenshot') {
      const isBase64 = args.includes('--base64') || args.includes('--b64');
      const isJson = args.includes('--json');
      const pathArgIdx = args.indexOf('--path');
      const targetPath = pathArgIdx !== -1 && args[pathArgIdx + 1] ? args[pathArgIdx + 1] : undefined;
      const buf = await driver.captureScreenshot({ destPath: targetPath });
      if (!buf) {
        stderr('Failed to capture desktop screenshot');
        return 1;
      }
      if (isBase64) {
        const b64 = buf.toString('base64');
        if (isJson) {
          stdout(JSON.stringify({ jpeg_base64: b64, size: buf.length }));
        } else {
          stdout(b64);
        }
        return 0;
      }
      if (targetPath) {
        stdout(`Screenshot saved to ${targetPath} (${buf.length} bytes)`);
      } else {
        stdout(`Captured desktop screenshot (${buf.length} bytes)`);
      }
      return 0;
    }

    if (sub === 'click') {
      const target = args.slice(1).join(' ').trim();
      if (!target) {
        stderr('Missing target. Usage: rh desktop click <index|x,y>');
        return 1;
      }

      const coordMatch = target.match(/^(\d+)(?:\s*,\s*|\s+)(\d+)$/);
      if (coordMatch && coordMatch[1] && coordMatch[2]) {
        const x = parseInt(coordMatch[1], 10);
        const y = parseInt(coordMatch[2], 10);
        if (typeof (driver as any).clickAt === 'function') {
          await (driver as any).clickAt(x, y);
        } else {
          const script = `tell application "System Events"\n  click at {${x}, ${y}}\nend tell`;
          driver.exec('osascript', ['-e', script]);
        }
        stdout(`Clicked at ${x},${y}`);
        return 0;
      }

      const indexMatch = target.match(/^\[?(\d+)\]?$/);
      if (indexMatch && indexMatch[1]) {
        const targetIndex = parseInt(indexMatch[1], 10);
        const elements = await walker.walkActiveApp();
        const el = elements.find((e) => e.index === targetIndex);
        if (!el && !context.actEngine) {
          stderr(`Element [${targetIndex}] not found`);
          return 1;
        }
        await engine.executeDecision({ action: 'CLICK', targetIndex }, elements);
        stdout(`Clicked element [${targetIndex}]`);
        return 0;
      }

      stderr(`Invalid click target: "${target}". Expected index or x,y coordinates.`);
      return 1;
    }

    if (sub === 'type') {
      const text = args.slice(1).join(' ');
      if (!text) {
        stderr('Missing text. Usage: rh desktop type <text>');
        return 1;
      }
      if (typeof (driver as any).typeText === 'function') {
        await (driver as any).typeText(text);
      } else {
        await engine.executeDecision({ action: 'TYPE_TEXT', text }, []);
      }
      stdout(`Typed: ${text}`);
      return 0;
    }

    if (sub === 'key') {
      const combo = args.slice(1).join(' ').trim();
      if (!combo) {
        stderr('Missing key combo. Usage: rh desktop key <combo>');
        return 1;
      }
      if (typeof (driver as any).pressKey === 'function') {
        await (driver as any).pressKey(combo);
      } else {
        await engine.executeDecision({ action: 'KEY', key: combo }, []);
      }
      stdout(`Pressed key: ${combo}`);
      return 0;
    }

    if (sub === 'menu') {
      const app = args[1];
      const menu = args[2];
      const item = args[3];
      if (!app || !menu || !item) {
        stderr('Usage: rh desktop menu <app> <menu> <item> [subitem...]');
        return 1;
      }
      const menuPath = args.slice(2);
      await driver.triggerMenu(app, menuPath);
      stdout(`Triggered menu "${menuPath.join(' > ')}" in ${app}`);
      return 0;
    }

    if (sub === 'act') {
      const goal = args.slice(1).join(' ').trim();
      if (!goal) {
        stderr('Missing goal. Usage: rh desktop act <goal>');
        return 1;
      }
      const elements = await walker.walkActiveApp();
      const decision = typeof engine.act === 'function'
        ? await engine.act(goal, elements)
        : await (async () => {
            const d = engine.matchHeuristic(goal, elements);
            await engine.executeDecision(d, elements);
            return d;
          })();
      stdout(`Executed: ${decision.action}`);
      return 0;
    }

    stderr(`Unknown desktop subcommand: ${sub}. Usage: rh desktop <act|open|window|snapshot|click|type|key|menu> [args]`);
    return 1;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
