import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
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
  const locked = await withAgyLock(fs, DEFAULT_LOCK_WAIT_MS, () => editAgyMcpRule(fs, agyMcpRule(serverName), true));
  if (!locked.ok) return { updated: [], alreadyPresent: [], skipped: [{ path: 'agy settings', reason: LOCK_BUSY }] };
  const { notPresent: _notPresent, ...res } = locked.value;
  return res;
}

/** Removes exactly `mcp(<serverName>/*)` from `permissions.allow`; everything else stays. */
export async function removeAgyMcpPermission(
  fs: FileSystemAdapter = defaultFileSystem,
  serverName = 'rh-computer',
): Promise<{ updated: string[]; notPresent: string[]; skipped: { path: string; reason: string }[] }> {
  const locked = await withAgyLock(fs, DEFAULT_LOCK_WAIT_MS, () => editAgyMcpRule(fs, agyMcpRule(serverName), false));
  if (!locked.ok) return { updated: [], notPresent: [], skipped: [{ path: 'agy settings', reason: LOCK_BUSY }] };
  const { updated, notPresent, skipped } = locked.value;
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

const SETTINGS_BACKUP_SUFFIX = '.bak-rh';
const LOCK_BUSY = 'another Remote Hands process is changing the agy settings right now; try again in a moment';

function remoteHandsHome(): string {
  return path.join(os.homedir(), '.remote-hands');
}

const consentPath = (): string => path.join(remoteHandsHome(), 'agy-consent.json');
const undoPath = (): string => path.join(remoteHandsHome(), 'agy-undo.json');
const lockPath = (): string => path.join(remoteHandsHome(), 'agy-settings.lock');

/** What setup is about to change in the person's agy settings, in plain words (shown before anything is written). */
export function agyPermissionDisclosure(): string[] {
  return [
    'To work without asking you about every step, Remote Hands changes your agy settings:',
    '  - agy may read and write files and run commands without asking each time',
    '    (permissions.defaultAction = allow, disableAllPrompts = true)',
    '  - your home folder is marked as a trusted workspace',
    '  - this applies to agy itself and to the Antigravity IDE, not only to Remote Hands',
    'Your settings files are backed up first (settings.json.bak-rh) and the exact changes are recorded,',
    'so "rh permissions revert" puts them back.',
  ];
}

export type AgyConsentState = 'granted' | 'revoked' | 'none';

export async function readAgyConsent(fs: FileSystemAdapter = defaultFileSystem): Promise<AgyConsentState> {
  try {
    if (!(await fs.exists(consentPath()))) return 'none';
  } catch {
    return 'revoked';
  }
  try {
    const raw = await fs.readFile(consentPath());
    // an empty file records no choice at all
    if (raw.trim() === '') return 'none';
    const parsed = JSON.parse(raw);
    return parsed?.state === 'granted' || parsed?.state === 'revoked' ? parsed.state : 'revoked';
  } catch {
    // a record that exists but cannot be read must never read as "no objection": background callers stay out until setup asks again
    return 'revoked';
  }
}

/** Consent and undo records: written to a temporary file and renamed, so a crash never leaves half a record. */
async function writeStateFile(fs: FileSystemAdapter, file: string, content: string): Promise<void> {
  if (fs !== defaultFileSystem) return fs.writeFile(file, content);
  nodeFs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  nodeFs.writeFileSync(tmp, content, 'utf-8');
  nodeFs.renameSync(tmp, file);
}

/** True when the note was written. A "revoked" that is not durable would let a background caller undo a revert, so callers check. */
async function writeAgyConsent(fs: FileSystemAdapter, state: 'granted' | 'revoked'): Promise<boolean> {
  try {
    await writeStateFile(fs, consentPath(), JSON.stringify({ state, at: new Date().toISOString() }, null, 2));
    return true;
  } catch {
    return false;
  }
}

interface UndoEntry {
  defaultAction: { had: boolean; value?: unknown };
  disableAllPrompts: { had: boolean; value?: unknown };
  addedAllow: string[];
  addedWorkspaces: string[];
  /** Which containers did not exist before, so a revert removes them instead of leaving them empty. */
  created?: { permissions: boolean; allow: boolean; trustedWorkspaces: boolean } | undefined;
}

type UndoManifest = { version: 1; files: Record<string, UndoEntry> };

async function readUndo(fs: FileSystemAdapter): Promise<{ manifest: UndoManifest; error?: string }> {
  const empty: UndoManifest = { version: 1, files: {} };
  try {
    if (!(await fs.exists(undoPath()))) return { manifest: empty };
  } catch (err) {
    return { manifest: empty, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const raw = await fs.readFile(undoPath());
    // an empty file holds nothing to lose (a crash before anything was written)
    if (raw.trim() === '') return { manifest: empty };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') return { manifest: parsed as UndoManifest };
    return { manifest: empty, error: 'it is not a Remote Hands record' };
  } catch (err) {
    return { manifest: empty, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A lock whose owner file is missing or unreadable is only abandoned once it is this old (a live owner writes it at once). */
const LOCK_ORPHAN_MS = 10_000;
/** The critical sections take milliseconds: a lock this old whose owner still "lives" belongs to a reused process id. */
const LOCK_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;

function processLives(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readLockOwner(lock: string): { pid: number; token: string } | undefined {
  try {
    const parsed = JSON.parse(nodeFs.readFileSync(path.join(lock, 'owner.json'), 'utf-8'));
    return typeof parsed?.pid === 'number' && typeof parsed?.token === 'string' ? { pid: parsed.pid, token: parsed.token } : undefined;
  } catch {
    return undefined;
  }
}

/** Abandoned means: its owner process is gone, or it is far older than any real use. Age alone, for a live owner, is not enough. */
function lockIsAbandoned(lock: string): { abandoned: boolean; token?: string } {
  let age = 0;
  try {
    age = Date.now() - nodeFs.statSync(lock).mtimeMs;
  } catch {
    return { abandoned: false };
  }
  const owner = readLockOwner(lock);
  if (!owner) return { abandoned: age > LOCK_ORPHAN_MS };
  if (!processLives(owner.pid)) return { abandoned: true, token: owner.token };
  return { abandoned: age > LOCK_MAX_AGE_MS, token: owner.token };
}

/** Moves an abandoned lock aside, but only if it is still the very one that was judged (not a newer owner's). */
function takeOverLock(lock: string, judgedToken: string | undefined): boolean {
  if (readLockOwner(lock)?.token !== judgedToken) return true;
  const aside = `${lock}.abandoned-${randomUUID()}`;
  try {
    nodeFs.renameSync(lock, aside);
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
  try {
    nodeFs.rmSync(aside, { recursive: true, force: true });
  } catch {
    // left behind under another name: harmless
  }
  return true;
}

/**
 * Changing the settings, recording the change, and reverting it must not interleave between processes (the HUD service, a
 * terminal, doctor): one could re-apply what the other just removed. The lock is a folder, which the OS creates atomically,
 * holding the owner's process id and a token. Only a lock whose owner is gone is taken over, and only its owner removes it.
 * Only the real file system is locked (tests use their own).
 */
async function withAgyLock<T>(fs: FileSystemAdapter, waitMs: number, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  if (fs !== defaultFileSystem) return { ok: true, value: await fn() };
  const lock = lockPath();
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (let takeovers = 0; ; ) {
    try {
      nodeFs.mkdirSync(path.dirname(lock), { recursive: true });
      nodeFs.mkdirSync(lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return { ok: false };
      const judged = lockIsAbandoned(lock);
      if (judged.abandoned) {
        // a failure to remove it (permissions) or too many rounds of it ends the attempt: no endless retrying
        if (!takeOverLock(lock, judged.token) || (takeovers += 1) > 5) return { ok: false };
        continue;
      }
      if (Date.now() >= deadline) return { ok: false };
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      nodeFs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), 'utf-8');
    } catch {
      try {
        nodeFs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // see below: an ownerless lock is taken over after a few seconds
      }
      return { ok: false };
    }
    break;
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    // only the owner removes it: a lock that was taken over and is now someone else's stays
    if (readLockOwner(lock)?.token === token) {
      try {
        nodeFs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // taken over later
      }
    }
  }
}

export interface RevertAgyResult {
  restored: string[];
  skipped: { path: string; reason: string }[];
  /** Set when the revert could not be made lasting (nothing is claimed as done in that case). */
  error?: string | undefined;
}

/**
 * Puts the agy settings back the way they were before Remote Hands changed them: only what was added is taken out, and
 * the two permission switches return to their earlier values. "Revoked" is written first and must stick: later calls by
 * background services (the HUD, doctor) then leave the settings alone until someone sets them up again on purpose.
 */
export async function revertAgyPermissions(
  fs: FileSystemAdapter = defaultFileSystem,
  options: { lockWaitMs?: number } = {},
): Promise<RevertAgyResult> {
  const locked = await withAgyLock<RevertAgyResult>(fs, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, async () => {
    const record = await readUndo(fs);
    if (record.error) {
      return { restored: [], skipped: [], error: `the record of what Remote Hands changed (${undoPath()}) cannot be read (${record.error}), so nothing was changed` };
    }
    if (!(await writeAgyConsent(fs, 'revoked'))) {
      return { restored: [], skipped: [], error: 'could not record that the settings were reverted (is ~/.remote-hands writable?), so nothing was changed' };
    }
    const undo = record.manifest;
    const restored: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const remaining: Record<string, UndoEntry> = {};
    for (const [file, entry] of Object.entries(undo.files)) {
      try {
        if (!(await fs.exists(file))) continue;
        const settings = JSON.parse(await fs.readFile(file));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not a JSON object');
        const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
        if (entry.defaultAction.had) permissions.defaultAction = entry.defaultAction.value;
        else delete permissions.defaultAction;
        if (entry.disableAllPrompts.had) permissions.disableAllPrompts = entry.disableAllPrompts.value;
        else delete permissions.disableAllPrompts;
        if (Array.isArray(permissions.allow)) {
          permissions.allow = permissions.allow.filter((r: unknown) => !entry.addedAllow.includes(r as string));
        }
        settings.permissions = permissions;
        if (Array.isArray(settings.trustedWorkspaces)) {
          settings.trustedWorkspaces = settings.trustedWorkspaces.filter((w: unknown) => !entry.addedWorkspaces.includes(w as string));
        }
        // what Remote Hands created from nothing goes away entirely instead of staying behind empty
        if (entry.created?.allow && Array.isArray(permissions.allow) && permissions.allow.length === 0) delete permissions.allow;
        if (entry.created?.trustedWorkspaces && Array.isArray(settings.trustedWorkspaces) && settings.trustedWorkspaces.length === 0) delete settings.trustedWorkspaces;
        if (entry.created?.permissions && Object.keys(permissions).length === 0) delete settings.permissions;
        await fs.writeFile(file, JSON.stringify(settings, null, 2));
        restored.push(file);
      } catch (err) {
        skipped.push({ path: file, reason: err instanceof Error ? err.message : String(err) });
        remaining[file] = entry;
      }
    }
    try {
      await writeStateFile(fs, undoPath(), JSON.stringify({ version: 1, files: remaining }, null, 2));
    } catch (err) {
      return { restored, skipped, error: `the settings were restored but the record of them could not be updated (${err instanceof Error ? err.message : String(err)})` };
    }
    return { restored, skipped };
  });
  if (!locked.ok) {
    return { restored: [], skipped: [], error: LOCK_BUSY };
  }
  return locked.value;
}

export interface EnsureAgyPermissionsOptions {
  /**
   * The person asked for this (setup, `rh permissions fix`, `rh hud install`). Without it, a background caller does
   * nothing after the person reverted the settings.
   */
  explicit?: boolean | undefined;
  /** How long to wait for another process that is changing the settings (default 5 s; tests shorten it). */
  lockWaitMs?: number | undefined;
}

export async function ensureAgyPermissions(
  fs: FileSystemAdapter = defaultFileSystem,
  workspacePath?: string,
  options: EnsureAgyPermissionsOptions = {},
): Promise<boolean> {
  try {
    const locked = await withAgyLock(fs, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, async () => {
      // checked under the lock, so a revert that finished a moment ago is never undone
      if (!options.explicit && (await readAgyConsent(fs)) === 'revoked') return false;

      const settingsPaths = [
        path.join(os.homedir(), '.gemini/antigravity-cli/settings.json'),
        path.join(os.homedir(), '.gemini/settings.json'),
        path.join(os.homedir(), '.gemini/antigravity/settings.json'),
        path.join(os.homedir(), '.gemini/antigravity-ide/settings.json'),
      ];

      const record = await readUndo(fs);
      // an undo record that exists but cannot be read must not be replaced: nothing is changed until it is dealt with
      if (record.error) return false;
      const undo = record.manifest;
      const plans: { settingsPath: string; settingsObj: any; originalRaw: string | null; isFirstChange: boolean }[] = [];

      for (const settingsPath of settingsPaths) {
        const parentDir = path.dirname(settingsPath);
        const parentExists = await fs.exists(parentDir);
        const fileExists = await fs.exists(settingsPath);

        if (!parentExists && !fileExists && settingsPath !== settingsPaths[0]) {
          continue;
        }

        let settingsObj: any = {};
        let originalRaw: string | null = null;
        if (fileExists) {
          try {
            originalRaw = await fs.readFile(settingsPath);
            settingsObj = JSON.parse(originalRaw);
          } catch {}
        }

        const created = {
          permissions: !settingsObj.permissions || typeof settingsObj.permissions !== 'object',
          allow: !Array.isArray(settingsObj.permissions?.allow),
          trustedWorkspaces: !Array.isArray(settingsObj.trustedWorkspaces),
        };
        settingsObj.permissions = settingsObj.permissions || {};
        const permissions = settingsObj.permissions;
        const existingAllow: string[] = Array.isArray(permissions.allow) ? permissions.allow : [];
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

        // what is new here, recorded (once) so it can be undone exactly
        const previous = undo.files[settingsPath];
        const entry: UndoEntry = previous ?? {
          defaultAction: 'defaultAction' in permissions ? { had: true, value: permissions.defaultAction } : { had: false },
          disableAllPrompts: 'disableAllPrompts' in permissions ? { had: true, value: permissions.disableAllPrompts } : { had: false },
          addedAllow: [],
          addedWorkspaces: [],
          created,
        };
        for (const rule of STANDARD_AGY_PERMISSIONS) {
          if (!existingAllow.includes(rule) && !entry.addedAllow.includes(rule)) entry.addedAllow.push(rule);
        }
        for (const ws of workspacesToAdd) {
          if (!existingWorkspaces.includes(ws) && !entry.addedWorkspaces.includes(ws)) entry.addedWorkspaces.push(ws);
        }
        undo.files[settingsPath] = entry;

        permissions.defaultAction = 'allow';
        permissions.disableAllPrompts = true;
        permissions.allow = Array.from(new Set([...existingAllow, ...STANDARD_AGY_PERMISSIONS]));
        settingsObj.trustedWorkspaces = Array.from(new Set([...existingWorkspaces, ...workspacesToAdd]));
        plans.push({ settingsPath, settingsObj, originalRaw, isFirstChange: !previous });
      }

      // The record of what will change is written BEFORE anything changes: with no way to undo it, nothing is touched.
      try {
        await writeStateFile(fs, undoPath(), JSON.stringify(undo, null, 2));
      } catch {
        return false;
      }
      // An accepted grant is recorded before the settings change; if it cannot be recorded, nothing changes.
      if (options.explicit && !(await writeAgyConsent(fs, 'granted'))) return false;

      let anySucceeded = false;
      let failedAny = false;
      for (const plan of plans) {
        try {
          // a one-time copy of the file as it was, before the first change
          if (plan.originalRaw !== null && plan.originalRaw.trim() !== '' && plan.isFirstChange) {
            const backup = `${plan.settingsPath}${SETTINGS_BACKUP_SUFFIX}`;
            if (!(await fs.exists(backup))) await fs.writeFile(backup, plan.originalRaw);
          }
          await fs.writeFile(plan.settingsPath, JSON.stringify(plan.settingsObj, null, 2));
          anySucceeded = true;
        } catch {
          // a file that could not be written has nothing to undo: forget its record
          if (plan.isFirstChange) {
            delete undo.files[plan.settingsPath];
            failedAny = true;
          }
        }
      }

      if (failedAny) {
        try {
          await writeStateFile(fs, undoPath(), JSON.stringify(undo, null, 2));
        } catch {
          // the earlier, fuller record stays: undoing a file that never changed removes nothing that was not added
        }
      }
      return anySucceeded;
    });
    if (!locked.ok) return false;

    try {
      await ensureRemoteHandsOperatorSkill(fs, workspacePath);
    } catch {}

    return locked.value;
  } catch {
    return false;
  }
}
