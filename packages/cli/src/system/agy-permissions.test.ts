import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  STANDARD_AGY_PERMISSIONS,
  checkAgyPermissions,
  ensureAgyMcpPermission,
  ensureAgyPermissions,
  readAgyConsent,
  removeAgyMcpPermission,
  revertAgyPermissions,
} from './agy-permissions.js';
import { defaultFileSystem, type FileSystemAdapter } from '../cloudflare/project.js';

/** In-memory fs: never touches the real ~/.gemini. */
function memoryFs(initial: Record<string, string> = {}): { fs: FileSystemAdapter; files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    fs: {
      readFile: async (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p]!;
      },
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => p in files,
    },
  };
}

const CLI_SETTINGS = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
const IDE_SETTINGS = path.join(os.homedir(), '.gemini/antigravity-ide/settings.json');
const RULE = 'mcp(rh-computer/*)';

describe('agy MCP permission for rh-computer', () => {
  it('rh permissions fix includes the per-server MCP rule and never mcp(*)', () => {
    expect(STANDARD_AGY_PERMISSIONS).toContain(RULE);
    expect(STANDARD_AGY_PERMISSIONS).not.toContain('mcp(*)');
  });

  it('appends the rule, preserving every other key, entry and their order, with a one-time backup', async () => {
    const original = JSON.stringify({
      model: 'm',
      permissions: { defaultAction: 'ask', allow: ['read_file', 'command(git)'], deny: ['x'] },
      trustedWorkspaces: ['/a'],
      zeta: 1,
    });
    const { fs, files } = memoryFs({ [CLI_SETTINGS]: original });
    const res = await ensureAgyMcpPermission(fs);
    expect(res).toMatchObject({ updated: [CLI_SETTINGS], alreadyPresent: [] });
    const parsed = JSON.parse(files[CLI_SETTINGS]!);
    expect(Object.keys(parsed)).toEqual(['model', 'permissions', 'trustedWorkspaces', 'zeta']);
    expect(Object.keys(parsed.permissions)).toEqual(['defaultAction', 'allow', 'deny']);
    expect(parsed.permissions.allow).toEqual(['read_file', 'command(git)', RULE]);
    expect(parsed.permissions.defaultAction).toBe('ask');
    expect(parsed.permissions.deny).toEqual(['x']);
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBe(original);
    expect(files[IDE_SETTINGS]).toBeUndefined();
  });

  it('is idempotent and keeps the first backup', async () => {
    const { fs, files } = memoryFs({ [CLI_SETTINGS]: JSON.stringify({ permissions: { allow: ['a'] } }) });
    await ensureAgyMcpPermission(fs);
    const once = files[CLI_SETTINGS];
    const backup = files[`${CLI_SETTINGS}.bak-rh-mcp`];
    const res = await ensureAgyMcpPermission(fs);
    expect(res).toMatchObject({ updated: [], alreadyPresent: [CLI_SETTINGS] });
    expect(files[CLI_SETTINGS]).toBe(once);
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBe(backup);
    expect(JSON.parse(files[CLI_SETTINGS]!).permissions.allow.filter((r: string) => r === RULE)).toHaveLength(1);
  });

  it('does not overwrite an existing backup', async () => {
    const { fs, files } = memoryFs({
      [CLI_SETTINGS]: JSON.stringify({ permissions: { allow: [] } }),
      [`${CLI_SETTINGS}.bak-rh-mcp`]: 'older backup',
    });
    await ensureAgyMcpPermission(fs);
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBe('older backup');
  });

  it('creates permissions.allow when missing and updates the ide variant only if it exists', async () => {
    const { fs, files } = memoryFs({
      [CLI_SETTINGS]: JSON.stringify({ model: 'm' }),
      [IDE_SETTINGS]: JSON.stringify({ permissions: { defaultAction: 'allow' } }),
    });
    const res = await ensureAgyMcpPermission(fs);
    expect(res.updated).toEqual([CLI_SETTINGS, IDE_SETTINGS]);
    expect(JSON.parse(files[CLI_SETTINGS]!)).toEqual({ model: 'm', permissions: { allow: [RULE] } });
    expect(JSON.parse(files[IDE_SETTINGS]!)).toEqual({ permissions: { defaultAction: 'allow', allow: [RULE] } });
  });

  it('creates the cli settings file when it does not exist', async () => {
    const { fs, files } = memoryFs();
    const res = await ensureAgyMcpPermission(fs);
    expect(res.updated).toEqual([CLI_SETTINGS]);
    expect(JSON.parse(files[CLI_SETTINGS]!)).toEqual({ permissions: { allow: [RULE] } });
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBeUndefined();
  });

  it('reports and skips a settings file that fails to parse, leaving it untouched', async () => {
    const { fs, files } = memoryFs({ [CLI_SETTINGS]: '{ not json', [IDE_SETTINGS]: JSON.stringify({}) });
    const res = await ensureAgyMcpPermission(fs);
    expect(files[CLI_SETTINGS]).toBe('{ not json');
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBeUndefined();
    expect(res.updated).toEqual([IDE_SETTINGS]);
    expect(res.skipped).toEqual([{ path: CLI_SETTINGS, reason: expect.stringContaining('not valid JSON') }]);
  });

  it('skips a file whose permissions.allow is not a list instead of clobbering it', async () => {
    const raw = JSON.stringify({ permissions: { allow: 'everything' } });
    const { fs, files } = memoryFs({ [CLI_SETTINGS]: raw });
    const res = await ensureAgyMcpPermission(fs);
    expect(files[CLI_SETTINGS]).toBe(raw);
    expect(res.updated).toEqual([]);
    expect(res.skipped).toHaveLength(1);
  });

  it('remove deletes only its exact rule and leaves everything else', async () => {
    const { fs, files } = memoryFs({
      [CLI_SETTINGS]: JSON.stringify({ a: 1, permissions: { allow: ['x', RULE, 'mcp(other/*)', 'mcp(rh-computer/click)', 'y'] } }),
    });
    const res = await removeAgyMcpPermission(fs);
    expect(res.updated).toEqual([CLI_SETTINGS]);
    expect(JSON.parse(files[CLI_SETTINGS]!)).toEqual({ a: 1, permissions: { allow: ['x', 'mcp(other/*)', 'mcp(rh-computer/click)', 'y'] } });
    const again = await removeAgyMcpPermission(fs);
    expect(again.updated).toEqual([]);
  });

  it('remove never creates a settings file and skips invalid JSON', async () => {
    const { fs, files } = memoryFs({ [IDE_SETTINGS]: 'nope' });
    const res = await removeAgyMcpPermission(fs);
    expect(res.updated).toEqual([]);
    expect(files[CLI_SETTINGS]).toBeUndefined();
    expect(files[IDE_SETTINGS]).toBe('nope');
    expect(res.skipped).toHaveLength(1);
  });
});

