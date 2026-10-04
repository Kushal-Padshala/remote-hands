import * as os from 'node:os';
import * as path from 'node:path';
import type { FileSystemAdapter } from '../cloudflare/project.js';
import { defaultFileSystem } from '../cloudflare/project.js';
import { ensureRemoteHandsOperatorSkill } from './operator-skill.js';

export const STANDARD_AGY_PERMISSIONS = [
  'read_file',
  'read_file(*)',
  'write_file',
  'write_file(*)',
  'edit_file',
  'edit_file(*)',
  'list_dir',
  'list_dir(*)',
  'view_file',
  'view_file(*)',
  'replace_file_content',
  'replace_file_content(*)',
  'multi_replace_file_content',
  'multi_replace_file_content(*)',
  'grep_search',
  'grep_search(*)',
  'run_command',
  'run_command(*)',
  'command(*)',
  'command(python3)',
  'command(python)',
  'command(pip)',
  'command(pip3)',
  'command(uv)',
  'command(uvx)',
  'command(bash)',
  'command(sh)',
  'command(zsh)',
  'command(node)',
  'command(npm)',
  'command(npm install)',
  'command(npm run)',
  'command(npm test)',
  'command(npx)',
  'command(pnpm)',
  'command(yarn)',
  'command(bun)',
  'command(git)',
  'command(ls)',
  'command(cat)',
  'command(echo)',
  'command(find)',
  'command(grep)',
  'command(which)',
  'command(defaults)',
  'command(mkdir)',
  'command(cp)',
  'command(mv)',
  'command(rm)',
  'command(touch)',
  'command(head)',
  'command(tail)',
  'command(curl)',
  'command(tar)',
  'command(unzip)',
  'command(zip)',
  'command(sed)',
  'command(awk)',
  'command(ps)',
  'command(lsof)',
  'command(open)',
  'command(cd)',
  'command(pwd)',
  'command(chmod)',
  'command(chown)',
  'command(export)',
  'command(env)',
  'command(source)',
  'command(brew)',
  'command(apt)',
  'command(apt-get)',
  'command(pod)',
  'command(xcodebuild)',
  'command(cargo)',
  'command(go)',
  'command(make)',
  'command(docker)',
  'command(rh)',
  'command(rh *)',
  'command(rh browser)',
  'command(rh browser *)',
  'command(rh desktop)',
  'command(rh desktop *)',
  'command(rh guide)',
  'command(rh guide *)',
  'command(rh approve)',
  'command(rh approve *)',
  'command(browser-harness)',
  'command(browser-harness *)',
  'command(screencapture)',
  'command(osascript)',
  'command(swift)',
  'command(swiftc)',
  // Headless agy auto-denies MCP tool calls unless allowed per server; never use mcp(*).
  'mcp(rh-computer/*)',
  '*',
] as const;

/** The allow rule that lets headless agy call every tool of one MCP server. */
export function agyMcpRule(serverName: string): string {
  return `mcp(${serverName}/*)`;
}

/** agy settings files the MCP rule is kept in: the CLI one (created if missing) and the IDE one. */
function agyMcpSettingsPaths(): { path: string; create: boolean }[] {
  return [
    { path: path.join(os.homedir(), '.gemini/antigravity-cli/settings.json'), create: true },
    { path: path.join(os.homedir(), '.gemini/antigravity-ide/settings.json'), create: false },
  ];
}

export interface AgyMcpPermissionResult {
  updated: string[];
  alreadyPresent: string[];
  /** Files left untouched because they could not be read, parsed or merged safely. */
  skipped: { path: string; reason: string }[];
}

const MCP_BACKUP_SUFFIX = '.bak-rh-mcp';

/**
 * Adds (`add`) or removes the exact rule from `permissions.allow` in each agy settings
 * file. Additive and minimal: other keys, entries and their order are kept, a file that
 * fails to parse (or has a non-object `permissions` / non-list `allow`) is reported and
 * skipped, and a one-time `settings.json.bak-rh-mcp` backup is written before the first
 * change to an existing file.
 */
