import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ContextAppTarget,
  ContextBrowserProfile,
  ContextBrowserTarget,
  ContextFileTarget,
  ContextHierarchy,
} from '@remote-hands/shared';

const execFileAsync = promisify(execFile);

export interface ChromeTabItem {
  id: string;
  title: string;
  url: string;
  profile?: string | undefined;
  tabIndex?: number | undefined;
}

export interface ContextServiceOptions {
  chromeTabProvider?: () => Promise<ChromeTabItem[]>;
  appleScriptRunner?: (script: string) => Promise<string>;
  runningAppProvider?: () => Promise<Array<{ name: string; bundleId?: string }>>;
  fileProvider?: () => Promise<ContextFileTarget[]>;
}

export class ContextService {
  private chromeTabProvider?: (() => Promise<ChromeTabItem[]>) | undefined;
  private appleScriptRunner: (script: string) => Promise<string>;
  private runningAppProvider?: (() => Promise<Array<{ name: string; bundleId?: string }>>) | undefined;
  private fileProvider?: (() => Promise<ContextFileTarget[]>) | undefined;

  constructor(options?: ContextServiceOptions) {
    this.chromeTabProvider = options?.chromeTabProvider;
    this.appleScriptRunner = options?.appleScriptRunner || this.defaultAppleScriptRunner.bind(this);
    this.runningAppProvider = options?.runningAppProvider;
    this.fileProvider = options?.fileProvider;
  }

