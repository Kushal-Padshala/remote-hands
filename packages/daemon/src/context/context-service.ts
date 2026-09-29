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
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
          targets.push({
            id: `file-${Buffer.from(path.join(dir, entry.name)).toString('base64url').slice(0, 16)}`,
            name: entry.name,
            path: path.join(dir, entry.name),
            isDir: entry.isDirectory(),
          });
          if (targets.length >= 60) break;
        }
      } catch {}
      if (targets.length >= 60) break;
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

    browsers.push({
      id: 'chrome',
      name: 'Google Chrome',
      profiles: Array.from(chromeProfilesMap.values()),
    });

    const otherBrowsers = [
      { id: 'arc', name: 'Arc', useName: false },
      { id: 'brave', name: 'Brave Browser', useName: false },
      { id: 'safari', name: 'Safari', useName: true },
      { id: 'edge', name: 'Microsoft Edge', useName: false },
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

    const filteredBrowsers: ContextBrowserTarget[] = [];
    for (const b of hierarchy.browsers) {
      const matchingProfiles: ContextBrowserProfile[] = [];
      for (const p of b.profiles) {
        const matchingTabs = p.tabs.filter(
          (t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q),
        );
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

    const filteredFiles = hierarchy.files.filter((f) => f.name.toLowerCase().includes(q));

    return {
      browsers: filteredBrowsers,
      apps: filteredApps,
      files: filteredFiles,
    };
  }
}