async function editAgyMcpRule(
  fs: FileSystemAdapter,
  rule: string,
  add: boolean,
): Promise<AgyMcpPermissionResult & { notPresent: string[] }> {
  const result = { updated: [] as string[], alreadyPresent: [] as string[], notPresent: [] as string[], skipped: [] as { path: string; reason: string }[] };
  for (const { path: file, create } of agyMcpSettingsPaths()) {
    let raw: string | null = null;
    try {
      if (await fs.exists(file)) raw = await fs.readFile(file);
    } catch (err) {
      result.skipped.push({ path: file, reason: `could not be read (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    if (raw === null && !(add && create)) continue;
    let settings: Record<string, unknown> = {};
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        result.skipped.push({ path: file, reason: 'not valid JSON; left unchanged' });
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        result.skipped.push({ path: file, reason: 'not a JSON object; left unchanged' });
        continue;
      }
      settings = parsed as Record<string, unknown>;
    }
    const perms = settings.permissions;
    if (perms !== undefined && (!perms || typeof perms !== 'object' || Array.isArray(perms))) {
      result.skipped.push({ path: file, reason: 'permissions is not an object; left unchanged' });
      continue;
    }
    const permissions = (perms ?? {}) as Record<string, unknown>;
    const allow = permissions.allow;
    if (allow !== undefined && !Array.isArray(allow)) {
      result.skipped.push({ path: file, reason: 'permissions.allow is not a list; left unchanged' });
      continue;
    }
    const list = (allow ?? []) as unknown[];
    const present = list.includes(rule);
    if (add && present) {
      result.alreadyPresent.push(file);
      continue;
    }
    if (!add && !present) {
      result.notPresent.push(file);
      continue;
    }
    permissions.allow = add ? [...list, rule] : list.filter((r) => r !== rule);
    if (perms === undefined) settings.permissions = permissions;
    try {
      const backup = `${file}${MCP_BACKUP_SUFFIX}`;
      if (raw !== null && !(await fs.exists(backup))) await fs.writeFile(backup, raw);
      await fs.writeFile(file, JSON.stringify(settings, null, 2));
      result.updated.push(file);
    } catch (err) {
      result.skipped.push({ path: file, reason: `could not be written (${err instanceof Error ? err.message : String(err)})` });
    }
  }
  return result;
}

/**
 * Ensures headless agy may call the tools of MCP server `serverName` by adding
 * `mcp(<serverName>/*)` to `permissions.allow` (never `mcp(*)`). Idempotent.
 */
export async function ensureAgyMcpPermission(
  fs: FileSystemAdapter = defaultFileSystem,
  serverName = 'rh-computer',
): Promise<AgyMcpPermissionResult> {
  const { notPresent: _notPresent, ...res } = await editAgyMcpRule(fs, agyMcpRule(serverName), true);
  return res;
}

/** Removes exactly `mcp(<serverName>/*)` from `permissions.allow`; everything else stays. */
export async function removeAgyMcpPermission(
  fs: FileSystemAdapter = defaultFileSystem,
  serverName = 'rh-computer',
): Promise<{ updated: string[]; notPresent: string[]; skipped: { path: string; reason: string }[] }> {
  const { updated, notPresent, skipped } = await editAgyMcpRule(fs, agyMcpRule(serverName), false);
  return { updated, notPresent, skipped };
}

export async function checkAgyPermissions(
  fs: FileSystemAdapter = defaultFileSystem,
  workspacePath?: string,
): Promise<boolean> {
  try {
    const settingsPath = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
    if (!(await fs.exists(settingsPath))) {
      return false;
    }
    const raw = await fs.readFile(settingsPath);
    const parsed = JSON.parse(raw);
    const allows = new Set(Array.isArray(parsed?.permissions?.allow) ? parsed.permissions.allow : []);
    if (!allows.has('read_file')) {
      return false;
    }
    if (workspacePath) {
      const trusted = new Set(Array.isArray(parsed?.trustedWorkspaces) ? parsed.trustedWorkspaces : []);
      if (!trusted.has(path.resolve(workspacePath))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function ensureAgyPermissions(
  fs: FileSystemAdapter = defaultFileSystem,
  workspacePath?: string,
): Promise<boolean> {
  try {
    const settingsPaths = [
      path.join(os.homedir(), '.gemini/antigravity-cli/settings.json'),
      path.join(os.homedir(), '.gemini/settings.json'),
      path.join(os.homedir(), '.gemini/antigravity/settings.json'),
      path.join(os.homedir(), '.gemini/antigravity-ide/settings.json'),
    ];

    let anySucceeded = false;

    for (const settingsPath of settingsPaths) {
      const parentDir = path.dirname(settingsPath);
      const parentExists = await fs.exists(parentDir);
      const fileExists = await fs.exists(settingsPath);

      if (!parentExists && !fileExists && settingsPath !== settingsPaths[0]) {
        continue;
      }

      let settingsObj: any = {};
      if (fileExists) {
        try {
          settingsObj = JSON.parse(await fs.readFile(settingsPath));
        } catch {}
      }

      settingsObj.permissions = settingsObj.permissions || {};
      settingsObj.permissions.defaultAction = 'allow';
      settingsObj.permissions.disableAllPrompts = true;
      const existingAllow: string[] = Array.isArray(settingsObj.permissions.allow)
        ? settingsObj.permissions.allow
        : [];
      const mergedAllow = Array.from(new Set([...existingAllow, ...STANDARD_AGY_PERMISSIONS]));
      settingsObj.permissions.allow = mergedAllow;

      const existingWorkspaces: string[] = Array.isArray(settingsObj.trustedWorkspaces)
        ? settingsObj.trustedWorkspaces
        : [];
      const workspacesToAdd = [
        os.homedir(),
        process.cwd(),
        path.resolve(os.homedir(), '..'),
        '/Users',
      ];
      if (workspacePath) {
        workspacesToAdd.push(path.resolve(workspacePath));
      }
      const mergedWorkspaces = Array.from(new Set([...existingWorkspaces, ...workspacesToAdd]));
      settingsObj.trustedWorkspaces = mergedWorkspaces;

      try {
        await fs.writeFile(settingsPath, JSON.stringify(settingsObj, null, 2));
        anySucceeded = true;
      } catch {}
    }

    try {
      await ensureRemoteHandsOperatorSkill(fs, workspacePath);
    } catch {}

    return anySucceeded;
  } catch {
    return false;
  }
}

