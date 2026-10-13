import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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

export function generateHudPlistXml(nodePath: string, cliPath: string, logDir: string): string {
  const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const homeDir = os.homedir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.remote-hands.hud</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliPath}</string>
        <string>hud</string>
        <string>listen</string>
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
    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'hud.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'hud.error.log')}</string>
</dict>
</plist>
`;
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
    // and it is OUR program, not a copy somewhere else
    const ours = windowsHudPaths(this.home).exe.replace(/\//g, '\\').toLowerCase();
    return parsed.program.toLowerCase() === ours ? pid : undefined;
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
      const nodePath = process.execPath;
      const logDir = path.join(os.homedir(), '.remote-hands', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });

      const safeCliDir = path.join(os.homedir(), '.remote-hands', 'cli');
      fs.mkdirSync(safeCliDir, { recursive: true });
      const safeCliPath = path.join(safeCliDir, 'index.js');
      let targetCliPath = resolvedCli;
      if (fs.existsSync(resolvedCli)) {
        try {
          fs.copyFileSync(resolvedCli, safeCliPath);
          targetCliPath = safeCliPath;
        } catch {}
      }

      const xml = generateHudPlistXml(nodePath, targetCliPath, logDir);
      fs.writeFileSync(this.plistPath, xml, 'utf-8');

      this.exec('launchctl', ['unload', this.plistPath]);
      const loadRes = this.exec('launchctl', ['load', '-w', this.plistPath]);

      return {
        success: loadRes.status === 0 || fs.existsSync(this.plistPath),
        plistPath: this.plistPath,
      };
    } catch (err: any) {
      return { success: false, plistPath: this.plistPath, error: err?.message || String(err) };
    }
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

  private resolveCliPath(): string {
    const whichRh = this.exec('which', ['rh']);
    if (whichRh.status === 0 && whichRh.stdout.trim()) {
      return whichRh.stdout.trim();
    }
    const whichRemoteHands = this.exec('which', ['remote-hands']);
    if (whichRemoteHands.status === 0 && whichRemoteHands.stdout.trim()) {
      return whichRemoteHands.stdout.trim();
    }
    return path.resolve(os.homedir(), 'Desktop/project/remote-hands/packages/cli/dist/index.js');
  }
}
