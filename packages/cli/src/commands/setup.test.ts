import { describe, expect, it, vi } from 'vitest';
import { setupCommand } from './setup.js';
import type { CommandRunner } from '../cloudflare/wrangler.js';
import type { FileSystemAdapter } from '../cloudflare/project.js';

describe('Setup Command Flow', () => {
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
});
