import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExecFunction } from './macos-driver.js';

export interface SpotlightPromptResult {
  query: string;
  app: string;
}

export type SpotlightListenerEvent = SpotlightPromptResult | { event: string; app: string; query?: string };

export type HudUpdateSender = (status: string, text: string) => void;

export class SpotlightHudRunner {
  private exec: ExecFunction;
  private binaryPath: string;
  private swiftSourcePath: string;

  constructor(execFunc?: ExecFunction) {
    this.exec = execFunc ?? ((cmd, args) => {
      const res = spawnSync(cmd, args, { encoding: 'utf-8' });
      return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
    });

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    this.swiftSourcePath = path.join(currentDir, 'spotlight-hud.swift');
    this.binaryPath = path.join(currentDir, '..', '..', 'bin', 'rh-spotlight');
  }

  private ensureBinary(): string | null {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const userBinPath = path.join(os.homedir(), '.remote-hands', 'bin', 'rh-spotlight');
    const candidateBinaries = [
      this.binaryPath,
      userBinPath,
      path.resolve(currentDir, '..', '..', 'bin', 'rh-spotlight'),
      path.resolve(currentDir, '..', '..', 'daemon', 'bin', 'rh-spotlight'),
      path.resolve(currentDir, '..', 'daemon', 'bin', 'rh-spotlight'),
      path.resolve(currentDir, '..', '..', '..', 'packages', 'daemon', 'bin', 'rh-spotlight'),
      path.resolve(currentDir, '..', '..', '..', 'daemon', 'bin', 'rh-spotlight'),
    ];
    for (const b of candidateBinaries) {
      if (fs.existsSync(b)) {
        return b;
      }
    }

    const candidateSwift = [
      this.swiftSourcePath,
      path.resolve(currentDir, 'spotlight-hud.swift'),
      path.resolve(currentDir, '..', 'desktop', 'spotlight-hud.swift'),
      path.resolve(currentDir, '..', '..', 'daemon', 'src', 'desktop', 'spotlight-hud.swift'),
      path.resolve(currentDir, '..', '..', '..', 'packages', 'daemon', 'src', 'desktop', 'spotlight-hud.swift'),
      path.resolve(currentDir, '..', '..', '..', 'daemon', 'src', 'desktop', 'spotlight-hud.swift'),
      path.resolve(os.homedir(), '.remote-hands', 'spotlight-hud.swift'),
    ];

    let swiftFile: string | null = null;
    for (const s of candidateSwift) {
      if (fs.existsSync(s)) {
        swiftFile = s;
        break;
      }
    }

    if (swiftFile) {
      try {
        fs.mkdirSync(path.dirname(userBinPath), { recursive: true });
        const compile = spawnSync('swiftc', ['-O', swiftFile, '-o', userBinPath], {
          encoding: 'utf-8',
        });
        if (compile.status === 0 && fs.existsSync(userBinPath)) {
          return userBinPath;
        }
      } catch {}
      return swiftFile;
    }

    return null;
  }

  async openPrompt(activeApp?: string): Promise<SpotlightPromptResult | null> {
    const target = this.ensureBinary();
    if (!target) {
      return null;
    }
    const args: string[] = ['prompt'];
    if (activeApp) {
      args.push(`--app=${activeApp}`);
    }

    let cmd = target;
    let execArgs = args;
    if (target.endsWith('.swift')) {
      cmd = 'swift';
      execArgs = [target, ...args];
    }

    const res = this.exec(cmd, execArgs);
    if (res.status !== 0 || !res.stdout.trim()) {
      return null;
    }

    try {
      const firstLine = res.stdout.trim().split('\n')[0] || '{}';
      const parsed = JSON.parse(firstLine);
      if (parsed && typeof parsed.query === 'string') {
        return { query: parsed.query, app: parsed.app || activeApp || 'Desktop' };
      }
      return null;
    } catch {
      return null;
    }
  }

  openInteractivePrompt(
    activeApp: string | undefined,
    onSubmit: (result: SpotlightPromptResult, sendUpdate: HudUpdateSender) => Promise<void> | void,
    onCancel?: () => void,
  ): { close: () => void } {
    const target = this.ensureBinary();
    if (!target) {
      return { close: () => {} };
    }
    const args: string[] = ['prompt'];
    if (activeApp) {
      args.push(`--app=${activeApp}`);
    }

    let cmd = target;
    let execArgs = args;
    if (target.endsWith('.swift')) {
      cmd = 'swift';
      execArgs = [target, ...args];
    }

    const child = spawn(cmd, execArgs, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let submitted = false;
    const sendUpdate: HudUpdateSender = (status: string, text: string) => {
      if (!child.killed && child.stdin && child.stdin.writable) {
        try {
          child.stdin.write(JSON.stringify({ status, text }) + '\n');
        } catch {}
      }
    };

    let buffer = '';
    child.stdout?.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.event === 'submit' || (parsed.query && !submitted)) {
            submitted = true;
            const res: SpotlightPromptResult = {
              query: parsed.query,
              app: parsed.app || activeApp || 'Desktop',
            };
            Promise.resolve(onSubmit(res, sendUpdate)).catch(() => {});
          } else if (parsed.event === 'cancel') {
            if (onCancel) onCancel();
            try {
              child.kill();
            } catch {}
          }
        } catch {}
      }
    });

    return {
      close: () => {
        try {
          child.kill('SIGTERM');
        } catch {}
      },
    };
  }

  startListener(onTrigger: (result: SpotlightListenerEvent) => void): { stop: () => void } {
    const target = this.ensureBinary();
    if (!target) {
      return { stop: () => {} };
    }
    let cmd = target;
    let execArgs: string[] = ['listen'];
    if (target.endsWith('.swift')) {
      cmd = 'swift';
      execArgs = [target, 'listen'];
    }

    const child = spawn(cmd, execArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString('utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed && typeof parsed.app === 'string') {
            onTrigger(parsed as SpotlightPromptResult);
          }
        } catch {}
      }
    });

    return {
      stop: () => {
        try {
          child.kill('SIGTERM');
        } catch {}
      },
    };
  }
}