describe('AGY Headless Permissions', () => {
  it('defines standard permissions including file tools and commands', () => {
    expect(STANDARD_AGY_PERMISSIONS).toContain('read_file');
    expect(STANDARD_AGY_PERMISSIONS).toContain('read_file(*)');
    expect(STANDARD_AGY_PERMISSIONS).toContain('write_file');
    expect(STANDARD_AGY_PERMISSIONS).toContain('edit_file');
    expect(STANDARD_AGY_PERMISSIONS).toContain('command(python3)');
    expect(STANDARD_AGY_PERMISSIONS).toContain('command(git)');
    expect(STANDARD_AGY_PERMISSIONS).toContain('command(npm)');
    expect(STANDARD_AGY_PERMISSIONS).toContain('command(curl)');
  });

  it('reports false when settings file does not exist', async () => {
    const mockFs: FileSystemAdapter = {
      readFile: async () => '',
      writeFile: async () => {},
      exists: async () => false,
    };

    const ok = await checkAgyPermissions(mockFs);
    expect(ok).toBe(false);
  });

  it('creates new settings.json with full permissions and trusted workspaces', async () => {
    const files: Record<string, string> = {};
    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => Boolean(files[p]),
    };

    const targetWorkspace = '/workspace/demo';
    const success = await ensureAgyPermissions(mockFs, targetWorkspace);
    expect(success).toBe(true);

    const settingsPath = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
    expect(files[settingsPath]).toBeDefined();

    const parsed = JSON.parse(files[settingsPath]!);
    expect(parsed.permissions.allow).toContain('read_file');
    expect(parsed.permissions.allow).toContain('command(python3)');
    expect(parsed.trustedWorkspaces).toContain(os.homedir());
    expect(parsed.trustedWorkspaces).toContain(process.cwd());
    expect(parsed.trustedWorkspaces).toContain(path.resolve(targetWorkspace));

    const check = await checkAgyPermissions(mockFs, targetWorkspace);
    expect(check).toBe(true);
  });

  it('preserves existing settings and merges permissions without duplicates', async () => {
    const settingsPath = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
    const existingConfig = {
      model: 'Custom-Model',
      colorScheme: 'dark',
      permissions: {
        allow: ['command(custom-tool)', 'read_file'],
      },
      trustedWorkspaces: ['/existing/trusted/path'],
    };

    const files: Record<string, string> = {
      [settingsPath]: JSON.stringify(existingConfig),
    };

    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => Boolean(files[p]),
    };

    const success = await ensureAgyPermissions(mockFs, '/new/workspace');
    expect(success).toBe(true);

    const parsed = JSON.parse(files[settingsPath]!);
    expect(parsed.model).toBe('Custom-Model');
    expect(parsed.colorScheme).toBe('dark');
    expect(parsed.permissions.allow).toContain('command(custom-tool)');
    expect(parsed.permissions.allow).toContain('read_file');
    expect(parsed.permissions.allow).toContain('command(git)');
    expect(parsed.trustedWorkspaces).toContain('/existing/trusted/path');
    expect(parsed.trustedWorkspaces).toContain(path.resolve('/new/workspace'));
  });
});

