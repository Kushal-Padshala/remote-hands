import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { ExecFunction } from './macos-driver.js';
import {
  clearHudStatus,
  ensureWindowsHud,
  readHudStatus,
  readHudSupervisorPid,
  hudSupervisorPidPath,
  parseHudCommandLine,
  windowsHudPaths,
  writeHudSettings,
  type HudStatus,
  type WindowsHudBuild,
} from './windows-hud.js';

export interface HudServiceOptions {
  exec?: ExecFunction | undefined;
  plistPath?: string | undefined;
  binPath?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  home?: string | undefined;
  /** Windows: builds (or finds) the HUD program; tests replace it. */
  buildWindowsHud?: (() => WindowsHudBuild) | undefined;
  /** Windows: starts the supervisor right away without waiting for the next login; tests replace it. */
  startDetached?: ((command: string, args: string[]) => void) | undefined;
  /** Windows: the program that runs the CLI (defaults to this one). */
  nodePath?: string | undefined;
  /** Windows: waits between looks at the listener's status; tests replace it. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Where Windows keeps "start this when I log in" for the current user (no administrator rights needed). */
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_RUN_VALUE = 'RemoteHandsHud';
export const WINDOWS_HUD_IMAGE = 'rh-hud.exe';

export function getHudPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.remote-hands.hud.plist');
}

/**
 * The login service starts this small script, not Node itself, and the script finds Node each time. A Node path baked into
 * the plist breaks the HUD silently as soon as Node moves (nvm, `brew upgrade node`). The Node setup ran under comes first,
 * because that is the program macOS permissions (Screen Recording) were given to.
 */
export function generateHudLauncherScript(): string {
  return `#!/bin/sh
# Starts the Remote Hands HUD. Written by "rh hud install"; do not edit.
RH="$HOME/.remote-hands"
NODE=""
for candidate in "$(cat "$RH/node-path" 2>/dev/null)" "$RH/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then NODE="$(command -v node 2>/dev/null)"; fi
if [ -z "$NODE" ]; then NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"; fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "Remote Hands: Node.js was not found. Run: rh hud install" >&2
  exit 78
fi
PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
export PATH
exec "$NODE" "$RH/cli/index.js" hud listen
`;
}

