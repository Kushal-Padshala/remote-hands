import { spawnSync } from 'node:child_process';
import type { ExecFunction, MacOsDriver } from './macos-driver.js';

export interface RawAxNode {
  role: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  subrole?: string;
  visible?: boolean;
  hidden?: boolean;
}

export interface IndexedElement {
  index: number;
  role: string;
  label: string;
  bounds: [number, number, number, number];
}

export interface AxWalkerOptions {
  driver?: MacOsDriver;
  exec?: ExecFunction;
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class AxWalker {
  private exec: ExecFunction;

  constructor(options?: AxWalkerOptions | MacOsDriver) {
    if (options && 'openApp' in options) {
      this.exec = options.exec;
    } else if (options && typeof options === 'object') {
      this.exec = options.exec ?? options.driver?.exec ?? ((cmd, args) => {
        const res = spawnSync(cmd, args, { encoding: 'utf-8' });
        return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
      });
    } else {
      this.exec = (cmd, args) => {
        const res = spawnSync(cmd, args, { encoding: 'utf-8' });
        return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
      };
    }
  }

  pruneAndIndex(nodes: RawAxNode[]): IndexedElement[] {
    const valid: IndexedElement[] = [];
    let counter = 1;

    for (const node of nodes) {
      if (!node) continue;
      if (node.visible === false || node.hidden === true) continue;
      if (typeof node.width !== 'number' || typeof node.height !== 'number') continue;
      if (node.width < 4 || node.height < 4) continue;
      if (typeof node.x !== 'number' || typeof node.y !== 'number') continue;
      if (node.x < 0 || node.y < 0) continue;

      const trimmed = (node.label ?? '').trim();
      if (!trimmed) {
        if (node.role !== 'AXTextField' && node.role !== 'AXTextArea') continue;
      }
      if (node.role === 'AXGroup' && !trimmed) continue;

      valid.push({
        index: counter++,
        role: node.role,
        label: trimmed,
        bounds: [node.x, node.y, node.width, node.height],
      });
    }

    return valid;
  }

  formatTable(elements: IndexedElement[]): string {
    return elements
      .map((el) => `[${el.index}] ${el.role} "${el.label}"`)
      .join('\n');
  }

  async walkActiveApp(appNameOrExec?: string | ExecFunction, maybeExec?: ExecFunction): Promise<IndexedElement[]> {
    let appName: string | undefined;
    let execFunc = this.exec;
    if (typeof appNameOrExec === 'function') {
      execFunc = appNameOrExec;
    } else if (typeof appNameOrExec === 'string') {
      appName = appNameOrExec;
      if (typeof maybeExec === 'function') {
        execFunc = maybeExec;
      }
    }

    const escapedApp = appName ? escapeAppleScript(appName) : '';
    const script = `
      function run() {
        try {
          const se = Application("System Events");
          const procs = ${appName ? `[se.applicationProcesses.byName("${escapedApp}")].filter(Boolean)` : `se.applicationProcesses.where({ frontmost: true })`};
          if (!procs || procs.length === 0) return JSON.stringify([]);
          const front = procs[0];
          const wins = front.windows();
          if (!wins || wins.length === 0) return JSON.stringify([]);
          const win = wins[0];
          const els = win.entireContents();
          const items = [];
          const count = Math.min(els.length, 500);
          for (let i = 0; i < count; i++) {
            try {
              const el = els[i];
              const pos = el.position();
              const size = el.size();
              items.push({
                role: el.role(),
                label: el.name() || el.description() || "",
                x: pos[0],
                y: pos[1],
                width: size[0],
                height: size[1]
              });
            } catch (_) {}
          }
          return JSON.stringify(items);
        } catch (_) {
          return JSON.stringify([]);
        }
      }
      run();
    `;

    try {
      const res = execFunc('osascript', ['-l', 'JavaScript', '-e', script]);
      const raw = JSON.parse(res.stdout.trim() || '[]');
      if (!Array.isArray(raw)) return [];
      return this.pruneAndIndex(raw);
    } catch {
      return [];
    }
  }
}
