import { spawnSync } from 'node:child_process';

export interface WindowInfo {
  app: string;
  title: string;
  id?: number;
}

export interface ExecFunction {
  (command: string, args: string[]): { stdout: string; stderr: string; status: number | null };
}

export interface MacOsDriverOptions {
  exec?: ExecFunction;
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class MacOsDriver {
  public exec: ExecFunction;

  constructor(options?: MacOsDriverOptions) {
    this.exec = options?.exec ?? ((cmd, args) => {
      const res = spawnSync(cmd, args, { encoding: 'utf-8' });
      return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
    });
  }

  async openApp(appName: string): Promise<void> {
    this.exec('open', ['-a', appName]);
  }

  async listWindows(): Promise<WindowInfo[]> {
    const script = `
      const se = Application("System Events");
      const procs = se.applicationProcesses.where({ backgroundOnly: false });
      const results = [];
      for (let i = 0; i < procs.length; i++) {
        try {
          const p = procs[i];
          const wins = p.windows();
          for (let j = 0; j < wins.length; j++) {
            results.push({ app: p.name(), title: wins[j].name() || "" });
          }
        } catch (_) {}
      }
      JSON.stringify(results);
    `;
    const res = this.exec('osascript', ['-l', 'JavaScript', '-e', script]);
    try {
      const parsed = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async focusWindow(appName: string): Promise<void> {
    const script = `tell application "${escapeAppleScript(appName)}" to activate`;
    this.exec('osascript', ['-e', script]);
  }

  async closeWindow(appName: string): Promise<void> {
    const script = `
      tell application "System Events"
        tell process "${escapeAppleScript(appName)}"
          keystroke "w" using command down
        end tell
      end tell
    `;
    this.exec('osascript', ['-e', script]);
  }

  async triggerMenu(appName: string, menuPath: string[]): Promise<void> {
    if (menuPath.length < 2) return;
    let target = `menu "${escapeAppleScript(menuPath[0]!)}" of menu bar 1`;
    for (let i = 1; i < menuPath.length - 1; i++) {
      target = `menu 1 of menu item "${escapeAppleScript(menuPath[i]!)}" of ${target}`;
    }
    const lastItem = escapeAppleScript(menuPath[menuPath.length - 1]!);
    const script = `
      tell application "System Events"
        tell process "${escapeAppleScript(appName)}"
          click menu item "${lastItem}" of ${target}
        end tell
      end tell
    `;
    this.exec('osascript', ['-e', script]);
  }

  async sendKeyCombo(keys: string[], modifiers: string[]): Promise<void> {
    const mods = modifiers
      .map((m) => {
        const trimmed = m.trim();
        return trimmed.endsWith('down') ? trimmed : `${trimmed} down`;
      })
      .join(', ');
    const modString = mods.length > 0 ? ` using {${mods}}` : '';
    const key = keys[0] ?? '';
    const script = `
      tell application "System Events"
        keystroke "${escapeAppleScript(key)}"${modString}
      end tell
    `;
    this.exec('osascript', ['-e', script]);
  }
}
