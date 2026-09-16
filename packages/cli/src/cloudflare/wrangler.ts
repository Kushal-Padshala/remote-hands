export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string | undefined;
    env?: Record<string, string | undefined> | undefined;
    interactive?: boolean | undefined;
  },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export async function ensureWranglerLogin(runner: CommandRunner): Promise<boolean> {
  const res = await runner('npx', ['wrangler', 'whoami']);
  if (res.exitCode !== 0) return false;
  if (res.stdout.includes('You are not authenticated') || res.stderr.includes('You are not authenticated')) {
    return false;
  }
  return res.stdout.includes('Logged in') || res.stdout.includes('Associated with');
}

export async function loginWrangler(runner: CommandRunner): Promise<boolean> {
  const res = await runner('npx', ['wrangler', 'login'], { interactive: true });
  if (res.exitCode !== 0) return false;
  return await ensureWranglerLogin(runner);
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