export function generateHudPlistXml(launcherPath: string, logDir: string, homeDir: string = os.homedir()): string {
  const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.remote-hands.hud</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>${launcherPath}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${currentPath}</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'hud.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'hud.error.log')}</string>
</dict>
</plist>
`;
}

/**
 * A Homebrew Node's real path holds its version and disappears on the next upgrade; the link next to it stays.
 * (Also the one macOS shows in Screen Recording, so the permission survives an upgrade.)
 */
export function stableNodePath(execPath: string, exists: (p: string) => boolean = fs.existsSync): string {
  const marker = '/Cellar/node/';
  const at = execPath.indexOf(marker);
  if (at > 0) {
    const link = path.join(execPath.slice(0, at), 'bin', 'node');
    if (exists(link)) return link;
  }
  return execPath;
}

export class HudServiceManager {
  private exec: ExecFunction;
  private plistPath: string;
  private platform: NodeJS.Platform;
  private home: string;
  private options: HudServiceOptions;

  constructor(options?: HudServiceOptions) {
    this.exec = options?.exec ?? ((cmd, args) => {
      const res = spawnSync(cmd, args, { encoding: 'utf-8' });
      return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
    });
    this.plistPath = options?.plistPath ?? getHudPlistPath();
    this.platform = options?.platform ?? process.platform;
    this.home = options?.home ?? os.homedir();
    this.options = options ?? {};
  }

  isInstalled(): boolean {
    if (this.platform === 'win32') {
      return this.exec('reg', ['query', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE]).status === 0;
    }
    return fs.existsSync(this.plistPath);
  }

  isRunning(): boolean {
    if (this.platform === 'win32') return this.windowsSupervisorAlive();
    const res = this.exec('launchctl', ['list']);
    return res.status === 0 && res.stdout.includes('com.remote-hands.hud');
  }

  /**
   * The supervisor's process id, but only when that id is still a running `rh-hud.exe supervise`: ids are reused, and an
   * independently opened prompt window (same program, other role) must never be mistaken for the service.
   */
  private windowsSupervisorPid(): number | undefined {
    const pid = readHudSupervisorPid(this.home);
    if (pid === undefined) return undefined;
    const res = this.exec('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    const parsed = res.status === 0 ? parseHudCommandLine(res.stdout.trim()) : undefined;
    if (!parsed || parsed.role !== 'supervise') return undefined;
    // and it is OUR program, not a copy somewhere else (the same file reached through a short name or a junction still counts)
    const canonical = (p: string): string => {
      try {
        return fs.realpathSync.native(p).toLowerCase();
      } catch {
        return p.replace(/\//g, '\\').toLowerCase();
      }
    };
    return canonical(parsed.program) === canonical(windowsHudPaths(this.home).exe) ? pid : undefined;
  }

  private windowsSupervisorAlive(): boolean {
    return this.windowsSupervisorPid() !== undefined;
  }

  /** Ends the service (the supervisor and what it started), never a prompt window someone opened separately. */
  private stopWindowsSupervisor(): void {
    const pid = this.windowsSupervisorPid();
    if (pid !== undefined) this.exec('taskkill', ['/PID', String(pid), '/T', '/F']);
    try {
      fs.rmSync(hudSupervisorPidPath(this.home), { force: true });
    } catch {
      // nothing to remove
    }
  }

  /** Windows: builds the HUD program, makes it start at login, and starts it now. */
  private installWindows(cliPath?: string): { success: boolean; plistPath: string; error?: string } {
    const where = 'the Windows startup list (Settings > Apps > Startup)';
    const built = (this.options.buildWindowsHud ?? (() => ensureWindowsHud({ home: this.home })))();
    if (!built.ok) return { success: false, plistPath: where, error: built.error };
    try {
      // the same copy of the CLI every time, in a folder nothing blocks (as on the Mac)
      const safeCliDir = path.join(this.home, '.remote-hands', 'cli');
      fs.mkdirSync(safeCliDir, { recursive: true });
      const safeCli = path.join(safeCliDir, 'index.js');
      const source = cliPath || process.argv[1] || '';
      let cli = safeCli;
      if (source && fs.existsSync(source) && path.resolve(source) !== path.resolve(safeCli)) {
        try {
          fs.copyFileSync(source, safeCli);
        } catch {
          cli = source;
        }
      } else if (!fs.existsSync(safeCli)) {
        cli = source || safeCli;
      }
      const node = this.options.nodePath ?? process.execPath;
      // Which Node and CLI to run live in a settings file: the login entry has a short length limit (260 characters).
      writeHudSettings({ node, cli }, this.home);
      const value = `"${built.path}" supervise`;
      const added = this.exec('reg', ['add', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f']);
      if (added.status !== 0) {
        return { success: false, plistPath: where, error: `could not add the startup entry (${(added.stderr || added.stdout).trim().slice(0, 160) || 'reg.exe failed'})` };
      }
      // the older service, if one is running, is replaced; a prompt window opened on its own is left alone
      this.stopWindowsSupervisor();
      clearHudStatus(this.home);
      (this.options.startDetached ?? ((command, startArgs) => {
        const child = spawn(command, startArgs, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => {});
        child.unref();
      }))(built.path, ['supervise']);
      return { success: true, plistPath: where };
    } catch (err: any) {
      return { success: false, plistPath: where, error: err?.message || String(err) };
    }
  }

  /**
   * Windows: after `install`, waits for the listener to say whether it got its hotkey. `null` when it has said nothing yet
   * (it may still be starting); the caller then says so instead of claiming the shortcut works.
   */
  async waitForHotkey(timeoutMs = 12_000, intervalMs = 300): Promise<HudStatus | null> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
      const status = readHudStatus(this.home);
      if (status) return status;
      await sleep(intervalMs);
    }
    return null;
  }

  install(cliPath?: string): { success: boolean; plistPath: string; error?: string } {
    if (this.platform === 'win32') return this.installWindows(cliPath);
    if (this.platform !== 'darwin') {
      return { success: false, plistPath: this.plistPath, error: 'The desktop HUD is supported on macOS and Windows' };
    }

    try {
      const resolvedCli = cliPath || this.resolveCliPath();
      const rhDir = path.join(this.home, '.remote-hands');
      const logDir = path.join(rhDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });

      const safeCliDir = path.join(rhDir, 'cli');
      fs.mkdirSync(safeCliDir, { recursive: true });
      const safeCliPath = path.join(safeCliDir, 'index.js');
      if (fs.existsSync(resolvedCli) && path.resolve(resolvedCli) !== path.resolve(safeCliPath)) {
        fs.copyFileSync(resolvedCli, safeCliPath);
      } else if (!fs.existsSync(safeCliPath)) {
        return { success: false, plistPath: this.plistPath, error: `could not find the Remote Hands program to run in the background (looked at ${resolvedCli})` };
      }

      // the Node that runs it, remembered for the launcher (macOS permissions belong to this exact program)
      fs.writeFileSync(path.join(rhDir, 'node-path'), stableNodePath(this.options.nodePath ?? process.execPath), 'utf-8');
      const binDir = path.join(rhDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const launcher = path.join(binDir, 'rh-hud-launch.sh');
      fs.writeFileSync(launcher, generateHudLauncherScript(), { encoding: 'utf-8', mode: 0o755 });
      fs.chmodSync(launcher, 0o755);

      const xml = generateHudPlistXml(launcher, logDir, this.home);
      fs.writeFileSync(this.plistPath, xml, 'utf-8');

      this.exec('launchctl', ['unload', this.plistPath]);
      // what an earlier listener said about its shortcut is not this start's answer
      clearHudStatus(this.home);
      const loadRes = this.exec('launchctl', ['load', '-w', this.plistPath]);

      return {
        success: loadRes.status === 0 || fs.existsSync(this.plistPath),
        plistPath: this.plistPath,
      };
    } catch (err: any) {
      return { success: false, plistPath: this.plistPath, error: err?.message || String(err) };
    }
  }

  /**
   * Is the copy the login service runs older than the Remote Hands program that is running now (after an `npm update -g`)?
   * `rh hud install` brings it up to date.
   */
  installedCopyIsStale(currentCli: string | undefined = process.argv[1]): boolean {
    try {
      if (!currentCli) return false;
      const copy = path.join(this.home, '.remote-hands', 'cli', 'index.js');
      const current = fs.realpathSync(currentCli);
      if (!fs.existsSync(copy) || path.resolve(current) === path.resolve(copy)) return false;
      if (!current.endsWith('.js')) return false;
      const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      return sha(copy) !== sha(current);
    } catch {
      return false;
    }
  }

  /** macOS: starts the service again (after a permission was given). True when launchctl accepted it. */
  restart(): boolean {
    if (this.platform !== 'darwin') return false;
    clearHudStatus(this.home);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined) {
      const kicked = this.exec('launchctl', ['kickstart', '-k', `gui/${uid}/com.remote-hands.hud`]);
      if (kicked.status === 0) return true;
    }
    this.exec('launchctl', ['unload', this.plistPath]);
    return this.exec('launchctl', ['load', '-w', this.plistPath]).status === 0;
  }

  uninstall(): boolean {
    if (this.platform === 'win32') {
      const removed = this.exec('reg', ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f']).status === 0;
      this.stopWindowsSupervisor();
      clearHudStatus(this.home);
      return removed;
    }
    try {
      if (fs.existsSync(this.plistPath)) {
        this.exec('launchctl', ['unload', '-w', this.plistPath]);
        fs.unlinkSync(this.plistPath);
        return true;
      }
    } catch {}
    return false;
  }

  /** The Remote Hands program that is running right now, else whatever `rh` points at. Never a guessed folder. */
  private resolveCliPath(): string {
    const entry = process.argv[1];
    if (entry) {
      try {
        const real = fs.realpathSync(entry);
        if (real.endsWith('.js')) return real;
      } catch {
        // fall through to the lookups below
      }
    }
    for (const name of ['rh', 'remote-hands']) {
      const found = this.exec('which', [name]);
      const candidate = found.status === 0 ? found.stdout.trim() : '';
      if (candidate) {
        try {
          const real = fs.realpathSync(candidate);
          if (real.endsWith('.js')) return real;
        } catch {
          // try the next name
        }
      }
    }
    return path.join(this.home, '.remote-hands', 'cli', 'index.js');
  }
}
