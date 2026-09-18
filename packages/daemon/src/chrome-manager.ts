import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { isSafeBrowserUrl } from '@remote-hands/shared';

export type ChromeProfileMode = 'active' | 'dedicated' | 'none';

export interface ChromeProfileInfo {
  id: string;
  name: string;
  email?: string | undefined;
  directory: string;
  isDefault?: boolean | undefined;
}

export interface ChromeManagerOptions {
  mode?: ChromeProfileMode | undefined;
  port?: number | undefined;
  customProfileDir?: string | undefined;
  chromeExecutablePath?: string | undefined;
  profile?: string | undefined;
}

export interface ChromeStatus {
  available: boolean;
  port: number;
  mode: ChromeProfileMode;
  wsUrl?: string | undefined;
  browser?: string | undefined;
  profileDir?: string | undefined;
  profileName?: string | undefined;
  profileDirectory?: string | undefined;
}

export class ChromeManager {
  private mode: ChromeProfileMode;
  private port: number;
  private customProfileDir?: string | undefined;
  private chromeExecutablePath: string;
  private targetProfile?: string | undefined;
  private resolvedProfile?: ChromeProfileInfo | undefined;
  private process: ChildProcess | null = null;

  constructor(options?: ChromeManagerOptions) {
    this.mode = options?.mode ?? (options?.profile ? 'active' : 'dedicated');
    this.port = options?.port ?? 9222;
    this.customProfileDir = options?.customProfileDir;
    this.chromeExecutablePath =
      options?.chromeExecutablePath ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : 'google-chrome');
    this.targetProfile = options?.profile;

