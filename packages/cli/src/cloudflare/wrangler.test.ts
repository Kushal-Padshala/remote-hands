import { describe, expect, it, vi } from 'vitest';
import {
  ensureWranglerLogin,
  waitForWranglerLogin,
  createD1Database,
  createR2Bucket,
  deployWorker,
  deployWebApp,
  type CommandRunner,
} from './wrangler.js';
import { writeWranglerConfig, type FileSystemAdapter } from './project.js';

describe('Wrangler Automation', () => {
  it('checks wrangler login status', async () => {
    const executed: Array<{ cmd: string; args: string[] }> = [];

    const fakeRunner: CommandRunner = async (cmd, args) => {
      executed.push({ cmd, args });
      return { exitCode: 0, stdout: 'Logged in as test@example.com', stderr: '' };
    };

    const loggedIn = await ensureWranglerLogin(fakeRunner);
    expect(loggedIn).toBe(true);
    expect(executed[0]).toEqual({ cmd: 'npx', args: ['wrangler', 'whoami'] });
  });

  it('checks wrangler login status case-insensitively with real oauth message', async () => {
    const fakeRunner: CommandRunner = async () => {
      return {
        exitCode: 0,
        stdout: '👋 You are logged in with an OAuth Token, associated with the email user@example.com.',
        stderr: '',
      };
    };

    const loggedIn = await ensureWranglerLogin(fakeRunner);
    expect(loggedIn).toBe(true);
  });

  it('polls until login is detected in waitForWranglerLogin', async () => {
    let attempts = 0;
    const fakeRunner: CommandRunner = async () => {
      attempts++;
      if (attempts < 3) {
        return { exitCode: 0, stdout: 'You are not authenticated.', stderr: '' };
      }
      return { exitCode: 0, stdout: 'You are logged in with an OAuth Token', stderr: '' };
    };

    const loggedIn = await waitForWranglerLogin(fakeRunner, 5000, 10);
    expect(loggedIn).toBe(true);
    expect(attempts).toBe(3);
  });

  it('detects unauthenticated wrangler status', async () => {
    const fakeRunner: CommandRunner = async () => {
      return {
        exitCode: 0,
        stdout: 'You are not authenticated. Please run `wrangler login`.',
        stderr: '',
      };
    };

    const loggedIn = await ensureWranglerLogin(fakeRunner);
    expect(loggedIn).toBe(false);
  });

  it('creates d1 database and extracts database_id', async () => {
    const executed: Array<{ cmd: string; args: string[] }> = [];

    const fakeRunner: CommandRunner = async (cmd, args) => {
      executed.push({ cmd, args });
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          database_name: 'remote-hands-db',
          database_id: 'd1-uuid-12345',
        }),
        stderr: '',
      };
    };

    const result = await createD1Database('remote-hands-db', fakeRunner);
    expect(result.databaseId).toBe('d1-uuid-12345');
    expect(result.databaseName).toBe('remote-hands-db');
    expect(executed[0]).toEqual({
      cmd: 'npx',
      args: ['wrangler', 'd1', 'create', 'remote-hands-db'],
    });
  });

  it('creates r2 bucket', async () => {
    const executed: Array<{ cmd: string; args: string[] }> = [];

    const fakeRunner: CommandRunner = async (cmd, args) => {
      executed.push({ cmd, args });
      return { exitCode: 0, stdout: 'Created bucket remote-hands-frames', stderr: '' };
    };

    const result = await createR2Bucket('remote-hands-frames', fakeRunner);
    expect(result.bucketName).toBe('remote-hands-frames');
    expect(executed[0]).toEqual({
      cmd: 'npx',
      args: ['wrangler', 'r2', 'bucket', 'create', 'remote-hands-frames'],
    });
  });

  it('updates wrangler.jsonc config with new database id', async () => {
    const files: Record<string, string> = {
      '/app/wrangler.jsonc': `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "remote-hands-db",
      "database_id": "placeholder"
    }
  ]
}`,
    };

    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => p in files,
    };

    await writeWranglerConfig(
      '/app/wrangler.jsonc',
      { dbId: 'real-d1-uuid-67890', dbName: 'remote-hands-db' },
      mockFs,
    );

    expect(files['/app/wrangler.jsonc']).toContain('real-d1-uuid-67890');
  });

  it('runs worker and pages deploy', async () => {
    const executed: Array<{ cmd: string; args: string[]; cwd?: string }> = [];

    const fakeRunner: CommandRunner = async (cmd, args, opts) => {
      executed.push({ cmd, args, cwd: opts?.cwd });
      return {
        exitCode: 0,
        stdout: 'Deployed to https://remote-hands.example.workers.dev',
        stderr: '',
      };
    };

    const workerRes = await deployWorker(fakeRunner, '/apps/cloudflare');
    expect(workerRes.deploymentUrl).toBe('https://remote-hands.example.workers.dev');
    expect(executed[0]?.cmd).toBe('npx');
    expect(executed[0]?.args).toEqual(['wrangler', 'deploy']);

    const webRes = await deployWebApp(fakeRunner, '/apps/web');
    expect(webRes.pagesUrl).toBe('https://remote-hands.example.workers.dev');
    expect(executed[1]?.args).toContain('pages');
  });

  it('falls back to wrangler deploy when pages deploy fails', async () => {
    const executed: Array<{ cmd: string; args: string[]; cwd?: string }> = [];

    const fakeRunner: CommandRunner = async (cmd, args, opts) => {
      executed.push({ cmd, args, cwd: opts?.cwd });
      if (args.includes('pages')) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'The Pages project remote-hands-web does not exist.',
        };
      }
      return {
        exitCode: 0,
        stdout: 'Deployed to https://remote-hands-web.example.workers.dev',
        stderr: '',
      };
    };

    const webRes = await deployWebApp(fakeRunner, '/apps/web');
    expect(webRes.pagesUrl).toBe('https://remote-hands-web.example.workers.dev');
    expect(executed.some((e) => e.args.includes('pages'))).toBe(true);
    expect(executed.some((e) => e.args[0] === 'wrangler' && e.args[1] === 'deploy')).toBe(true);
  });
});
