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
            pairing_code: 'PAIR-123456',
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
    expect(fullOutput).toContain('PAIR-123456');
    expect(fullOutput).toContain('https://remote-hands-web.pages.dev');
    expect(fullOutput).toContain('remote-hands daemon');

    expect(fullOutput).not.toContain('super-secret');
    expect(fullOutput).not.toContain('OWNER_SECRET_HASH');
  });
});
