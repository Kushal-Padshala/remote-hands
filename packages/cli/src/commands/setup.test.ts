import { describe, expect, it, vi, afterEach } from 'vitest';
import { setupCommand } from './setup.js';
import type { CommandRunner } from '../cloudflare/wrangler.js';
import type { FileSystemAdapter } from '../cloudflare/project.js';

describe('Setup Command Flow', () => {
  const originalPlatform = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));
  it('executes setup steps in order and prints pairing information without leaking secret', async () => {
    const executedCommands: string[] = [];
    const outputLines: string[] = [];
    const files: Record<string, string> = {
      '/project/apps/cloudflare/wrangler.jsonc': '{"d1_databases": [{"database_id": "placeholder"}]}',
      '/config/config.json': '{}',
    };

    const mockRunner: CommandRunner = async (cmd, args) => {
      const full = `${cmd} ${args.join(' ')}`;
      executedCommands.push(full);
      if (cmd === 'which' && args[0] === 'browser-harness') {
        return { exitCode: 0, stdout: '/bin/browser-harness', stderr: '' };
      }
      if (cmd === 'browser-harness' && args[0] === 'skill') {
        return { exitCode: 0, stdout: '---\nname: browser-harness\n---', stderr: '' };
      }
      if (args.includes('whoami')) {
        return { exitCode: 0, stdout: 'Logged in as user@example.com', stderr: '' };
      }
      if (args.includes('create') && args.includes('d1')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ database_id: 'new-d1-uuid', database_name: 'remote-hands-db' }),
          stderr: '',
        };
      }
      if (args.includes('migrations')) {
        return { exitCode: 0, stdout: 'Migrations applied successfully', stderr: '' };
      }
      if (args[0] === 'deploy') {
        return {
          exitCode: 0,
          stdout: 'Deployed to https://remote-hands-api.workers.dev',
          stderr: '',
        };
      }
      if (args.includes('pages') && args.includes('deploy')) {
        return {
          exitCode: 0,
          stdout: 'Deployed to https://remote-hands-web.pages.dev',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => p in files,
    };

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/setup/owner')) {
        return new Response(
          JSON.stringify({ ok: true, owner_id: '11111111-1111-4111-8111-111111111111' }),
          { status: 200 },
        );
      }
      if (url.includes('/pairing/start')) {
        return new Response(
          JSON.stringify({
            token_id: '22222222-2222-4222-8222-222222222222',
            pairing_code: 'RH-87KZ-M2WP-46NT',
            expires_at: new Date(Date.now() + 600000).toISOString(),
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const exitCode = await setupCommand([], {
      stdout: (line) => outputLines.push(line),
      runner: mockRunner,
      fs: mockFs,
      fetchFn: mockFetch as unknown as typeof fetch,
      projectRoot: '/project',
      configDir: '/config',
    });

    expect(exitCode).toBe(0);

    expect(executedCommands.some((c) => c.includes('wrangler whoami'))).toBe(true);
    expect(executedCommands.some((c) => c.includes('wrangler d1 create'))).toBe(true);
    expect(executedCommands.some((c) => c.includes('wrangler d1 migrations apply'))).toBe(true);
    expect(executedCommands.some((c) => c.includes('wrangler deploy'))).toBe(true);
    expect(executedCommands.some((c) => c.includes('wrangler pages deploy'))).toBe(true);

    const fullOutput = outputLines.join('\n');
    expect(fullOutput).toContain('RH-87KZ-M2WP-46NT');
    expect(fullOutput).toContain('https://remote-hands-web.pages.dev');
    expect(fullOutput).toContain('remote-hands daemon');

    expect(fullOutput).not.toContain('super-secret');
    expect(fullOutput).not.toContain('OWNER_SECRET_HASH');
  });

  it('automatically launches wrangler login when unauthenticated and continues setup', async () => {
    const executedCommands: string[] = [];
    let authenticated = false;

    const mockRunner: CommandRunner = async (cmd, args) => {
      const full = `${cmd} ${args.join(' ')}`;
      executedCommands.push(full);
      if (cmd === 'which' && args[0] === 'browser-harness') {
        return { exitCode: 0, stdout: '/bin/browser-harness', stderr: '' };
      }
      if (cmd === 'browser-harness' && args[0] === 'skill') {
        return { exitCode: 0, stdout: '---\nname: browser-harness\n---', stderr: '' };
      }
      if (args.includes('whoami')) {
        if (!authenticated) {
          return { exitCode: 0, stdout: 'You are not authenticated.', stderr: '' };
        }
        return { exitCode: 0, stdout: 'Logged in as newuser@example.com', stderr: '' };
      }
      if (args.includes('login')) {
        authenticated = true;
        return { exitCode: 0, stdout: 'Success', stderr: '' };
      }
      if (args.includes('create') && args.includes('d1')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ database_id: 'new-d1-uuid', database_name: 'remote-hands-db' }),
          stderr: '',
        };
      }
      if (args.includes('migrations')) {
        return { exitCode: 0, stdout: 'Migrations applied successfully', stderr: '' };
      }
      if (args[0] === 'deploy') {
        return {
          exitCode: 0,
          stdout: 'Deployed to https://remote-hands-api.workers.dev',
          stderr: '',
        };
      }
      if (args.includes('pages') && args.includes('deploy')) {
        return {
          exitCode: 0,
          stdout: 'Deployed to https://remote-hands-web.pages.dev',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const mockFs: FileSystemAdapter = {
      readFile: async () => '{"d1_databases": [{"database_id": "placeholder"}]}',
      writeFile: async () => {},
      exists: async () => true,
    };

    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, owner_id: 'owner-1', pairing_code: 'RH-9999-AAAA-BBBB' }), { status: 200 }));

    const exitCode = await setupCommand([], {
      stdout: () => {},
      stderr: () => {},
      runner: mockRunner,
      fs: mockFs,
      fetchFn: mockFetch as unknown as typeof fetch,
      projectRoot: '/project',
    });

    expect(exitCode).toBe(0);
    expect(executedCommands.some((c) => c.includes('wrangler login'))).toBe(true);
    expect(executedCommands.some((c) => c.includes('wrangler d1 create'))).toBe(true);
  });

  it('installs agy CLI when not installed and continues setup', async () => {
    const executedCommands: string[] = [];
    let agyInstalled = false;

    const mockRunner: CommandRunner = async (cmd, args) => {
      const full = `${cmd} ${args.join(' ')}`;
      executedCommands.push(full);
      if (cmd === 'which' && args[0] === 'agy') {
        if (!agyInstalled) {
          return { exitCode: 1, stdout: '', stderr: 'not found' };
        }
        return { exitCode: 0, stdout: '/usr/local/bin/agy', stderr: '' };
      }
      if (cmd === 'bash' && args.join(' ').includes('install.sh')) {
        agyInstalled = true;
        return { exitCode: 0, stdout: 'Installed agy', stderr: '' };
      }
      if (cmd === 'agy' && args.includes('-p')) {
        return { exitCode: 0, stdout: 'hello', stderr: '' };
      }
      if (cmd === 'which' && args[0] === 'browser-harness') {
        return { exitCode: 0, stdout: '/bin/browser-harness', stderr: '' };
      }
      if (cmd === 'browser-harness' && args[0] === 'skill') {
        return { exitCode: 0, stdout: '---\nname: browser-harness\n---', stderr: '' };
      }
      if (args.includes('whoami')) {
        return { exitCode: 0, stdout: 'Logged in as user@example.com', stderr: '' };
      }
      if (args.includes('create') && args.includes('d1')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ database_id: 'new-d1-uuid', database_name: 'remote-hands-db' }),
          stderr: '',
        };
      }
      if (args.includes('migrations')) {
        return { exitCode: 0, stdout: 'Migrations applied successfully', stderr: '' };
      }
      if (args[0] === 'deploy') {
        return {
          exitCode: 0,
          stdout: 'Deployed to https://remote-hands-api.workers.dev',
          stderr: '',
        };
      }
      if (args.includes('pages') && args.includes('deploy')) {
        return {
          exitCode: 0,
          stdout: 'Deployed to https://remote-hands-web.pages.dev',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const mockFs: FileSystemAdapter = {
      readFile: async () => '{"d1_databases": [{"database_id": "placeholder"}]}',
      writeFile: async () => {},
      exists: async () => true,
    };

    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, owner_id: 'owner-1', pairing_code: 'RH-9999-AAAA-BBBB' }), { status: 200 }));

    const exitCode = await setupCommand([], {
      stdout: () => {},
      stderr: () => {},
      runner: mockRunner,
      fs: mockFs,
      fetchFn: mockFetch as unknown as typeof fetch,
      projectRoot: '/project',
    });

    expect(exitCode).toBe(0);
    expect(executedCommands.some((c) => c.includes('install.sh'))).toBe(true);
  });

  it('triggers interactive agy sign-in when agy is not authenticated', async () => {
    const executedCommands: string[] = [];
    let authenticated = false;

    const mockRunner: CommandRunner = async (cmd, args) => {
      const full = `${cmd} ${args.join(' ')}`;
      executedCommands.push(full);
      if (cmd === 'which' && args[0] === 'agy') {
        return { exitCode: 0, stdout: '/usr/local/bin/agy', stderr: '' };
      }
      if (cmd === 'agy' && args.length === 0) {
        authenticated = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'agy' && args.includes('-p')) {
        if (!authenticated) {
          return { exitCode: 1, stdout: 'User not authenticated. Please sign in.', stderr: '' };
        }
        return { exitCode: 0, stdout: 'hello', stderr: '' };
      }
      if (cmd === 'which' && args[0] === 'browser-harness') {
        return { exitCode: 0, stdout: '/bin/browser-harness', stderr: '' };
      }
      if (cmd === 'browser-harness' && args[0] === 'skill') {
        return { exitCode: 0, stdout: '---\nname: browser-harness\n---', stderr: '' };
      }
      if (args.includes('whoami')) {
        return { exitCode: 0, stdout: 'Logged in as user@example.com', stderr: '' };
      }
      if (args.includes('create') && args.includes('d1')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ database_id: 'new-d1-uuid', database_name: 'remote-hands-db' }),
          stderr: '',
        };
      }
      if (args.includes('migrations')) {
        return { exitCode: 0, stdout: 'Migrations applied successfully', stderr: '' };
      }
      if (args[0] === 'deploy') {
        return {
          exitCode: 0,
          stdout: 'Deployed to https://remote-hands-api.workers.dev',
          stderr: '',
        };
      }
      if (args.includes('pages') && args.includes('deploy')) {
        return {
          exitCode: 0,
          stdout: 'Deployed to https://remote-hands-web.pages.dev',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const mockFs: FileSystemAdapter = {
      readFile: async () => '{"d1_databases": [{"database_id": "placeholder"}]}',
      writeFile: async () => {},
      exists: async () => true,
    };

    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, owner_id: 'owner-1', pairing_code: 'RH-9999-AAAA-BBBB' }), { status: 200 }));

    const exitCode = await setupCommand([], {
      stdout: () => {},
      stderr: () => {},
      runner: mockRunner,
      fs: mockFs,
      fetchFn: mockFetch as unknown as typeof fetch,
      projectRoot: '/project',
    });

    expect(exitCode).toBe(0);
    expect(executedCommands.some((c) => c === 'agy ' || c === 'agy')).toBe(true);
  });

  it('fails setup when agy installation fails', async () => {
    const errorLines: string[] = [];
    const mockRunner: CommandRunner = async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'agy') {
        return { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      if (cmd === 'bash' && args.join(' ').includes('install.sh')) {
        return { exitCode: 1, stdout: '', stderr: 'network error' };
      }
      if (args.includes('whoami')) {
        return { exitCode: 0, stdout: 'Logged in as user@example.com', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const exitCode = await setupCommand([], {
      stdout: () => {},
      stderr: (line) => errorLines.push(line),
      runner: mockRunner,
      fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => true },
      fetchFn: vi.fn() as unknown as typeof fetch,
      projectRoot: '/project',
    });

    expect(exitCode).toBe(1);
    expect(errorLines.join('\n')).toContain('Failed to install agy');
  });

  it('fails setup when agy sign-in fails or is aborted', async () => {
    const errorLines: string[] = [];
    const mockRunner: CommandRunner = async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'agy') {
        return { exitCode: 0, stdout: '/usr/local/bin/agy', stderr: '' };
      }
      if (cmd === 'agy') {
        return { exitCode: 1, stdout: 'Sign in aborted', stderr: '' };
      }
      if (args.includes('whoami')) {
        return { exitCode: 0, stdout: 'Logged in as user@example.com', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const exitCode = await setupCommand([], {
      stdout: () => {},
      stderr: (line) => errorLines.push(line),
      runner: mockRunner,
      fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => true },
      fetchFn: vi.fn() as unknown as typeof fetch,
      projectRoot: '/project',
    });

    expect(exitCode).toBe(1);
    expect(errorLines.join('\n')).toContain('agy sign-in was not completed');
  });

  it.each(['darwin', 'linux'])('runs zero-account setup without Cloudflare credentials on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const executedCommands: string[] = [];
    const outputLines: string[] = [];
    const files: Record<string, string> = {};

    const mockRunner: CommandRunner = async (cmd, args) => {
      executedCommands.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'which' && args[0] === 'browser-harness') {
        return { exitCode: 0, stdout: '/bin/browser-harness', stderr: '' };
      }
      if (cmd === 'which' && args[0] === 'agy') {
        return { exitCode: 0, stdout: '/usr/local/bin/agy', stderr: '' };
      }
      if (cmd === 'browser-harness' && args[0] === 'skill') {
        return { exitCode: 0, stdout: '---\nname: browser-harness\n---', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => p in files,
    };

    const exitCode = await setupCommand(['--local'], {
      stdout: (line) => outputLines.push(line),
      runner: mockRunner,
      fs: mockFs,
      projectRoot: '/project',
      configDir: '/config',
    });

    expect(exitCode).toBe(0);
    expect(executedCommands.some((c) => c.includes('wrangler'))).toBe(false);
    expect(files['/config/daemon.json']).toContain('"mode": "local"');
    expect(outputLines.join('\n')).toContain('Zero-account local setup complete!');
    expect(outputLines.join('\n')).toContain(platform === 'darwin'
      ? 'Desktop Overlay Assistant installed and active'
      : 'Desktop Overlay hotkey service is supported on macOS');
    expect(outputLines.join('\n')).toContain('1. Desktop Use (Active now):');
    expect(outputLines.join('\n')).toContain('2. Remote Mobile Use:');
  });

  it.each(['darwin', 'linux'])('installs the desktop overlay only on macOS: %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const outputLines: string[] = [];
    const mockService = {
      install: vi.fn().mockReturnValue({ success: true, plistPath: '/test/hud.plist' }),
      isInstalled: vi.fn().mockReturnValue(true),
      isRunning: vi.fn().mockReturnValue(true),
    };

    const mockRunner: CommandRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });
    const mockFs: FileSystemAdapter = {
      readFile: async () => '',
      writeFile: async () => {},
      exists: async () => true,
    };

    const exitCode = await setupCommand(['--local'], {
      stdout: (line) => outputLines.push(line),
      runner: mockRunner,
      fs: mockFs,
      hudServiceManager: mockService,
      projectRoot: '/project',
      configDir: '/config',
    });

    expect(exitCode).toBe(0);
    expect(mockService.install).toHaveBeenCalledTimes(platform === 'darwin' ? 1 : 0);
    expect(outputLines.join('\n')).toContain(platform === 'darwin'
      ? 'Desktop Overlay Assistant installed and active'
      : 'Desktop Overlay hotkey service is supported on macOS');
  });

  it('skips desktop overlay assistant when --no-hud flag is provided', async () => {
    const outputLines: string[] = [];
    const mockService = {
      install: vi.fn(),
      isInstalled: vi.fn().mockReturnValue(false),
      isRunning: vi.fn().mockReturnValue(false),
    };

    const mockRunner: CommandRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });
    const mockFs: FileSystemAdapter = {
      readFile: async () => '',
      writeFile: async () => {},
      exists: async () => true,
    };

    const exitCode = await setupCommand(['--local', '--no-hud'], {
      stdout: (line) => outputLines.push(line),
      runner: mockRunner,
      fs: mockFs,
      hudServiceManager: mockService,
      projectRoot: '/project',
      configDir: '/config',
    });

    expect(exitCode).toBe(0);
    expect(mockService.install).not.toHaveBeenCalled();
    expect(outputLines.join('\n')).toContain('Desktop Overlay installation skipped');
  });

  it('prints usage for --help without running any step', async () => {
    const out: string[] = [];
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const code = await setupCommand(['--help'], { stdout: (l) => out.push(l), runner: runner as any, isTTY: false });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Usage: rh setup');
    expect(runner).not.toHaveBeenCalled();
  });

  describe('agy sign-in detection', () => {
    const files: Record<string, string> = {};
    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => p in files,
    };

    function run(agyBehaviour: (args: string[], interactive: boolean) => { exitCode: number; stdout: string; stderr: string }) {
      const interactiveLaunches: string[][] = [];
      const runner: CommandRunner = async (cmd, args, opts) => {
        if (cmd === 'which' && args[0] === 'agy') return { exitCode: 0, stdout: '/usr/local/bin/agy', stderr: '' };
        if (cmd === 'agy') {
          const interactive = Boolean((opts as any)?.interactive);
          if (interactive) interactiveLaunches.push(args);
          return agyBehaviour(args, interactive);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      return { runner, interactiveLaunches };
    }

    it('does not launch agy when `agy models` shows a signed-in session (even if a prompt would be slow)', async () => {
      const { runner, interactiveLaunches } = run((args) =>
        args[0] === 'models'
          ? { exitCode: 0, stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'timed out' },
      );
      const code = await setupCommand(['--hud'], {
        stdout: () => {},
        runner,
        fs: mockFs,
        projectRoot: '/project',
        hudServiceManager: { install: () => ({ success: true, plistPath: '/m.plist' }) },
        browserSetup: { transport: { environment: async () => ({ frontmost: null, running: [] }) } as any },
        isTTY: false,
      });
      expect(code).toBe(0);
      expect(interactiveLaunches).toEqual([]);
    });

    it('a slow or failing prompt without any sign-in wording is not treated as a missing sign-in', async () => {
      const { runner, interactiveLaunches } = run((args) =>
        args[0] === 'models' ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'timed out after 60s' },
      );
      const code = await setupCommand(['--hud'], {
        stdout: () => {},
        runner,
        fs: mockFs,
        projectRoot: '/project',
        hudServiceManager: { install: () => ({ success: true, plistPath: '/m.plist' }) },
        browserSetup: { transport: { environment: async () => ({ frontmost: null, running: [] }) } as any },
        isTTY: false,
      });
      expect(code).toBe(0);
      expect(interactiveLaunches).toEqual([]);
    });

    it('still launches the interactive sign-in when agy asks for it', async () => {
      let signedIn = false;
      const { runner, interactiveLaunches } = run((args, interactive) => {
        if (interactive) {
          signedIn = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (signedIn) return { exitCode: 0, stdout: 'ok', stderr: '' };
        return { exitCode: 1, stdout: 'Please sign in', stderr: '' };
      });
      const code = await setupCommand(['--hud'], {
        stdout: () => {},
        runner,
        fs: mockFs,
        projectRoot: '/project',
        hudServiceManager: { install: () => ({ success: true, plistPath: '/m.plist' }) },
        browserSetup: { transport: { environment: async () => ({ frontmost: null, running: [] }) } as any },
        isTTY: false,
      });
      expect(code).toBe(0);
      expect(interactiveLaunches).toHaveLength(1);
    });
  });

  describe('what to set up', () => {
    const files: Record<string, string> = {};
    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => p in files,
    };

    function hudRunner(executed: string[]): CommandRunner {
      return async (cmd, args) => {
        executed.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'which' && args[0] === 'agy') return { exitCode: 0, stdout: '/usr/local/bin/agy', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      };
    }

    const readyBrowserSetup = (inspected: string[]) => ({
      transport: { environment: async () => ({ frontmost: 'Finder', running: ['Brave Browser'] }) },
      setup: {
        inspect: async (b: any) => {
          inspected.push(b.name);
          return { browser: b.name, status: 'ready', message: 'ok' };
        },
        menuState: async () => ({ ok: true, state: 'checked' }),
        enableJs: async () => ({ ok: true, changed: false, state: 'checked' }),
        disableJs: async () => ({ ok: true, changed: false, state: 'unchecked' }),
        openAutomationPane: async () => {},
        openAccessibilityPane: async () => {},
      } as any,
      fs: { readFile: async () => '', writeFile: async () => {}, rename: async () => {}, mkdir: async () => {} },
      statePath: '/state/browser-setup.json',
    });

    it('--hud sets up the HUD end to end without touching Cloudflare', async () => {
      const executed: string[] = [];
      const out: string[] = [];
      const inspected: string[] = [];
      const mockService = { install: vi.fn().mockReturnValue({ success: true, plistPath: '/mock.plist' }), isInstalled: () => true, isRunning: () => true };
      const code = await setupCommand(['--hud'], {
        stdout: (l) => out.push(l),
        runner: hudRunner(executed),
        fs: mockFs,
        projectRoot: '/project',
        hudServiceManager: mockService,
        browserSetup: readyBrowserSetup(inspected),
        isTTY: false,
      });
      expect(code).toBe(0);
      expect(executed.some((c) => c.includes('wrangler'))).toBe(false);
      expect(out.join('\n')).toContain('Desktop HUD is ready');
      expect(out.join('\n')).toContain('rh setup --remote');
      if (process.platform === 'darwin') {
        expect(inspected).toEqual([]);
        expect(out.join('\n')).not.toContain('Browsers (fast browser control)');
        expect(mockService.install).toHaveBeenCalledTimes(1);
      }
    });

    describe('Command Line Tools', () => {
      if (process.platform !== 'darwin') return;
      const base = { runner: hudRunner([]), fs: mockFs, projectRoot: '/project', hudServiceManager: { install: () => ({ success: true, plistPath: '/mock.plist' }) }, browserSetup: readyBrowserSetup([]), isTTY: false };

      it('starts the install first and waits for it before the permissions step', async () => {
        const order: string[] = [];
        const code = await setupCommand(['--hud'], {
          ...base,
          stdout: (l) => order.push(l),
          beginCommandLineTools: (out) => {
            order.push('BEGIN');
            out('tools needed');
            return { wait: async () => { order.push('WAIT'); return true; } };
          },
        });
        expect(code).toBe(0);
        const begin = order.indexOf('BEGIN');
        const agy = order.findIndex((l) => l.includes('AI Coding Agent'));
        const wait = order.indexOf('WAIT');
        expect(agy).toBeGreaterThanOrEqual(0);
        expect(begin).toBeGreaterThan(agy);
        expect(wait).toBeGreaterThan(begin);
      });

      it('stops with a clear message when the install is not finished in time', async () => {
        const err: string[] = [];
        const out: string[] = [];
        const code = await setupCommand(['--hud'], {
          ...base,
          stdout: (l) => out.push(l),
          stderr: (l) => err.push(l),
          beginCommandLineTools: () => ({ wait: async () => false }),
        });
        expect(code).toBe(1);
        expect(err.join('\n')).toContain('Command Line Tools install did not finish');
        expect(out.join('\n')).not.toContain('Desktop HUD is ready');
      });
    });

    describe('background HUD permission check', () => {
      if (process.platform !== 'darwin') return;
      const node = '/Users/x/.nvm/versions/node/v22/bin/node';
      const report = (screenRecording: boolean) => ({ at: Date.now(), pid: 1, node, screenRecording });
      const make = (extra: Record<string, unknown> = {}) => {
        const restart = vi.fn().mockReturnValue(true);
        const service = { install: vi.fn().mockReturnValue({ success: true, plistPath: '/mock.plist' }), isInstalled: () => true, isRunning: () => true, restart };
        const out: string[] = [];
        const ctx = { runner: hudRunner([]), fs: mockFs, projectRoot: '/project', hudServiceManager: service, browserSetup: readyBrowserSetup([]), stdout: (l: string) => out.push(l), isTTY: false, ...extra };
        return { restart, out, ctx };
      };

      it('is satisfied when the service says it can record the screen', async () => {
        const { out, ctx } = make({ verifyMacHud: async () => report(true) });
        expect(await setupCommand(['--hud'], ctx as never)).toBe(0);
        expect(out.join('\n')).toContain('The background HUD can use Screen Recording');
        expect(out.join('\n')).toContain('Desktop HUD is ready');
      });

      it('names the exact node when it cannot, does not claim ready, and still exits 0 (the hotkey works)', async () => {
        const { out, ctx, restart } = make({ verifyMacHud: async () => report(false) });
        expect(await setupCommand(['--hud'], ctx as never)).toBe(0);
        const text = out.join('\n');
        expect(text).toContain(node);
        expect(text).toContain('Screen & System Audio Recording');
        expect(text).not.toContain('Desktop HUD is ready');
        expect(text).toContain('rh hud install');
        expect(restart).not.toHaveBeenCalled();
      });

      it('at a terminal: waits for Enter, restarts the service, checks again, and succeeds', async () => {
        const reports = [report(false), report(true)];
        const { out, ctx, restart } = make({ isTTY: true, ask: async (q: string) => (q.includes('Press Enter once') ? '' : ''), verifyMacHud: async () => reports.shift() ?? report(true) });
        expect(await setupCommand(['--hud'], ctx as never)).toBe(0);
        expect(restart).toHaveBeenCalledTimes(1);
        expect(out.join('\n')).toContain('Desktop HUD is ready');
      });

      it('at a terminal: s skips without restarting', async () => {
        const { out, ctx, restart } = make({ isTTY: true, ask: async (q: string) => (q.includes('Press Enter once') ? 's' : ''), verifyMacHud: async () => report(false) });
        expect(await setupCommand(['--hud'], ctx as never)).toBe(0);
        expect(restart).not.toHaveBeenCalled();
        expect(out.join('\n')).not.toContain('Desktop HUD is ready');
      });

      it('does not claim ready when the service never reports', async () => {
        const { out, ctx } = make({ verifyMacHud: async () => null });
        expect(await setupCommand(['--hud'], ctx as never)).toBe(0);
        expect(out.join('\n')).toContain('has not reported its permissions yet');
      });
    });

    describe('agy settings consent', () => {
      function freshFs(): { fs: FileSystemAdapter; files: Record<string, string> } {
        const f: Record<string, string> = {};
        return {
          files: f,
          fs: {
            readFile: async (p) => f[p] ?? '',
            writeFile: async (p, content) => {
              f[p] = content;
            },
            exists: async (p) => p in f,
          },
        };
      }
      const touchedSettings = (f: Record<string, string>): string[] => Object.keys(f).filter((k) => k.endsWith('settings.json'));
      const base = { runner: hudRunner([]), projectRoot: '/project', hudServiceManager: { install: () => ({ success: true, plistPath: '/mock.plist' }) }, browserSetup: readyBrowserSetup([]) };

      it('shows what changes and stops, touching nothing, when the person says no', async () => {
        const { fs, files } = freshFs();
        const out: string[] = [];
        const err: string[] = [];
        const code = await setupCommand(['--hud'], { ...base, fs, stdout: (l) => out.push(l), stderr: (l) => err.push(l), isTTY: true, ask: async () => 'n' });
        expect(code).toBe(1);
        expect(out.join('\n')).toContain('disableAllPrompts');
        expect(out.join('\n')).toContain('rh permissions revert');
        expect(err.join('\n')).toContain('Nothing was changed');
        expect(touchedSettings(files)).toEqual([]);
      });

      it('goes ahead on yes (and on a plain Enter), and records consent', async () => {
        for (const answer of ['y', '']) {
          const { fs, files } = freshFs();
          const asked: string[] = [];
          const code = await setupCommand(['--hud'], { ...base, fs, stdout: () => {}, isTTY: true, ask: async (q) => { asked.push(q); return answer; } });
          expect(code).toBe(0);
          expect(asked.filter((q) => q.includes('Allow this?'))).toHaveLength(1);
          expect(touchedSettings(files).length).toBeGreaterThan(0);
        }
      });

      it('--yes and a missing terminal do not ask', async () => {
        for (const [args, tty] of [[['--hud', '--yes'], true], [['--hud'], false]] as const) {
          const { fs } = freshFs();
          const asked: string[] = [];
          const code = await setupCommand([...args], { ...base, fs, stdout: () => {}, isTTY: tty, ask: async (q) => { asked.push(q); return 'y'; } });
          expect(code).toBe(0);
          expect(asked.filter((q) => q.includes('Allow this?'))).toEqual([]);
        }
      });

      it('does not ask again once the settings are in place', async () => {
        const { fs } = freshFs();
        await setupCommand(['--hud'], { ...base, fs, stdout: () => {}, isTTY: false });
        const asked: string[] = [];
        await setupCommand(['--hud'], { ...base, fs, stdout: () => {}, isTTY: true, ask: async (q) => { asked.push(q); return 'y'; } });
        expect(asked.filter((q) => q.includes('Allow this?'))).toEqual([]);
      });
    });

    it('--hud fails loudly (exit 1) when the hotkey helper cannot be built', async () => {
      if (process.platform !== 'darwin') return;
      const out: string[] = [];
      const code = await setupCommand(['--hud'], {
        stdout: (l) => out.push(l),
        runner: hudRunner([]),
        fs: mockFs,
        projectRoot: '/project',
        hudServiceManager: { install: () => ({ success: true, plistPath: '/mock.plist' }) },
        browserSetup: readyBrowserSetup([]),
        isTTY: false,
        prepareHotkeyHelper: () => ({ ok: false, error: 'needs the Xcode Command Line Tools' }),
      });
      const text = out.join('\n');
      expect(code).toBe(1);
      expect(text).toContain('needs the Xcode Command Line Tools');
      expect(text).not.toContain('Desktop HUD is ready');
    });

    it('asks what to set up on a terminal and defaults to the HUD', async () => {
      const out: string[] = [];
      const asked: string[] = [];
      const answers = ['maybe', ''];
      const code = await setupCommand([], {
        stdout: (l) => out.push(l),
        runner: hudRunner([]),
        fs: mockFs,
        projectRoot: '/project',
        hudServiceManager: { install: () => ({ success: true, plistPath: '/mock.plist' }) },
        browserSetup: readyBrowserSetup([]),
        isTTY: true,
        ask: async (q) => {
          asked.push(q);
          return answers.shift() ?? '';
        },
      });
      expect(code).toBe(0);
      const modeQuestions = asked.filter((q) => q.includes('Choose 1 or 2'));
      expect(modeQuestions).toHaveLength(2);
      expect(out.join('\n')).toContain('Desktop HUD');
      expect(out.join('\n')).toContain('Please type 1 or 2.');
      expect(out.join('\n')).toContain('Desktop HUD is ready');
    });

    it('does not prompt without a terminal and keeps the existing flow', async () => {
      const asked: string[] = [];
      const out: string[] = [];
      const runner: CommandRunner = async (cmd, args) => {
        if (args.includes('whoami')) return { exitCode: 1, stdout: '', stderr: 'not logged in' };
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      await setupCommand([], {
        stdout: (l) => out.push(l),
        stderr: () => {},
        runner,
        fs: mockFs,
        projectRoot: '/project',
        isTTY: false,
        ask: async (q) => {
          asked.push(q);
          return '1';
        },
      }).catch(() => {});
      expect(asked).toEqual([]);
      expect(out.join('\n')).not.toContain('Desktop HUD is ready');
    });

    it('--remote skips the HUD flow', async () => {
      const out: string[] = [];
      const runner: CommandRunner = async (cmd, args) => {
        if (args.includes('whoami')) return { exitCode: 1, stdout: '', stderr: 'not logged in' };
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      await setupCommand(['--remote'], {
        stdout: (l) => out.push(l),
        stderr: () => {},
        runner,
        fs: mockFs,
        projectRoot: '/project',
        isTTY: true,
        ask: async () => '1',
      }).catch(() => {});
      expect(out.join('\n')).not.toContain('Desktop HUD is ready');
    });
  });
});