describe('agy settings are backed up, recorded and revertible', () => {
  const GLOBAL = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
  const CONSENT = path.join(os.homedir(), '.remote-hands', 'agy-consent.json');
  const original = {
    model: 'Custom',
    permissions: { defaultAction: 'ask', allow: ['command(custom-tool)', 'read_file'], deny: ['x'] },
    trustedWorkspaces: ['/mine'],
  };

  it('copies the file once before the first change and never overwrites that copy', async () => {
    const raw = JSON.stringify(original);
    const { fs, files } = memoryFs({ [GLOBAL]: raw });
    await ensureAgyPermissions(fs, undefined, { explicit: true });
    expect(files[`${GLOBAL}.bak-rh`]).toBe(raw);
    await ensureAgyPermissions(fs, undefined, { explicit: true });
    expect(files[`${GLOBAL}.bak-rh`]).toBe(raw);
  });

  it('revert puts back exactly what was there and keeps what the person added later', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    await ensureAgyPermissions(fs, '/ws', { explicit: true });
    // the person adds a rule of their own afterwards
    const changed = JSON.parse(files[GLOBAL]!);
    expect(changed.permissions.defaultAction).toBe('allow');
    expect(changed.permissions.disableAllPrompts).toBe(true);
    changed.permissions.allow.push('command(later)');
    files[GLOBAL] = JSON.stringify(changed);

    const res = await revertAgyPermissions(fs);
    expect(res.restored).toEqual([GLOBAL]);
    const back = JSON.parse(files[GLOBAL]!);
    expect(back.model).toBe('Custom');
    expect(back.permissions.defaultAction).toBe('ask');
    expect('disableAllPrompts' in back.permissions).toBe(false);
    expect(back.permissions.deny).toEqual(['x']);
    expect(back.permissions.allow).toEqual(['command(custom-tool)', 'read_file', 'command(later)']);
    expect(back.trustedWorkspaces).toEqual(['/mine']);
  });

  it('a second run does not record its own earlier additions as the person\'s', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    await ensureAgyPermissions(fs, undefined, { explicit: true });
    await ensureAgyPermissions(fs, undefined, { explicit: true });
    await revertAgyPermissions(fs);
    const back = JSON.parse(files[GLOBAL]!);
    expect(back.permissions.allow).toEqual(['command(custom-tool)', 'read_file']);
    expect(back.permissions.defaultAction).toBe('ask');
  });

  it('after a revert, background callers leave the settings alone until someone asks again', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    await ensureAgyPermissions(fs, undefined, { explicit: true });
    await revertAgyPermissions(fs);
    const reverted = files[GLOBAL];
    expect(await ensureAgyPermissions(fs)).toBe(false);
    expect(files[GLOBAL]).toBe(reverted);
    expect(JSON.parse(files[CONSENT]!).state).toBe('revoked');
    expect(await ensureAgyPermissions(fs, undefined, { explicit: true })).toBe(true);
    expect(JSON.parse(files[GLOBAL]!).permissions.defaultAction).toBe('allow');
    expect(JSON.parse(files[CONSENT]!).state).toBe('granted');
  });

  it('revert with nothing recorded changes nothing', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    const res = await revertAgyPermissions(fs);
    expect(res.restored).toEqual([]);
    expect(JSON.parse(files[GLOBAL]!)).toEqual(original);
  });

  it('background callers still set things up as before when nothing was ever reverted', async () => {
    const { fs, files } = memoryFs({});
    expect(await ensureAgyPermissions(fs)).toBe(true);
    expect(JSON.parse(files[GLOBAL]!).permissions.defaultAction).toBe('allow');
  });
});

