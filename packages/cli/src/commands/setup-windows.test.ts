import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../cloudflare/wrangler.js';
import type { FileSystemAdapter } from '../cloudflare/project.js';
import { setupCommand } from './setup.js';

const found = vi.hoisted(() => ({ agy: undefined as string | undefined }));
vi.mock('@remote-hands/daemon', async (original) => ({
  ...(await original<typeof import('@remote-hands/daemon')>()),
  findAgyOnWindows: () => found.agy,
}));

const mockFs: FileSystemAdapter = {
  exists: async () => false,
  readFile: async () => '',
  writeFile: async () => {},
  mkdir: async () => {},
  readdir: async () => [],
} as unknown as FileSystemAdapter;

describe('rh setup --hud on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    found.agy = undefined;
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  const service = (hotkey: { state: string } | null = { state: 'ready' }) => ({
    install: vi.fn().mockReturnValue({ success: true, plistPath: 'the Windows startup list' }),
    isInstalled: () => true,
    isRunning: () => true,
    waitForHotkey: vi.fn().mockResolvedValue(hotkey),
  });

  async function run(opts: { installs?: boolean; hotkey?: { state: string } | null; browser?: { path: string; kind: 'chrome' | 'edge' } | undefined } = {}) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const out: string[] = [];
    const err: string[] = [];
    const runner: CommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'powershell' && opts.installs !== false) found.agy = 'C:\\Users\\Ana Lee\\AppData\\Local\\agy\\bin\\agy.exe';
      if (args[0] === 'models') return { exitCode: 0, stdout: 'gemini-3.8-flash\tGemini', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const hud = service(opts.hotkey);
    const code = await setupCommand(['--hud'], {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      runner,
      fs: mockFs,
      projectRoot: 'C:\\project',
      hudServiceManager: hud,
      prepareHotkeyHelper: () => ({ ok: true, path: 'C:\\rh-hud.exe' }),
      findBrowser: () => ('browser' in opts ? opts.browser : { path: 'C:\\chrome.exe', kind: 'chrome' as const }),
      isTTY: false,
    } as never);
    return { code, calls, out: out.join('\n'), err: err.join('\n'), hud };
  }

  it('installs agy with the PowerShell script quoted, then runs agy by its full path (quoted: it has a space)', async () => {
    const { code, calls, out } = await run();
    expect(code).toBe(0);
    const install = calls.find((c) => c.cmd === 'powershell')!;
    expect(install.args.at(-1)).toBe('"irm https://antigravity.google/cli/install.ps1 | iex"');
    expect(calls.some((c) => c.cmd === 'which')).toBe(false);
    const agyCalls = calls.filter((c) => c.cmd.includes('agy.exe'));
    expect(agyCalls.length).toBeGreaterThan(0);
    for (const c of agyCalls) expect(c.cmd).toBe('"C:\\Users\\Ana Lee\\AppData\\Local\\agy\\bin\\agy.exe"');
    expect(out).toContain('Desktop HUD is ready');
    expect(out).toContain('5/5');
  });

  it('does not reinstall agy when it is already there', async () => {
    found.agy = 'C:\\agy\\agy.exe';
    const { calls, code } = await run({ installs: false });
    expect(code).toBe(0);
    expect(calls.some((c) => c.cmd === 'powershell')).toBe(false);
  });

  it('asks for a new window when agy was installed but cannot be found yet', async () => {
    const { code, err, calls } = await run({ installs: false });
    expect(code).toBe(1);
    expect(err).toContain('Close this window, open a new PowerShell window');
    expect(calls.some((c) => c.cmd === 'powershell')).toBe(true);
  });

  it('says which browser Remote Hands will use, and what to do when there is none', async () => {
    expect((await run({ browser: { path: 'C:\\chrome.exe', kind: 'chrome' } })).out).toContain('Google Chrome found');
    expect((await run({ browser: { path: 'C:\\edge.exe', kind: 'edge' } })).out).toContain('Microsoft Edge found (used because Google Chrome is not installed)');
    const none = await run({ browser: undefined });
    expect(none.out).toContain('No Chrome or Edge was found');
    expect(none.code).toBe(0);
  });

  it('waits for the shortcut before saying the HUD is ready, and fails loudly when no shortcut is free', async () => {
    const ok = await run({ hotkey: { state: 'ready' } });
    expect(ok.hud.waitForHotkey).toHaveBeenCalled();
    expect(ok.code).toBe(0);
    const failed = await run({ hotkey: { state: 'failed' } });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('already used by another program');
    expect(failed.out).not.toContain('Desktop HUD is ready');
    const slow = await run({ hotkey: null });
    expect(slow.out).toContain('still starting');
    expect(slow.code).toBe(0);
  });
});
