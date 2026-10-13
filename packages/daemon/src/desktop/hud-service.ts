import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import type { ExecFunction } from './macos-driver.js';
import { ensureWindowsHud, type WindowsHudBuild } from './windows-hud.js';

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
    if (this.platform === 'win32') {
      const res = this.exec('tasklist', ['/FI', `IMAGENAME eq ${WINDOWS_HUD_IMAGE}`, '/FO', 'CSV', '/NH']);
      return res.status === 0 && res.stdout.toLowerCase().includes(`"${WINDOWS_HUD_IMAGE}"`);
    }
    const res = this.exec('launchctl', ['list']);
    return res.status === 0 && res.stdout.includes('com.remote-hands.hud');
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
      const args = ['supervise', `--node=${node}`, `--cli=${cli}`];
      // Each part is quoted so folders with spaces ("C:\\Users\\Ana Lee") survive.
      const value = `"${built.path}" supervise "--node=${node}" "--cli=${cli}"`;
      const added = this.exec('reg', ['add', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f']);
      if (added.status !== 0) {
        return { success: false, plistPath: where, error: `could not add the startup entry (${(added.stderr || added.stdout).trim().slice(0, 160) || 'reg.exe failed'})` };
      }
      // an older copy that is running is replaced by the new one
      this.exec('taskkill', ['/IM', WINDOWS_HUD_IMAGE, '/T', '/F']);
      (this.options.startDetached ?? ((command, startArgs) => {
        const child = spawn(command, startArgs, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => {});
        child.unref();
      }))(built.path, args);
      return { success: true, plistPath: where };
    } catch (err: any) {
      return { success: false, plistPath: where, error: err?.message || String(err) };
    }
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
      this.exec('taskkill', ['/IM', WINDOWS_HUD_IMAGE, '/T', '/F']);
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