describe('agy settings changes are durable and race-free', () => {
  const GLOBAL = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
  const UNDO = path.join(os.homedir(), '.remote-hands', 'agy-undo.json');
  const CONSENT = path.join(os.homedir(), '.remote-hands', 'agy-consent.json');
  const original = { permissions: { defaultAction: 'ask', allow: ['read_file'] }, trustedWorkspaces: ['/mine'] };

  function failingFor(fs: FileSystemAdapter, failPaths: string[]): FileSystemAdapter {
    return {
      ...fs,
      writeFile: async (p, content) => {
        if (failPaths.includes(p)) throw new Error('EACCES');
        return fs.writeFile(p, content);
      },
    };
  }

  it('changes nothing when the record needed to undo it cannot be written', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    expect(await ensureAgyPermissions(failingFor(fs, [UNDO]), undefined, { explicit: true })).toBe(false);
    expect(JSON.parse(files[GLOBAL]!)).toEqual(original);
    expect(files[`${GLOBAL}.bak-rh`]).toBeUndefined();
  });

  it('records the change before making it (so a crash in between still leaves a way back)', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    const order: string[] = [];
    const watching: FileSystemAdapter = {
      ...fs,
      writeFile: async (p, content) => {
        order.push(p);
        return fs.writeFile(p, content);
      },
    };
    await ensureAgyPermissions(watching, undefined, { explicit: true });
    expect(order.indexOf(UNDO)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(UNDO)).toBeLessThan(order.indexOf(GLOBAL));
    expect(JSON.parse(files[UNDO]!).files[GLOBAL].defaultAction).toEqual({ had: true, value: 'ask' });
  });

  it('a revert that cannot record "revoked" changes nothing and says so', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    await ensureAgyPermissions(fs, undefined, { explicit: true });
    const permissive = files[GLOBAL];
    const res = await revertAgyPermissions(failingFor(fs, [CONSENT]));
    expect(res.error).toContain('nothing was changed');
    expect(res.restored).toEqual([]);
    expect(files[GLOBAL]).toBe(permissive);
    expect(JSON.parse(files[CONSENT]!).state).toBe('granted');
  });

  it('keeps the record of a file that could not be restored, and reports it', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    await ensureAgyPermissions(fs, undefined, { explicit: true });
    const res = await revertAgyPermissions(failingFor(fs, [GLOBAL]));
    expect(res.skipped.map((s) => s.path)).toEqual([GLOBAL]);
    expect(Object.keys(JSON.parse(files[UNDO]!).files)).toEqual([GLOBAL]);
    expect(JSON.parse(files[CONSENT]!).state).toBe('revoked');
  });

  describe('with the real file system (a private HOME)', () => {
    const realFs = defaultFileSystem;
    let home: string;
    let savedHome: string | undefined;
    beforeEach(() => {
      savedHome = process.env.HOME;
      home = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'agy-lock-'));
      process.env.HOME = home;
      nodeFs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      nodeFs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(original));
    });
    afterEach(() => {
      process.env.HOME = savedHome;
      nodeFs.rmSync(home, { recursive: true, force: true });
    });
    const settings = () => JSON.parse(nodeFs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf-8'));
    const consent = () => JSON.parse(nodeFs.readFileSync(path.join(home, '.remote-hands', 'agy-consent.json'), 'utf-8')).state;

    it('a background caller that overlaps a revert can never leave "revoked" with permissive settings', async () => {
      for (let round = 0; round < 15; round += 1) {
        nodeFs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(original));
        nodeFs.rmSync(path.join(home, '.remote-hands'), { recursive: true, force: true });
        await ensureAgyPermissions(realFs, undefined, { explicit: true });
        const jobs = [() => ensureAgyPermissions(realFs), () => revertAgyPermissions(realFs)];
        if (round % 2 === 1) jobs.reverse();
        await Promise.all(jobs.map((job) => job()));
        expect(consent()).toBe('revoked');
        expect(settings().permissions.defaultAction).toBe('ask');
        expect(settings().permissions.allow).toEqual(['read_file']);
      }
    });

    it('gives up (changing nothing) when another process holds the lock, and takes over a lock left by a crash', async () => {
      const lock = path.join(home, '.remote-hands', 'agy-settings.lock');
      nodeFs.mkdirSync(lock, { recursive: true });
      expect(await ensureAgyPermissions(realFs, undefined, { explicit: true, lockWaitMs: 150 })).toBe(false);
      expect(settings()).toEqual(original);
      const res = await revertAgyPermissions(realFs, { lockWaitMs: 150 });
      expect(res.error).toContain('another Remote Hands process');

      const old = new Date(Date.now() - 60_000);
      nodeFs.utimesSync(lock, old, old);
      expect(await ensureAgyPermissions(realFs, undefined, { explicit: true, lockWaitMs: 150 })).toBe(true);
      expect(settings().permissions.defaultAction).toBe('allow');
      expect(nodeFs.existsSync(lock)).toBe(false);
    });
  });
});

