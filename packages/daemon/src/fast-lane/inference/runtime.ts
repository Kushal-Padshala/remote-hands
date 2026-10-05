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

const MARKER = '.complete';

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function runtimeDir(homeDir: string, entry: RuntimeEntry): string {
  return path.join(homeDir, '.remote-hands', 'fast-lane', 'runtime', `${entry.build}-${entry.platform}`);
}

export function runtimeServerPath(homeDir: string, entry: RuntimeEntry): string {
  return path.join(runtimeDir(homeDir, entry), entry.archiveDir, 'llama-server');
}

/**
 * True only for a finished install: the server binary exists AND the completion marker written
 * after extraction is present. A run that died mid-extraction leaves a binary without its
 * libraries next to it, which must never count as installed.
 */
export function isRuntimeInstalled(homeDir: string, entry: RuntimeEntry): boolean {
  return isExecutable(runtimeServerPath(homeDir, entry)) && fs.existsSync(path.join(runtimeDir(homeDir, entry), MARKER));
}

/** Installs the pinned llama-server build under ~/.remote-hands/fast-lane/runtime and returns its path. */
export async function ensureRuntime(entry: RuntimeEntry, opts: EnsureRuntimeOptions): Promise<{ serverPath: string }> {
  const download = opts.deps?.download ?? downloadVerified;
  const extract = opts.deps?.extract ?? extractTarGz;
  const dir = runtimeDir(opts.homeDir, entry);
  const serverPath = runtimeServerPath(opts.homeDir, entry);
  if (isRuntimeInstalled(opts.homeDir, entry)) return { serverPath };

  fs.mkdirSync(dir, { recursive: true });
  const archive = await download({
    url: entry.url,
    destination: path.join(dir, path.basename(new URL(entry.url).pathname)),
    sha256: entry.sha256,
    bytes: entry.bytes,
    onProgress: opts.onProgress,
  });
  // Start from a clean directory: leftovers of an interrupted extraction must not mix with the new files.
  fs.rmSync(path.join(dir, entry.archiveDir), { recursive: true, force: true });
  fs.rmSync(path.join(dir, MARKER), { force: true });
  await extract(archive, dir);
  if (!fs.existsSync(serverPath)) throw new Error('llama-server missing from runtime archive');
  fs.chmodSync(serverPath, 0o755);
  fs.writeFileSync(path.join(dir, MARKER), entry.build);
  return { serverPath };
}
