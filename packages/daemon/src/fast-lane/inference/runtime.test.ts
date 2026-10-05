import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIMES } from './catalog.js';
import { assertSafeTarListing, ensureRuntime, extractTarGz, isRuntimeInstalled } from './runtime.js';

const entry = RUNTIMES.find((r) => r.platform === 'darwin-arm64')!;
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-rt-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const installDir = () => path.join(home, '.remote-hands', 'fast-lane', 'runtime', `${entry.build}-${entry.platform}`);
const serverPath = () => path.join(installDir(), entry.archiveDir, 'llama-server');

function fakeExtract(createServer = true) {
  return vi.fn(async (_archive: string, dir: string) => {
    if (createServer) {
      fs.mkdirSync(path.join(dir, entry.archiveDir), { recursive: true });
      fs.writeFileSync(path.join(dir, entry.archiveDir, 'llama-server'), '#!/bin/sh\n');
    }
  });
}

describe('ensureRuntime', () => {
  it('downloads the pinned archive, extracts it and returns an executable server path', async () => {
    const download = vi.fn(async (req: { destination: string }) => req.destination);
    const extract = fakeExtract();
    const { serverPath: out } = await ensureRuntime(entry, { homeDir: home, deps: { download: download as any, extract } });
    expect(out).toBe(serverPath());
    expect(download).toHaveBeenCalledTimes(1);
    const req = download.mock.calls[0]![0] as any;
    expect(req.url).toBe(entry.url);
    expect(req.sha256).toBe(entry.sha256);
    expect(req.bytes).toBe(entry.bytes);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fs.statSync(out).mode & 0o111).not.toBe(0);
  });

  it('does nothing when the server is already installed', async () => {
    fs.mkdirSync(path.dirname(serverPath()), { recursive: true });
    fs.writeFileSync(serverPath(), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(installDir(), '.complete'), entry.build);
    const download = vi.fn();
    const extract = fakeExtract();
    const { serverPath: out } = await ensureRuntime(entry, { homeDir: home, deps: { download: download as any, extract } });
    expect(out).toBe(serverPath());
    expect(download).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it('writes a completion marker only after a successful install', async () => {
    const download = vi.fn(async (req: { destination: string }) => req.destination);
    expect(isRuntimeInstalled(home, entry)).toBe(false);
    await ensureRuntime(entry, { homeDir: home, deps: { download: download as any, extract: fakeExtract() } });
    expect(fs.existsSync(path.join(installDir(), '.complete'))).toBe(true);
    expect(isRuntimeInstalled(home, entry)).toBe(true);
  });

  it('does not write the marker when extraction fails', async () => {
    const download = vi.fn(async (req: { destination: string }) => req.destination);
    const extract = vi.fn(async () => {
      throw new Error('tar failed');
    });
    await expect(ensureRuntime(entry, { homeDir: home, deps: { download: download as any, extract } })).rejects.toThrow('tar failed');
    expect(isRuntimeInstalled(home, entry)).toBe(false);
  });

  it('treats a server binary without the marker as a broken install and extracts again over a clean directory', async () => {
    // A previous run died after llama-server was written but before the libraries next to it.
    fs.mkdirSync(path.dirname(serverPath()), { recursive: true });
    fs.writeFileSync(serverPath(), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(path.dirname(serverPath()), 'stale-leftover.dylib'), 'old');
    expect(isRuntimeInstalled(home, entry)).toBe(false);
    const download = vi.fn(async (req: { destination: string }) => req.destination);
    const extract = fakeExtract();
    await ensureRuntime(entry, { homeDir: home, deps: { download: download as any, extract } });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(path.dirname(serverPath()), 'stale-leftover.dylib'))).toBe(false);
    expect(isRuntimeInstalled(home, entry)).toBe(true);
  });

  it('throws when the archive did not contain llama-server', async () => {
    const download = vi.fn(async (req: { destination: string }) => req.destination);
    await expect(
      ensureRuntime(entry, { homeDir: home, deps: { download: download as any, extract: fakeExtract(false) } }),
    ).rejects.toThrow('llama-server missing from runtime archive');
  });

  it('passes download progress through', async () => {
    const download = vi.fn(async (req: { destination: string; onProgress?: (d: number, t: number) => void }) => {
      req.onProgress?.(5, 10);
      return req.destination;
    });
    const seen: Array<[number, number]> = [];
    await ensureRuntime(entry, {
      homeDir: home,
      onProgress: (d, t) => seen.push([d, t]),
      deps: { download: download as any, extract: fakeExtract() },
    });
    expect(seen).toEqual([[5, 10]]);
  });
});

describe('assertSafeTarListing', () => {
  it('accepts ordinary relative paths', () => {
    expect(() => assertSafeTarListing('llama-b1/\nllama-b1/llama-server\nllama-b1/lib/libggml.dylib\n')).not.toThrow();
  });

  it('rejects parent-directory traversal and absolute paths', () => {
    expect(() => assertSafeTarListing('ok/file\n../evil\n')).toThrow('unsafe path');
    expect(() => assertSafeTarListing('ok/../../evil\n')).toThrow('unsafe path');
    expect(() => assertSafeTarListing('/etc/passwd\n')).toThrow('unsafe path');
  });
});

describe('extractTarGz (real tar, temp dir only)', () => {
  it('extracts a real archive into the target directory', async () => {
    const src = path.join(home, 'src', 'pkg');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'llama-server'), 'binary');
    const archive = path.join(home, 'a.tar.gz');
    expect(spawnSync('tar', ['-czf', archive, '-C', path.join(home, 'src'), 'pkg']).status).toBe(0);
    const out = path.join(home, 'out');
    fs.mkdirSync(out);
    await extractTarGz(archive, out);
    expect(fs.readFileSync(path.join(out, 'pkg', 'llama-server'), 'utf8')).toBe('binary');
  });

  it('rejects a corrupt archive', async () => {
    const archive = path.join(home, 'bad.tar.gz');
    fs.writeFileSync(archive, 'not a tarball');
    const out = path.join(home, 'out2');
    fs.mkdirSync(out);
    await expect(extractTarGz(archive, out)).rejects.toThrow();
  });
});
