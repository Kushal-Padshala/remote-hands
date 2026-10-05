import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export interface DownloadRequest {
  url: string;
  destination: string;
  sha256: string;
  bytes: number;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface DownloadDeps {
  fetch: typeof fetch;
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function matches(file: string, bytes: number, sha256: string): Promise<boolean> {
  if (fs.statSync(file).size !== bytes) return false;
  return (await hashFile(file)) === sha256;
}

function removeIfExists(file: string): void {
  fs.rmSync(file, { force: true });
}

/**
 * Downloads `url` to `destination`, resuming a `.partial` file when one exists, and only moves the
 * file into place after the size and sha256 both match. A corrupt download is deleted, never used.
 */
export async function downloadVerified(req: DownloadRequest, deps: Partial<DownloadDeps> = {}): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const { destination, bytes, sha256, onProgress } = req;
  const partial = `${destination}.partial`;
  const base = path.basename(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  if (fs.existsSync(destination)) {
    if (await matches(destination, bytes, sha256)) {
      onProgress?.(bytes, bytes);
      return destination;
    }
    removeIfExists(destination);
  }

  let offset = 0;
  if (fs.existsSync(partial)) {
    const size = fs.statSync(partial).size;
    if (size > bytes) removeIfExists(partial);
    else offset = size;
  }

  if (offset < bytes) {
    let res = await doFetch(req.url, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} });
    if (res.status === 416 && offset > 0) {
      removeIfExists(partial);
      offset = 0;
      res = await doFetch(req.url, { headers: {} });
    }
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    if (res.status === 200) offset = 0; // the server ignored Range: start over
    if (res.body === null) throw new Error('download failed (empty response)');

    const out = fs.createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w' });
    let done = offset;
    try {
      for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve));
        done += chunk.length;
        onProgress?.(done, bytes);
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
  }

  const size = fs.statSync(partial).size;
  if (size !== bytes) {
    removeIfExists(partial);
    throw new Error(`size mismatch for ${base} (got ${size} bytes, expected ${bytes})`);
  }
  if ((await hashFile(partial)) !== sha256) {
    removeIfExists(partial);
    throw new Error(`checksum mismatch for ${base}`);
  }
  fs.renameSync(partial, destination);
  onProgress?.(bytes, bytes);
  return destination;
}
