import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExecFunction } from './macos-driver.js';
import type { ContextAttachment } from '@remote-hands/shared';
import { ContextService } from '../context/context-service.js';

export interface SpotlightPromptResult {
  query: string;
  app: string;
  attachments?: ContextAttachment[];
}

export type SpotlightListenerEvent = SpotlightPromptResult | { event: string; app: string; query?: string };

export type HudUpdateSender = (status: string, text: string, role?: string) => void;

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
        if (process.platform === 'darwin') {
          const verify = spawnSync('codesign', ['-v', b], { encoding: 'utf-8' });
          if (verify.status !== 0) {
            spawnSync('codesign', ['-s', '-', '--force', b], { encoding: 'utf-8' });
          }
        }
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
          if (process.platform === 'darwin') {
            spawnSync('codesign', ['-s', '-', '--force', userBinPath], { encoding: 'utf-8' });
          }
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
        return {
          query: parsed.query,
          app: parsed.app || activeApp || 'Desktop',
          attachments: Array.isArray(parsed.attachments) ? parsed.attachments : undefined,
        };
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
    onStop?: (sendUpdate?: HudUpdateSender) => void,
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

    try {
      const contextService = new ContextService();
      contextService.getHierarchy().then((h) => {
        if (!child.killed && child.stdin && child.stdin.writable) {
          child.stdin.write(JSON.stringify({ event: 'context', hierarchy: h }) + '\n');
        }
      }).catch(() => {});
    } catch {}

    let submitted = false;
    let cancelled = false;

    const triggerCancel = () => {
      if (!cancelled) {
        cancelled = true;
        if (onCancel) {
          try {
            onCancel();
          } catch {}
        }
      }
    };

    const sendUpdate: HudUpdateSender = (status: string, text: string, role?: string) => {
      if (!child.killed && child.stdin && child.stdin.writable) {
        try {
          const payload: any = { status, text };
          if (role) payload.role = role;
          child.stdin.write(JSON.stringify(payload) + '\n');
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
              attachments: Array.isArray(parsed.attachments) ? parsed.attachments : undefined,
            };
            Promise.resolve(onSubmit(res, sendUpdate)).catch(() => {});
          } else if (parsed.event === 'stop') {
            if (onStop) {
              try {
                onStop(sendUpdate);
              } catch {}
            }
          } else if (parsed.event === 'cancel') {
            triggerCancel();
            try {
              child.kill();
            } catch {}
          }
        } catch {}
      }
    });

    child.on('close', () => {
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          if (parsed.event === 'cancel') {
            triggerCancel();
          }
        } catch {}
      }
      triggerCancel();
    });

    return {
      close: () => {
        triggerCancel();
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

    let stopped = false;
    let child: any = null;
    let restartTimer: NodeJS.Timeout | null = null;

    const spawnChild = () => {
      if (stopped) return;
      try {
        child = spawn(cmd, execArgs, {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.on('error', () => {});
        child.stdout?.on('data', (chunk: Buffer) => {
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
        child.on('exit', () => {
          if (!stopped) {
            restartTimer = setTimeout(spawnChild, 1000);
          }
        });
      } catch {}
    };

    spawnChild();

    return {
      stop: () => {
        stopped = true;
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        if (child) {
          try {
            child.kill('SIGTERM');
          } catch {}
        }
      },
    };
  }
}