  private async defaultAppleScriptRunner(script: string): Promise<string> {
    if (process.platform !== 'darwin') return '';
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 4000 });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async fetchChromeTabsViaCdp(): Promise<ChromeTabItem[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://127.0.0.1:9222/json/list', { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return [];
      const data = (await res.json()) as any[];
      return data
        .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
        .map((t, idx) => ({
          id: t.id || `chrome-${idx}`,
          title: t.title || 'Untitled',
          url: t.url || '',
          profile: 'Default',
          tabIndex: idx,
        }));
    } catch {
      return [];
    }
  }

  private async fetchBrowserTabsViaAppleScript(
    appName: string,
    useNameProperty = false,
  ): Promise<Array<{ id: string; title: string; url: string }>> {
    const titleProp = useNameProperty ? 'name' : 'title';
    const script = `
tell application "System Events"
  set isRunning to (name of processes) contains "${appName}"
end tell
if isRunning then
  tell application "${appName}"
    set out to ""
    repeat with w in windows
      repeat with t in tabs of w
        set out to out & (${titleProp} of t) & "|||" & (URL of t) & "\\n"
      end repeat
    end repeat
    return out
  end tell
end if
    `;
    const raw = await this.appleScriptRunner(script);
    if (!raw) return [];
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, idx) => {
        const [title, url] = line.split('|||');
        return {
          id: `${appName.toLowerCase().replace(/\s+/g, '-')}-${idx}`,
          title: (title || 'Untitled').trim(),
          url: (url || '').trim(),
        };
      });
  }

  private fetchArcTabsFromStorage(): { id: string; title: string; url: string }[] {
    try {
      const filePath = path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json');
      if (!fs.existsSync(filePath)) return [];
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      const tabs: { id: string; title: string; url: string }[] = [];
      const seen = new Set<string>();

      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (node.data && node.data.tab && node.data.tab.savedURL) {
          const url = String(node.data.tab.savedURL);
          if (!seen.has(url)) {
            seen.add(url);
            const title = String(node.title || node.data.tab.savedTitle || url);
            tabs.push({
              id: `arc-${tabs.length}`,
              title,
              url,
            });
          }
        }
        for (const key of Object.keys(node)) {
          walk(node[key]);
        }
      };
      walk(data);
      return tabs;
    } catch {
      return [];
    }
  }

  private fetchChromiumTabsFromStorage(
    appSupportFolder: string,
  ): Array<{ profile: string; tabs: Array<{ id: string; title: string; url: string }> }> {
    try {
      const basePath = path.join(os.homedir(), 'Library', 'Application Support', appSupportFolder);
      if (!fs.existsSync(basePath)) return [];
      const localStatePath = path.join(basePath, 'Local State');
      const profilesMap = new Map<string, string>();
      profilesMap.set('Default', 'Default');
      if (fs.existsSync(localStatePath)) {
        try {
          const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
          const infoCache = ls.profile?.info_cache || {};
          for (const [k, v] of Object.entries(infoCache)) {
            const pName = (v as any)?.name || k;
            profilesMap.set(k, pName);
          }
        } catch {}
      }

      const results: Array<{ profile: string; tabs: Array<{ id: string; title: string; url: string }> }> = [];

      for (const [dirName, profName] of profilesMap.entries()) {
        const profileDir = path.join(basePath, dirName);
        const sessionsDir = path.join(profileDir, 'Sessions');
        if (!fs.existsSync(sessionsDir)) continue;

        let files: Array<{ name: string; time: number }> = [];
        try {
          files = fs.readdirSync(sessionsDir)
            .filter((f) => f.startsWith('Tabs_') || f.startsWith('Session_'))
            .map((f) => ({ name: f, time: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        } catch {
          continue;
        }

        if (files.length === 0 || !files[0]) continue;
        const targetFile = path.join(sessionsDir, files[0].name);
        let buf: Buffer;
        try {
          buf = fs.readFileSync(targetFile);
        } catch {
          continue;
        }

        const tabs: Array<{ id: string; title: string; url: string }> = [];
        const seen = new Set<string>();
        let i = 0;
        while (i < buf.length - 8) {
          if (
            (buf[i] === 0x68 && buf[i + 1] === 0x74 && buf[i + 2] === 0x74 && buf[i + 3] === 0x70 && buf[i + 4] === 0x73 && buf[i + 5] === 0x3a && buf[i + 6] === 0x2f && buf[i + 7] === 0x2f) ||
            (buf[i] === 0x68 && buf[i + 1] === 0x74 && buf[i + 2] === 0x74 && buf[i + 3] === 0x70 && buf[i + 4] === 0x3a && buf[i + 5] === 0x2f && buf[i + 6] === 0x2f)
          ) {
            const start = i;
            while (i < buf.length && (buf[i] ?? 0) >= 0x21 && (buf[i] ?? 0) <= 0x7e) {
              i++;
            }
            const url = buf.subarray(start, i).toString('utf-8');
            if ((url.startsWith('http://') || url.startsWith('https://')) && !seen.has(url)) {
              try {
                const parsed = new URL(url);
                if (parsed.hostname) {
                  seen.add(url);
                  let title = parsed.hostname;
                  const parts = parsed.pathname.split('/').filter(Boolean);
                  const lastPart = parts.length > 0 ? parts[parts.length - 1] : undefined;
                  if (lastPart) {
                    title += ` / ${decodeURIComponent(lastPart).slice(0, 40)}`;
                  }
                  tabs.push({
                    id: `${appSupportFolder.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${dirName}-${tabs.length}`,
                    title,
                    url,
                  });
                }
              } catch {}
            }
          } else {
            i++;
          }
        }

        if (tabs.length > 0) {
          results.push({ profile: profName, tabs });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  private async getRunningApps(): Promise<ContextAppTarget[]> {
    if (this.runningAppProvider) {
      const apps = await this.runningAppProvider();
      return apps.map((a) => ({
        id: a.name.toLowerCase().replace(/\s+/g, '-'),
        name: a.name,
        windows: [{ id: `${a.name}-w1`, title: a.name }],
      }));
    }

    const script = `tell application "System Events" to get name of every process whose background only is false`;
    const raw = await this.appleScriptRunner(script).catch(() => '');
    if (raw && raw.trim()) {
      const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const browserNames = new Set(['Google Chrome', 'Arc', 'Brave Browser', 'Safari', 'Microsoft Edge']);
      return names
        .filter((name) => !browserNames.has(name))
        .map((name) => ({
          id: name.toLowerCase().replace(/\s+/g, '-'),
          name,
          windows: [{ id: `${name.toLowerCase()}-main`, title: name }],
        }));
    }

    try {
      const { stdout } = await execFileAsync('lsappinfo', ['visibleProcessList']);
      const matches = stdout.match(/"([^"]+)"/g);
      if (matches && matches.length > 0) {
        const names = matches.map((m) => m.replace(/"/g, '').replace(/_/g, ' '));
        const browserNames = new Set(['Google Chrome', 'Arc', 'Brave Browser', 'Safari', 'Microsoft Edge']);
        return names
          .filter((name) => !browserNames.has(name) && !name.startsWith('‎'))
          .map((name) => ({
            id: name.toLowerCase().replace(/\s+/g, '-'),
            name,
            windows: [{ id: `${name.toLowerCase()}-main`, title: name }],
          }));
      }
    } catch {}

    return [];
  }

  private async getFiles(): Promise<ContextFileTarget[]> {
    if (this.fileProvider) {
      return this.fileProvider();
    }

    const targets: ContextFileTarget[] = [];
    const dirsToScan = [
      path.join(os.homedir(), 'Downloads'),
      path.join(os.homedir(), 'Desktop'),
      process.cwd(),
    ];

    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const dirFiles: Array<{ name: string; isDir: boolean; path: string; mtime: number }> = [];
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
          const fullPath = path.join(dir, entry.name);
          let mtime = 0;
          try {
            mtime = fs.statSync(fullPath).mtimeMs;
          } catch {}
          dirFiles.push({
            name: entry.name,
            isDir: entry.isDirectory(),
            path: fullPath,
            mtime,
          });
        }
        dirFiles.sort((a, b) => b.mtime - a.mtime);
        for (const f of dirFiles.slice(0, 30)) {
          targets.push({
            id: `file-${Buffer.from(f.path).toString('base64url').slice(0, 16)}`,
            name: f.name,
            path: f.path,
            isDir: f.isDir,
          });
        }
      } catch {}
    }

    return targets;
  }

  async getHierarchy(): Promise<ContextHierarchy> {
    const browsers: ContextBrowserTarget[] = [];

    const chromeTabs = this.chromeTabProvider
      ? await this.chromeTabProvider()
      : (await this.fetchChromeTabsViaCdp()).concat(
          (await this.fetchBrowserTabsViaAppleScript('Google Chrome')).map((t, i) => ({
            ...t,
            profile: 'Personal',
            tabIndex: i,
          })),
        );

    const dedupedChromeTabs: ChromeTabItem[] = [];
    const seenChromeUrls = new Set<string>();
    for (const tab of chromeTabs) {
      if (!seenChromeUrls.has(tab.url)) {
        seenChromeUrls.add(tab.url);
        dedupedChromeTabs.push(tab);
      }
    }

    const chromeProfilesMap = new Map<string, ContextBrowserProfile>();
    for (const tab of dedupedChromeTabs) {
      const profileName = tab.profile || 'Default';
      if (!chromeProfilesMap.has(profileName)) {
        chromeProfilesMap.set(profileName, {
          id: profileName,
          name: profileName,
          tabs: [],
        });
      }
      chromeProfilesMap.get(profileName)!.tabs.push({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        tabIndex: tab.tabIndex,
      });
    }

    if (chromeProfilesMap.size === 0) {
      const storageProfiles = this.fetchChromiumTabsFromStorage(path.join('Google', 'Chrome'));
      for (const p of storageProfiles) {
        chromeProfilesMap.set(p.profile, {
          id: p.profile.toLowerCase().replace(/\s+/g, '-'),
          name: p.profile,
          tabs: p.tabs,
        });
      }
    }

    browsers.push({
      id: 'chrome',
      name: 'Google Chrome',
      profiles: Array.from(chromeProfilesMap.values()),
    });

    const otherBrowsers = [
      { id: 'arc', name: 'Arc', useName: false, folder: 'Arc' },
      { id: 'brave', name: 'Brave Browser', useName: false, folder: path.join('BraveSoftware', 'Brave-Browser') },
      { id: 'safari', name: 'Safari', useName: true, folder: '' },
      { id: 'edge', name: 'Microsoft Edge', useName: false, folder: 'Microsoft Edge' },
    ];

    for (const b of otherBrowsers) {
      let tabs = await this.fetchBrowserTabsViaAppleScript(b.name, b.useName);
      if (tabs.length === 0 && b.id === 'arc') {
        tabs = this.fetchArcTabsFromStorage();
      }
      if (tabs.length > 0) {
        browsers.push({
          id: b.id,
          name: b.name,
          profiles: [
            {
              id: 'default',
              name: 'Default',
              tabs,
            },
          ],
        });
      } else if (b.folder && b.id !== 'arc') {
        const storageProfiles = this.fetchChromiumTabsFromStorage(b.folder);
        if (storageProfiles.length > 0) {
          browsers.push({
            id: b.id,
            name: b.name,
            profiles: storageProfiles.map((p) => ({
              id: p.profile.toLowerCase().replace(/\s+/g, '-'),
              name: p.profile,
              tabs: p.tabs,
            })),
          });
        }
      }
    }

    const apps = await this.getRunningApps();
    const files = await this.getFiles();

    return {
      browsers,
      apps,
      files,
    };
  }

  async filterTargets(query: string): Promise<ContextHierarchy> {
    const hierarchy = await this.getHierarchy();
    const q = query.trim().toLowerCase();
    if (!q) return hierarchy;

    const parts = q.split('/').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const p0 = parts[0];
    const p1 = parts[1];

    const filteredBrowsers: ContextBrowserTarget[] = [];
    for (const b of hierarchy.browsers) {
      const isBrowserMatch =
        b.name.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        (p0 !== undefined && (b.name.toLowerCase().includes(p0) || b.id.toLowerCase().includes(p0)));
      const matchingProfiles: ContextBrowserProfile[] = [];
      for (const p of b.profiles) {
        const isProfileMatch = p.name.toLowerCase().includes(q) || (p1 !== undefined && p.name.toLowerCase().includes(p1));
        const matchingTabs = p.tabs.filter((t) => {
          if (parts.length > 1) {
            const subQ = parts.slice(1).join(' ');
            return t.title.toLowerCase().includes(subQ) || t.url.toLowerCase().includes(subQ);
          }
          return isBrowserMatch || isProfileMatch || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q);
        });
        if (matchingTabs.length > 0) {
          matchingProfiles.push({ ...p, tabs: matchingTabs });
        }
      }
      if (matchingProfiles.length > 0) {
        filteredBrowsers.push({ ...b, profiles: matchingProfiles });
      }
    }

    const filteredApps = hierarchy.apps.filter(
      (a) => a.name.toLowerCase().includes(q) || a.windows.some((w) => w.title.toLowerCase().includes(q)),
    );

    const filteredFiles = hierarchy.files.filter((f) => {
      if (parts.length > 1 && (p0 === 'downloads' || p0 === 'finder' || p0 === 'files')) {
        const subQ = parts.slice(1).join(' ');
        return f.name.toLowerCase().includes(subQ) || f.path.toLowerCase().includes(subQ);
      }
      return f.name.toLowerCase().includes(q) || (p0 !== undefined && (p0 === 'downloads' || p0 === 'finder') && f.path.toLowerCase().includes('downloads'));
    });

    return {
      browsers: filteredBrowsers,
      apps: filteredApps,
      files: filteredFiles,
    };
  }
}