    const baseDir = this.customProfileDir ?? (this.mode === 'active' ? ChromeManager.getDefaultUserDataDir() : undefined);
    if (this.targetProfile) {
      let resolved = ChromeManager.resolveProfile(this.targetProfile, baseDir);
      if (!resolved && !this.customProfileDir) {
        resolved = ChromeManager.resolveProfile(
          this.targetProfile,
          ChromeManager.getDefaultUserDataDir(),
        );
      }
      this.resolvedProfile =
        resolved ?? {
          id: this.targetProfile,
          name: this.targetProfile,
          directory: this.targetProfile,
        };
    } else if (this.mode === 'active') {
      this.resolvedProfile = ChromeManager.resolveProfile(undefined, baseDir);
    }
  }

  static isSystemChromeRunning(): boolean {
    const defaultDir = ChromeManager.getDefaultUserDataDir();
    const lockFile = path.join(defaultDir, 'SingletonLock');
    try {
      const stat = fs.lstatSync(lockFile);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(lockFile);
        const match = target.match(/-(\d+)$/);
        if (match && match[1]) {
          const pid = parseInt(match[1], 10);
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        }
      }
    } catch {}
    return false;
  }

  static syncProfileAuthState(sourceDir: string, profileDirName: string, destDir: string): void {
    fs.mkdirSync(destDir, { recursive: true });
    const localStateSrc = path.join(sourceDir, 'Local State');
    const localStateDst = path.join(destDir, 'Local State');
    if (fs.existsSync(localStateSrc)) {
      try {
        fs.copyFileSync(localStateSrc, localStateDst);
      } catch {}
    }

    const destProfile = path.join(destDir, profileDirName);
    fs.mkdirSync(destProfile, { recursive: true });

    const srcProfile = path.join(sourceDir, profileDirName);
    if (!fs.existsSync(srcProfile)) return;

    const files = [
      'Cookies',
      'Cookies-journal',
      'Login Data',
      'Login Data-journal',
      'Web Data',
      'Web Data-journal',
      'Preferences',
      'Secure Preferences',
    ];
    for (const f of files) {
      const sf = path.join(srcProfile, f);
      const df = path.join(destProfile, f);
      if (fs.existsSync(sf)) {
        try {
          fs.copyFileSync(sf, df);
        } catch {}
      }
    }

    const netSrc = path.join(srcProfile, 'Network');
    if (fs.existsSync(netSrc)) {
      const netDst = path.join(destProfile, 'Network');
      fs.mkdirSync(netDst, { recursive: true });
      try {
        const entries = fs.readdirSync(netSrc);
        for (const entry of entries) {
          if (!entry.endsWith('-lock')) {
            fs.copyFileSync(path.join(netSrc, entry), path.join(netDst, entry));
          }
        }
      } catch {}
    }
  }

  static getDefaultUserDataDir(): string {
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
    }
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'Google', 'Chrome', 'User Data');
    }
    const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configDir, 'google-chrome');
  }

  static listProfiles(userDataDir?: string): ChromeProfileInfo[] {
    const baseDir = userDataDir ?? ChromeManager.getDefaultUserDataDir();
    const localStatePath =
      fs.existsSync(baseDir) && fs.statSync(baseDir).isFile()
        ? baseDir
        : path.join(baseDir, 'Local State');

    if (!fs.existsSync(localStatePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(localStatePath, 'utf-8');
      const data = JSON.parse(content);
      const infoCache = data?.profile?.info_cache;
      if (!infoCache || typeof infoCache !== 'object') {
        return [];
      }

      const lastUsed = typeof data?.profile?.last_used === 'string' ? data.profile.last_used : undefined;

      const profiles: ChromeProfileInfo[] = [];
      for (const [key, raw] of Object.entries(infoCache)) {
        const entry = raw as any;
        if (!entry || typeof entry !== 'object') continue;
        const name =
          typeof entry.name === 'string' && entry.name.trim().length > 0
            ? entry.name.trim()
            : key;
        const email =
          typeof entry.user_name === 'string' && entry.user_name.trim().length > 0
            ? entry.user_name.trim()
            : undefined;

        profiles.push({
          id: key,
          name,
          email,
          directory: key,
          isDefault: key === lastUsed || (lastUsed === undefined && (key === 'Default' || Boolean(entry.is_default))),
        });
      }

      return profiles;
    } catch {
      return [];
    }
  }

  static resolveProfile(target?: string, userDataDir?: string): ChromeProfileInfo | undefined {
    const profiles = ChromeManager.listProfiles(userDataDir);
    if (!target || target === 'active' || target === 'default') {
      const defaultProf = profiles.find((p) => p.isDefault);
      if (defaultProf) return defaultProf;
      const personalProf = profiles.find((p) => {
        const n = p.name.toLowerCase();
        const em = p.email?.toLowerCase() || '';
        return (
          p.directory === 'Profile 4' ||
          n.includes('personal') ||
          (em && !em.includes('business') && !em.includes('info') && !em.includes('edu'))
        );
      });
      if (personalProf) return personalProf;
      return profiles[0];
    }

    const normalized = target.trim().toLowerCase();

    if (normalized === 'personal') {
      const personalProf = profiles.find((p) => {
        const n = p.name.toLowerCase();
        const em = p.email?.toLowerCase() || '';
        return (
          p.directory === 'Profile 4' ||
          n.includes('personal') ||
          (em && !em.includes('business') && !em.includes('info') && !em.includes('edu'))
        );
      });
      if (personalProf) return personalProf;
    }

    const byId = profiles.find(
      (p) => p.id.toLowerCase() === normalized || p.directory.toLowerCase() === normalized,
    );
    if (byId) return byId;

    const byName = profiles.find((p) => p.name.toLowerCase() === normalized);
    if (byName) return byName;

    const byEmail = profiles.find((p) => p.email?.toLowerCase() === normalized);
    if (byEmail) return byEmail;

    return undefined;
  }

  getMode(): ChromeProfileMode {
    return this.mode;
  }

  getPort(): number {
    return this.port;
  }

  getProfile(): string | undefined {
    return this.targetProfile;
  }

  getResolvedProfile(): ChromeProfileInfo | undefined {
    return this.resolvedProfile;
  }

  resolveProfile(target?: string): ChromeProfileInfo | undefined {
    const t = target ?? this.targetProfile;
    return ChromeManager.resolveProfile(t, this.getProfileDirectory());
  }

  getProfileDirectory(): string {
    if (this.customProfileDir) return this.customProfileDir;
    if (this.mode === 'active') {
      return ChromeManager.getDefaultUserDataDir();
    }
    return path.join(os.homedir(), '.remote-hands/chrome-profile');
  }

  async checkDebuggerStatus(): Promise<ChromeStatus> {
    const base: ChromeStatus = {
      available: false,
      port: this.port,
      mode: this.mode,
      profileDir: this.getProfileDirectory(),
      profileName: this.resolvedProfile?.name,
      profileDirectory: this.resolvedProfile?.directory,
    };

    if (this.mode === 'none') return base;

    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) return base;
      const data = (await res.json()) as any;
      return {
        available: true,
        port: this.port,
        mode: this.mode,
        wsUrl: data.webSocketDebuggerUrl,
        browser: data.Browser,
        profileDir: this.getProfileDirectory(),
        profileName: this.resolvedProfile?.name,
        profileDirectory: this.resolvedProfile?.directory,
      };
    } catch {
      return base;
    }
  }

  buildLaunchArgs(url?: string): string[] {
    let profileDir = this.getProfileDirectory();
    if (this.mode === 'active' && !this.customProfileDir && ChromeManager.isSystemChromeRunning()) {
      profileDir = path.join(os.homedir(), '.remote-hands/chrome-profile');
    }

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];
    if (this.resolvedProfile?.directory) {
      args.push(`--profile-directory=${this.resolvedProfile.directory}`);
    }
    if (url && isSafeBrowserUrl(url)) {
      args.push(url);
    }
    return args;
  }

  async ensureRunning(initialUrl?: string): Promise<ChromeStatus> {
    if (this.mode === 'none') {
      return this.checkDebuggerStatus();
    }

    const current = await this.checkDebuggerStatus();
    if (current.available) {
      return current;
    }

    let profileDir = this.getProfileDirectory();
    if (this.mode === 'active' && !this.customProfileDir && ChromeManager.isSystemChromeRunning()) {
      profileDir = path.join(os.homedir(), '.remote-hands/chrome-profile');
      ChromeManager.syncProfileAuthState(
        ChromeManager.getDefaultUserDataDir(),
        this.resolvedProfile?.directory || 'Default',
        profileDir,
      );
    }

    fs.mkdirSync(profileDir, { recursive: true });

    const args = this.buildLaunchArgs(initialUrl);
    this.process = spawn(this.chromeExecutablePath, args, {
      detached: true,
      stdio: 'ignore',
    });
    this.process.unref();

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const status = await this.checkDebuggerStatus();
      if (status.available) {
        return status;
      }
    }

    return this.checkDebuggerStatus();
  }

  close(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {}
      this.process = null;
    }
  }
}
