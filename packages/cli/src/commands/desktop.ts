import type { CommandContext } from './setup.js';
import { activeTaskId, createActionGate, type ActionGateContext } from '../action-gate.js';
import { classifyRiskyKey } from '@remote-hands/shared';
import {
  MacOsDriver,
  AxWalker,
  DesktopActEngine,
  searchAndTriggerMenu,
  crawlAppMenu,
  performAxAction,
} from '@remote-hands/daemon';

export interface DesktopCommandContext extends CommandContext, Pick<ActionGateContext, 'approve' | 'taskId'> {
  desktopDriver?: MacOsDriver | any;
  walker?: AxWalker | any;
  actEngine?: DesktopActEngine | any;
  searchAndTriggerMenu?: typeof searchAndTriggerMenu;
  crawlAppMenu?: typeof crawlAppMenu;
  performAxAction?: typeof performAxAction;
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
  const searchMenuFn = context.searchAndTriggerMenu ?? searchAndTriggerMenu;
  const crawlMenuFn = context.crawlAppMenu ?? crawlAppMenu;
  const axActionFn = context.performAxAction ?? performAxAction;
  const gate = createActionGate(context);

  const sub = args[0];
  if (!sub) {
    stdout('Usage: rh desktop <act|open|window|snapshot|screenshot|click|type|key|menu|menu-search|menu-list|ax-action> [args]');
    stdout('');
    stdout('Commands:');
    stdout('  open <app>                  Launch or activate an application');
    stdout('  window <list|focus|close>   Manage windows');
    stdout('  snapshot [--json] [--no-ocr] Inspect UI elements of the active application');
    stdout('  screenshot [--path|--b64]   Capture full desktop screenshot');
    stdout('  click <index|x,y>           Click an element by index or coordinate');
    stdout('  type <text>                 Type text into the active element');
    stdout('  key <combo>                 Send keystroke or shortcut (e.g. return, cmd+s)');
    stdout('  menu <app> <menu> <item>    Select a menu item in an application');
    stdout('  menu-search <app> <query>   Fuzzy search and trigger a menu bar item');
    stdout('  menu-list <app>             List hierarchical menu items as JSON');
    stdout('  ax-action <app> <idx> [act] Perform direct native accessibility action (default: AXPress)');
    stdout('  act <goal>                  Execute a natural language desktop goal');
    stdout('');
    return 1;
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    stdout('Usage: rh desktop <act|open|window|snapshot|screenshot|click|type|key|menu|menu-search|menu-list|ax-action> [args]');
    stdout('');
    stdout('Commands:');
    stdout('  open <app>                  Launch or activate an application');
    stdout('  window <list|focus|close>   Manage windows');
    stdout('  snapshot [--json] [--no-ocr] Inspect UI elements of the active application');
    stdout('  screenshot [--path|--b64]   Capture full desktop screenshot');
    stdout('  click <index|x,y>           Click an element by index or coordinate');
    stdout('  type <text>                 Type text into the active element');
    stdout('  key <combo>                 Send keystroke or shortcut (e.g. return, cmd+s)');
    stdout('  menu <app> <menu> <item>    Select a menu item in an application');
    stdout('  menu-search <app> <query>   Fuzzy search and trigger a menu bar item');
    stdout('  menu-list <app>             List hierarchical menu items as JSON');
    stdout('  ax-action <app> <idx> [act] Perform direct native accessibility action (default: AXPress)');
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
      const isOcr = args.includes('--ocr');
      const filtered = args.slice(1).filter((a) => a !== '--json' && a !== '--no-ocr' && a !== '--native-only' && a !== '--ocr');
      const app = filtered.join(' ').trim() || undefined;
      if (app && typeof driver.focusWindow === 'function') {
        try {
          await driver.focusWindow(app);
        } catch {}
      }
      const elements = await walker.walkActiveApp(app, { allowOcr: isOcr });
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

    if (sub === 'click' || sub === 'right-click') {
      const isRight = sub === 'right-click' || args.includes('--right') || args.includes('-r');
      const filtered = args.slice(1).filter((a) => a !== '--right' && a !== '-r');
      const target = filtered.join(' ').trim();
      if (!target) {
        stderr('Missing target. Usage: rh desktop click <index|x,y> [--right]');
        return 1;
      }

      const coordMatch = target.match(/^(\d+)(?:\s*,\s*|\s+)(\d+)$/);
      if (coordMatch && coordMatch[1] && coordMatch[2]) {
        const x = parseInt(coordMatch[1], 10);
        const y = parseInt(coordMatch[2], 10);
        if (activeTaskId(context)) {
          const hit = await walker.controlAtPoint(x, y);
          await gate(hit?.label ?? '');
          // Approval can take a while; do not click a different control after the UI changes.
          const fresh = await walker.controlAtPoint(x, y);
          if (!hit || !fresh || hit.pid !== fresh.pid || hit.role !== fresh.role ||
              hit.label !== fresh.label || hit.bounds.some((n, i) => n !== fresh.bounds[i])) {
            throw new Error('Control under the coordinate changed; action was not pressed. Take a fresh snapshot and retry.');
          }
        }
        if (typeof (driver as any).clickAt === 'function') {
          if (isRight) {
            await (driver as any).clickAt(x, y, 'right');
          } else {
            await (driver as any).clickAt(x, y);
          }
        } else {
          const script = `tell application "System Events"\n  click at {${x}, ${y}}\nend tell`;
          driver.exec('osascript', ['-e', script]);
        }
        stdout(`${isRight ? 'Right-clicked' : 'Clicked'} at ${x},${y}`);
        return 0;
      }

      const indexMatch = target.match(/^\[?(\d+)\]?(?:\s+(.+))?$/);
      if (indexMatch && indexMatch[1]) {
        const targetIndex = parseInt(indexMatch[1], 10);
        const appArg = indexMatch[2]?.trim() || undefined;
        const elements = await walker.walkActiveApp(appArg, { allowOcr: false });
        const el = elements.find((e) => e.index === targetIndex);
        if (!el && !context.actEngine) {
          stderr(`Element [${targetIndex}] not found`);
          return 1;
        }
        await gate(el?.label ?? '');
        await (appArg
          ? engine.executeDecision({ action: isRight ? 'RIGHT_CLICK' : 'CLICK', targetIndex }, elements, appArg)
          : engine.executeDecision({ action: isRight ? 'RIGHT_CLICK' : 'CLICK', targetIndex }, elements));
        stdout(`${isRight ? 'Right-clicked' : 'Clicked'} element [${targetIndex}]`);
        return 0;
      }

      const elements = await walker.walkActiveApp(undefined, { allowOcr: false });
      const lower = target.toLowerCase();
      const matched =
        elements.find((e) => e.label.toLowerCase() === lower) ||
        elements.find((e) => e.label && (e.label.toLowerCase().includes(lower) || lower.includes(e.label.toLowerCase())));
      if (matched) {
        await gate(matched.label);
        await engine.executeDecision({ action: isRight ? 'RIGHT_CLICK' : 'CLICK', targetIndex: matched.index }, elements);
        stdout(`${isRight ? 'Right-clicked' : 'Clicked'} "${matched.label}" [${matched.index}]`);
        return 0;
      }

      stderr(`Invalid click target: "${target}". Expected index, label, or x,y coordinates.`);
      return 1;
    }

    if (sub === 'type') {
      const text = args.slice(1).join(' ');
      if (!text) {
        stderr('Missing text. Usage: rh desktop type <text>');
        return 1;
      }
      if (context.actEngine) {
        await engine.executeDecision({ action: 'TYPE_TEXT', text }, []);
      } else if (typeof (driver as any).typeText === 'function') {
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
      const keyKind = classifyRiskyKey(combo);
      if (keyKind) await gate(combo, { kind: keyKind });
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
      await gate(menuPath[menuPath.length - 1] ?? '');
      await driver.triggerMenu(app, menuPath);
      stdout(`Triggered menu "${menuPath.join(' > ')}" in ${app}`);
      return 0;
    }

    if (sub === 'menu-search') {
      const app = args[1];
      const query = args.slice(2).join(' ').trim();
      if (!app || !query) {
        stderr('Usage: rh desktop menu-search <app> <query>');
        return 1;
      }
      const res = await searchMenuFn(app, query, driver.exec, gate);
      if (res.success) {
        stdout(`Triggered menu: ${(res.triggeredPath || [query]).join(' > ')}`);
        return 0;
      } else {
        stderr(`Failed to trigger menu: ${res.error || 'Menu item not found'}`);
        return 1;
      }
    }

    if (sub === 'menu-list') {
      const app = args.slice(1).join(' ').trim();
      if (!app) {
        stderr('Usage: rh desktop menu-list <app>');
        return 1;
      }
      const items = await crawlMenuFn(app, driver.exec);
      stdout(JSON.stringify(items, null, 2));
      return 0;
    }

    if (sub === 'ax-action') {
      const app = args[1];
      const idxStr = args[2];
      const action = args[3] || 'AXPress';
      if (!app || !idxStr) {
        stderr('Usage: rh desktop ax-action <app> <index> [action]');
        return 1;
      }
      const cleanIdx = idxStr.replace(/[\[\]]/g, '');
      const targetIndex = parseInt(cleanIdx, 10);
      if (isNaN(targetIndex)) {
        stderr('Usage: rh desktop ax-action <app> <index> [action]');
        return 1;
      }
      let target: number | any = targetIndex;
      try {
        const elements = await walker.walkActiveApp(app, { allowOcr: false });
        const matched = Array.isArray(elements) ? elements.find((e: any) => e.index === targetIndex) : undefined;
        if (matched) {
          target = { index: matched.index, bounds: matched.bounds, role: matched.role, label: matched.label };
        }
      } catch {}
      await gate(typeof target === 'object' ? target.label ?? '' : '');
      const success = await axActionFn(app, target, action, driver.exec);
      if (success) {
        stdout(`Executed ${action} on element [${cleanIdx}] in ${app}`);
        return 0;
      } else {
        stderr(`Failed to execute ${action} on element [${cleanIdx}] in ${app}`);
        return 1;
      }
    }

    if (sub === 'act') {
      const goal = args.slice(1).join(' ').trim();
      if (!goal) {
        stderr('Missing goal. Usage: rh desktop act <goal>');
        return 1;
      }
      const appMatch =
        goal.match(/(?:in|on)\s+["']?([A-Za-z0-9\s]+?)["']?(?:\s*,\s*|\s+(?:select|click|right|type|press)\b)/i) ||
        goal.match(/\b(?:in|on)\s+["']?([A-Za-z0-9\s]+?)["']?$/i);
      const targetApp = appMatch && appMatch[1] ? appMatch[1].trim() : undefined;
      if (targetApp && typeof driver.focusWindow === 'function') {
        try {
          await driver.focusWindow(targetApp);
        } catch {}
      }
      const elements = await walker.walkActiveApp(targetApp, { allowOcr: false });
      const decision = engine.matchHeuristic(goal, elements);
      if ((decision.action === 'CLICK' || decision.action === 'RIGHT_CLICK') && decision.targetIndex === undefined) {
        stderr(`No matching element found for goal: "${goal}"`);
        return 1;
      }
      // TYPE_TEXT also presses its target to focus it before typing.
      const keyKind = decision.action === 'KEY' && decision.key ? classifyRiskyKey(decision.key) : null;
      if (decision.targetIndex !== undefined) {
        const target = elements.find((e) => e.index === decision.targetIndex);
        await gate(target?.label ?? '');
      } else if (keyKind) {
        await gate(decision.key!, { kind: keyKind });
      } else {
        await gate(goal, { goal: true });
      }
      await (targetApp ? engine.executeDecision(decision, elements, targetApp) : engine.executeDecision(decision, elements));
      stdout(`Executed: ${decision.action}`);
      return 0;
    }

    stderr(`Unknown desktop subcommand: ${sub}. Usage: rh desktop <act|open|window|snapshot|screenshot|click|type|key|menu|menu-search|menu-list|ax-action> [args]`);
    return 1;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
