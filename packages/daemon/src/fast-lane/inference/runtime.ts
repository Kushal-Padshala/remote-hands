import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeEntry } from './catalog.js';
import { downloadVerified } from './download.js';

export interface RuntimeDeps {
  download: typeof downloadVerified;
  extract: (archive: string, dir: string) => Promise<void>;
}

export interface EnsureRuntimeOptions {
  homeDir: string;
  onProgress?: ((done: number, total: number) => void) | undefined;
  deps?: Partial<RuntimeDeps> | undefined;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed (${code}): ${stderr.trim().split('\n')[0] ?? ''}`));
    });
  });
}

/** Rejects archives that would write outside the target directory. */
export function assertSafeTarListing(listing: string): void {
  for (const entry of listing.split('\n')) {
    if (entry === '') continue;
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error(`unsafe path in runtime archive: ${entry}`);
    }
  }
}

export async function extractTarGz(archive: string, dir: string): Promise<void> {
  assertSafeTarListing(await run('tar', ['-tzf', archive]));
  await run('tar', ['-xzf', archive, '-C', dir]);
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Installs the pinned llama-server build under ~/.remote-hands/fast-lane/runtime and returns its path. */
export async function ensureRuntime(entry: RuntimeEntry, opts: EnsureRuntimeOptions): Promise<{ serverPath: string }> {
  const download = opts.deps?.download ?? downloadVerified;
  const extract = opts.deps?.extract ?? extractTarGz;
  const dir = path.join(opts.homeDir, '.remote-hands', 'fast-lane', 'runtime', `${entry.build}-${entry.platform}`);
  const serverPath = path.join(dir, entry.archiveDir, 'llama-server');
  if (isExecutable(serverPath)) return { serverPath };

  fs.mkdirSync(dir, { recursive: true });
  const archive = await download({
    url: entry.url,
    destination: path.join(dir, path.basename(new URL(entry.url).pathname)),
    sha256: entry.sha256,
    bytes: entry.bytes,
    onProgress: opts.onProgress,
  });
  await extract(archive, dir);
  if (!fs.existsSync(serverPath)) throw new Error('llama-server missing from runtime archive');
  fs.chmodSync(serverPath, 0o755);
  return { serverPath };
}