describe('unreadable records and lock ownership', () => {
  const GLOBAL = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
  const UNDO = path.join(os.homedir(), '.remote-hands', 'agy-undo.json');
  const CONSENT = path.join(os.homedir(), '.remote-hands', 'agy-consent.json');
  const original = { permissions: { defaultAction: 'ask', allow: ['read_file'] } };

  it('reads a missing consent record as no choice, an empty one as no choice, and a damaged or unreadable one as revoked', async () => {
    expect(await readAgyConsent(memoryFs().fs)).toBe('none');
    expect(await readAgyConsent(memoryFs({ [CONSENT]: '  ' }).fs)).toBe('none');
    expect(await readAgyConsent(memoryFs({ [CONSENT]: '{ half a rec' }).fs)).toBe('revoked');
    expect(await readAgyConsent(memoryFs({ [CONSENT]: '{"state":"maybe"}' }).fs)).toBe('revoked');
    const unreadable: FileSystemAdapter = { exists: async () => true, readFile: async () => { throw new Error('EACCES'); }, writeFile: async () => {} };
    expect(await readAgyConsent(unreadable)).toBe('revoked');
    expect(await readAgyConsent(memoryFs({ [CONSENT]: '{"state":"granted"}' }).fs)).toBe('granted');
  });

  it('a background caller stays out when the consent record is damaged (it cannot tell if the person revoked)', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original), [CONSENT]: '{ half a rec' });
    expect(await ensureAgyPermissions(fs)).toBe(false);
    expect(JSON.parse(files[GLOBAL]!)).toEqual(original);
  });

  it('never replaces an undo record it cannot read: setup stops, revert reports it and leaves it as it is', async () => {
    const damaged = '{ "files": ';
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original), [UNDO]: damaged });
    expect(await ensureAgyPermissions(fs, undefined, { explicit: true })).toBe(false);
    expect(JSON.parse(files[GLOBAL]!)).toEqual(original);
    expect(files[UNDO]).toBe(damaged);
    const res = await revertAgyPermissions(fs);
    expect(res.error).toContain('cannot be read');
    expect(files[UNDO]).toBe(damaged);
    expect(files[CONSENT]).toBeUndefined();
  });

  it('an accepted grant that cannot be recorded changes nothing', async () => {
    const { fs, files } = memoryFs({ [GLOBAL]: JSON.stringify(original) });
    const noConsent: FileSystemAdapter = { ...fs, writeFile: async (p, c) => { if (p === CONSENT) throw new Error('EACCES'); return fs.writeFile(p, c); } };
    expect(await ensureAgyPermissions(noConsent, undefined, { explicit: true })).toBe(false);
    expect(JSON.parse(files[GLOBAL]!)).toEqual(original);
  });

  describe('the lock, on the real file system (a private HOME)', () => {
    let home: string;
    let savedHome: string | undefined;
    beforeEach(() => {
      savedHome = process.env.HOME;
      home = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'agy-lock2-'));
      process.env.HOME = home;
      nodeFs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      nodeFs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(original));
    });
    afterEach(() => {
      process.env.HOME = savedHome;
      try {
        nodeFs.chmodSync(path.join(home, '.remote-hands'), 0o755);
      } catch {
        // none
      }
      nodeFs.rmSync(home, { recursive: true, force: true });
    });
    const lock = () => path.join(home, '.remote-hands', 'agy-settings.lock');
    const makeLock = (owner?: { pid: number; token: string }, ageMs = 0) => {
      nodeFs.mkdirSync(lock(), { recursive: true });
      if (owner) nodeFs.writeFileSync(path.join(lock(), 'owner.json'), JSON.stringify(owner));
      const t = new Date(Date.now() - ageMs);
      nodeFs.utimesSync(lock(), t, t);
    };
    const deadPid = (): number => {
      const child = spawnSync(process.execPath, ['-e', '0']);
      return child.pid ?? 999_999;
    };
    const ensure = () => ensureAgyPermissions(defaultFileSystem, undefined, { explicit: true, lockWaitMs: 150 });

    it('takes over a lock whose owner process is gone, however recent it is', async () => {
      makeLock({ pid: deadPid(), token: 'old' }, 0);
      expect(await ensure()).toBe(true);
      expect(nodeFs.existsSync(lock())).toBe(false);
    });

    it('never takes a lock whose owner is alive, however old it looks (up to ten minutes), and says it is busy', async () => {
      makeLock({ pid: process.pid, token: 'live' }, 5 * 60_000);
      expect(await ensure()).toBe(false);
      expect(nodeFs.existsSync(lock())).toBe(true);
      const res = await revertAgyPermissions(defaultFileSystem, { lockWaitMs: 100 });
      expect(res.error).toContain('another Remote Hands process');
    });

    it('treats a lock with no owner file as abandoned only after a few seconds', async () => {
      makeLock(undefined, 0);
      expect(await ensure()).toBe(false);
      makeLock(undefined, 60_000);
      expect(await ensure()).toBe(true);
    });

    it('gives up quickly, instead of spinning, when an abandoned lock cannot be removed', async () => {
      makeLock({ pid: deadPid(), token: 'old' }, 0);
      nodeFs.chmodSync(path.join(home, '.remote-hands'), 0o555);
      const started = Date.now();
      expect(await ensure()).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('releases only its own lock: one taken over meanwhile stays with its new owner', async () => {
      const original2 = defaultFileSystem.writeFile;
      const spy = vi.spyOn(defaultFileSystem, 'writeFile').mockImplementation(async (file, content) => {
        // while this process holds the lock, "another process" replaces it
        if (file.endsWith('antigravity-cli/settings.json')) nodeFs.writeFileSync(path.join(lock(), 'owner.json'), JSON.stringify({ pid: process.pid, token: 'someone-else' }));
        return original2(file, content);
      });
      try {
        await ensure();
      } finally {
        spy.mockRestore();
      }
      expect(JSON.parse(nodeFs.readFileSync(path.join(lock(), 'owner.json'), 'utf-8')).token).toBe('someone-else');
    });

    it('rule edits made by "rh mcp add/remove" wait for the same lock', async () => {
      makeLock({ pid: process.pid, token: 'live' }, 0);
      const started = Date.now();
      const added = await ensureAgyMcpPermission(defaultFileSystem);
      expect(added.updated).toEqual([]);
      expect(added.skipped[0]?.reason).toContain('another Remote Hands process');
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    }, 15_000);
  });
});
