import { spawn } from 'node:child_process';

export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string | undefined;
    env?: Record<string, string | undefined> | undefined;
    interactive?: boolean | undefined;
  },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultRunner: CommandRunner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    const isInteractive = options?.interactive === true;
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      shell: true,
      stdio: isInteractive ? 'inherit' : undefined,
    });
    let stdout = '';
    let stderr = '';
    if (!isInteractive) {
      proc.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
    }
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
    proc.on('error', reject);
  });
};

export async function ensureWranglerLogin(runner: CommandRunner): Promise<boolean> {
  const res = await runner('npx', ['wrangler', 'whoami']);
  if (res.exitCode !== 0) return false;
  const combined = (res.stdout + '\n' + res.stderr).toLowerCase();
  if (combined.includes('you are not authenticated')) {
    return false;
  }
  return (
    combined.includes('logged in') ||
    combined.includes('associated with') ||
    combined.includes('oauth token') ||
    combined.includes('account id')
  );
}

export async function loginWrangler(runner: CommandRunner): Promise<boolean> {
  const res = await runner('npx', ['wrangler', 'login'], { interactive: true });
  return res.exitCode === 0;
}

export async function waitForWranglerLogin(
  runner: CommandRunner,
  timeoutMs: number = 60_000,
  intervalMs: number = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await ensureWranglerLogin(runner);
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function createD1Database(
  dbName: string,
  runner: CommandRunner,
): Promise<{ databaseId: string; databaseName: string }> {
  const res = await runner('npx', ['wrangler', 'd1', 'create', dbName]);
  if (res.exitCode !== 0) {
    if (res.stderr?.includes('already exists') || res.stdout?.includes('already exists')) {
      const listRes = await runner('npx', ['wrangler', 'd1', 'list', '--json']);
      if (listRes.exitCode === 0) {
        try {
          const list = JSON.parse(listRes.stdout);
          const found = list.find((item: any) => item.name === dbName);
          if (found?.uuid) {
            return { databaseId: found.uuid, databaseName: dbName };
          }
        } catch {}
      }
    }
    throw new Error(`Failed to create D1 database: ${res.stderr || res.stdout}`);
  }

  let dbId = '';
  try {
    const parsed = JSON.parse(res.stdout);
    dbId = parsed.database_id ?? parsed.uuid ?? '';
  } catch {
    const match = res.stdout.match(/database_id\s*=\s*"([^"]+)"/) || res.stdout.match(/([a-f0-9-]{36})/);
    if (match) dbId = match[1]!;
  }

  if (!dbId) {
    throw new Error(`Could not parse database_id from output: ${res.stdout}`);
  }

  return {
    databaseId: dbId,
    databaseName: dbName,
  };
}

export async function applyD1Migrations(
  dbName: string,
  runner: CommandRunner,
  cwd?: string,
): Promise<void> {
  const res = await runner('npx', ['wrangler', 'd1', 'migrations', 'apply', dbName, '--remote'], {
    cwd,
  });
  if (res.exitCode !== 0) {
    throw new Error(`Failed to apply D1 migrations: ${res.stderr || res.stdout}`);
  }
}

export async function createR2Bucket(
  bucketName: string,
  runner: CommandRunner,
): Promise<{ bucketName: string }> {
  const res = await runner('npx', ['wrangler', 'r2', 'bucket', 'create', bucketName]);
  if (res.exitCode !== 0 && !res.stdout.includes('already exists') && !res.stderr.includes('already exists')) {
    throw new Error(`Failed to create R2 bucket: ${res.stderr || res.stdout}`);
  }

  return { bucketName };
}

export async function deployWorker(
  runner: CommandRunner,
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<{ deploymentUrl?: string | undefined }> {
  const res = await runner('npx', ['wrangler', 'deploy'], { cwd, env });
  if (res.exitCode !== 0) {
    throw new Error(`Failed to deploy worker: ${res.stderr || res.stdout}`);
  }

  const match = res.stdout.match(/https:\/\/[a-zA-Z0-9_.-]+\.workers\.dev/);
  return {
    deploymentUrl: match ? match[0] : undefined,
  };
}

export async function deployWebApp(
  runner: CommandRunner,
  cwd: string,
): Promise<{ pagesUrl?: string | undefined }> {
  const res = await runner(
    'npx',
    ['wrangler', 'pages', 'deploy', 'dist', '--project-name', 'remote-hands-web'],
    { cwd },
  );
  if (res.exitCode !== 0) {
    throw new Error(`Failed to deploy web app: ${res.stderr || res.stdout}`);
  }

  const match = res.stdout.match(/https:\/\/[a-zA-Z0-9_.-]+\.(pages\.dev|workers\.dev)/);
  return {
    pagesUrl: match ? match[0] : undefined,
  };
}
