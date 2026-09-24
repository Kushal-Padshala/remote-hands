import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { ExecFunction } from './macos-driver.js';

export interface HudServiceOptions {
  exec?: ExecFunction | undefined;
  plistPath?: string | undefined;
  binPath?: string | undefined;
}

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

  constructor(options?: HudServiceOptions) {
    this.exec = options?.exec ?? ((cmd, args) => {
      const res = spawnSync(cmd, args, { encoding: 'utf-8' });
      return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
    });
    this.plistPath = options?.plistPath ?? getHudPlistPath();
  }

  isInstalled(): boolean {
    return fs.existsSync(this.plistPath);
  }

  isRunning(): boolean {
    const res = this.exec('launchctl', ['list']);
    return res.status === 0 && res.stdout.includes('com.remote-hands.hud');
  }

  install(cliPath?: string): { success: boolean; plistPath: string; error?: string } {
    if (process.platform !== 'darwin') {
      return { success: false, plistPath: this.plistPath, error: 'LaunchAgents are only supported on macOS' };
    }

    try {
      const resolvedCli = cliPath || this.resolveCliPath();
      const nodePath = process.execPath;
      const logDir = path.join(os.homedir(), '.remote-hands', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });

      const xml = generateHudPlistXml(nodePath, resolvedCli, logDir);
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
