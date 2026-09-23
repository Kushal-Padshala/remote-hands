import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecFunction } from './macos-driver.js';

export interface SpotlightPromptResult {
  query: string;
  app: string;
}

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
    if (fs.existsSync(this.binaryPath)) {
      return this.binaryPath;
    }
    if (fs.existsSync(this.swiftSourcePath)) {
      try {
        fs.mkdirSync(path.dirname(this.binaryPath), { recursive: true });
        const compile = spawnSync('swiftc', ['-O', this.swiftSourcePath, '-o', this.binaryPath], {
          encoding: 'utf-8',
        });
        if (compile.status === 0 && fs.existsSync(this.binaryPath)) {
          return this.binaryPath;
        }
      } catch {}
      return this.swiftSourcePath;
    }
    return null;
  }

  async openPrompt(activeApp?: string): Promise<SpotlightPromptResult | null> {
    const target = this.ensureBinary();
    const args: string[] = ['prompt'];
    if (activeApp) {
      args.push(`--app=${activeApp}`);
    }

    let cmd = 'swift';
    let execArgs = args;
    if (target && target.endsWith('.swift')) {
      cmd = 'swift';
      execArgs = [target, ...args];
    } else if (target) {
      cmd = target;
      execArgs = args;
    }

    const res = this.exec(cmd, execArgs);
    if (res.status !== 0 || !res.stdout.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && typeof parsed.query === 'string' && typeof parsed.app === 'string') {
        return parsed as SpotlightPromptResult;
      }
      return null;
    } catch {
      return null;
    }
  }

  startListener(onTrigger: (result: SpotlightPromptResult) => void): { stop: () => void } {
    const target = this.ensureBinary();
    let cmd = 'swift';
    let execArgs: string[] = ['listen'];
    if (target && target.endsWith('.swift')) {
      cmd = 'swift';
      execArgs = [target, 'listen'];
    } else if (target) {
      cmd = target;
      execArgs = ['listen'];
    }

    const child = spawn(cmd, execArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString('utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed && typeof parsed.query === 'string' && typeof parsed.app === 'string') {
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
