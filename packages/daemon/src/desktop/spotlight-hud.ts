import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExecFunction } from './macos-driver.js';
import type { ContextAttachment } from '@remote-hands/shared';
import { ContextService } from '../context/context-service.js';
import { SPOTLIGHT_SWIFT_SOURCE } from './spotlight-source.generated.js';
import { clearHudReadyStatus, ensureWindowsHud, saveHudStatus } from './windows-hud.js';

export interface SpotlightPromptResult {
  query: string;
  app: string;
  windowTitle?: string | undefined;
  attachments?: ContextAttachment[];
  /** The key of the model picked in the prompt window, when it offered a choice. */
  model?: string | undefined;
}

/** The models the prompt window offers, which one is selected, and what to do when the person picks another. */
export interface HudModelMenu {
  models: Array<{ key: string; label: string }>;
  model: string;
  onModel: (key: string) => void;
}

export type SpotlightListenerEvent =
  | SpotlightPromptResult
  | { event: string; app: string; windowTitle?: string | undefined; query?: string | undefined };

export type HudUpdateSender = (status: string, text: string, role?: string) => void;

/**
 * Writes the embedded hotkey-helper source to `<home>/.remote-hands/spotlight-hud.swift` when it
 * is missing or differs (so the installed CLI can build the helper without the repo checkout).
 * Returns the path. An unchanged file is left alone, so its mtime keeps the compiled binary fresh.
 */
export function materializeSwiftSource(home: string, source: string = SPOTLIGHT_SWIFT_SOURCE): string {
  const target = path.join(home, '.remote-hands', 'spotlight-hud.swift');
  let current: string | null = null;
  try {
    current = fs.readFileSync(target, 'utf-8');
  } catch {}
  if (current !== source) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf-8');
  }
  return target;
}

export type HotkeyHelperStatus = { ok: true; path: string } | { ok: false; error: string };

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

  /**
   * Builds (or finds) the hotkey helper now and says whether it can run, so setup can fail
   * loudly instead of leaving a hotkey that silently does nothing.
   */
  prepare(): HotkeyHelperStatus {
    if (process.platform === 'win32') {
      const built = ensureWindowsHud();
      return built.ok ? { ok: true, path: built.path } : { ok: false, error: `could not build the hotkey program: ${built.error}` };
    }
    const target = this.ensureBinary();
    if (target && !target.endsWith('.swift')) return { ok: true, path: target };
    return {
      ok: false,
      error:
        'could not build the hotkey helper. It needs the Xcode Command Line Tools: run "xcode-select --install", wait for it to finish, then run "rh setup --hud" again.',
    };
  }

  private ensureBinary(): string | null {
    // Windows: a small program built from C# with the compiler Windows ships.
    if (process.platform === 'win32') {
      const built = ensureWindowsHud();
      return built.ok ? built.path : null;
    }
    // The CLI ships as one file: make sure the helper's source is on disk for the build below (tests never write to the real home).
    if (process.env.VITEST !== 'true') {
      try {
        materializeSwiftSource(os.homedir());
      } catch {}
    }
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const userBinPath = path.join(os.homedir(), '.remote-hands', 'bin', 'rh-spotlight');

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
    let swiftMtime = 0;
    for (const s of candidateSwift) {
      if (fs.existsSync(s)) {
        swiftFile = s;
        try {
          swiftMtime = fs.statSync(s).mtimeMs;
        } catch {}
        break;
      }
    }

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
        try {
          const binMtime = fs.statSync(b).mtimeMs;
          if (swiftMtime > 0 && binMtime < swiftMtime) {
            continue;
          }
        } catch {}

        if (process.platform === 'darwin') {
          const verify = spawnSync('codesign', ['-v', b], { encoding: 'utf-8' });
          if (verify.status !== 0) {
            spawnSync('codesign', ['-s', '-', '--force', b], { encoding: 'utf-8' });
          }
        }
        return b;
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

  async openPrompt(activeApp?: string, windowTitle?: string): Promise<SpotlightPromptResult | null> {
    const target = this.ensureBinary();
    if (!target) {
      return null;
    }
    const args: string[] = ['prompt'];
    // this call has no daemon to talk to: the Windows window prints the first request and ends
    if (process.platform === 'win32') args.push('--once');
    if (activeApp) {
      args.push(`--app=${activeApp}`);
    }
    if (windowTitle) {
      args.push(`--window-title=${windowTitle}`);
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
          windowTitle: parsed.windowTitle || windowTitle || undefined,
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
    windowTitle?: string | undefined,
    modelMenu?: HudModelMenu | undefined,
  ): { close: () => void } {
    const target = this.ensureBinary();
    if (!target) {
      return { close: () => {} };
    }
    const args: string[] = ['prompt'];
    if (activeApp) {
      args.push(`--app=${activeApp}`);
    }
    if (windowTitle) {
      args.push(`--window-title=${windowTitle}`);
    }
    if (modelMenu && modelMenu.models.length > 0) {
      args.push(`--models=${JSON.stringify(modelMenu.models)}`, `--model=${modelMenu.model}`);
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
              windowTitle: parsed.windowTitle || windowTitle || undefined,
              attachments: Array.isArray(parsed.attachments) ? parsed.attachments : undefined,
              ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
            };
            Promise.resolve(onSubmit(res, sendUpdate)).catch(() => {});
          } else if (parsed.event === 'model') {
            if (modelMenu && typeof parsed.model === 'string') {
              try {
                modelMenu.onModel(parsed.model);
              } catch {}
            }
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
      let isCancelEvent = false;
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          if (parsed.event === 'cancel') {
            isCancelEvent = true;
          }
        } catch {}
      }
      if (isCancelEvent || !submitted) {
        triggerCancel();
      }
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
      console.error('Remote Hands: the Shift+Cmd+Space helper is missing, so the hotkey cannot work. Run "rh setup --hud".');
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
    // Windows: a helper that cannot get its shortcut ends at once; trying again every second would never stop
    let startedAt = 0;
    let retryMs = 1000;
    let warnedShortcut = false;

    const spawnChild = () => {
      if (stopped) return;
      startedAt = Date.now();
      // what the helper said about its shortcut belongs to that helper only
      clearHudReadyStatus();
      try {
        child = spawn(cmd, execArgs, {
          // Windows: the helper ends when this input ends (this program is gone), so it is never left holding the hotkey
          stdio: [process.platform === 'win32' ? 'pipe' : 'ignore', 'pipe', 'ignore'],
        });
        child.on('error', () => {});
        child.stdout?.on('data', (chunk: Buffer) => {
          const lines = chunk.toString('utf-8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line.trim());
              if (parsed && parsed.event === 'hotkey-ready' && typeof parsed.keys === 'string') {
                saveHudStatus({ state: 'ready', keys: parsed.keys });
              } else if (parsed && parsed.event === 'hotkey-failed') {
                saveHudStatus({ state: 'failed' });
                if (!warnedShortcut) {
                  warnedShortcut = true;
                  console.error(
                    process.platform === 'darwin'
                      ? 'Remote Hands: Shift+Cmd+Space is already used by another app (for example Raycast or Alfred), so the HUD may not open with it. Change that app\'s shortcut and run "rh hud install" again.'
                      : 'Remote Hands: the HUD hotkey is already used by another program (tried Ctrl+Shift+Space and Ctrl+Alt+Space). Close that program and run "rh hud install" again.',
                  );
                }
              } else if (parsed && typeof parsed.app === 'string') {
                onTrigger(parsed as SpotlightPromptResult);
              }
            } catch {}
          }
        });
        child.on('exit', () => {
          clearHudReadyStatus();
          if (!stopped) {
            if (process.platform === 'win32') retryMs = Date.now() - startedAt > 60_000 ? 1000 : Math.min(retryMs * 2, 30_000);
            restartTimer = setTimeout(spawnChild, process.platform === 'win32' ? retryMs : 1000);
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
