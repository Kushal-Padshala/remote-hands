import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadVerified } from './download.js';

const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');
const CONTENT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'.repeat(50)); // 1800 bytes

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-dl-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(content: Buffer, opts: { honorRange?: boolean; status?: number } = {}) {
  const honorRange = opts.honorRange ?? true;
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (opts.status && opts.status !== 200) return new Response('nope', { status: opts.status });
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    if (range && honorRange) {
      const start = Number(/bytes=(\d+)-/.exec(range)![1]);
      return new Response(content.subarray(start), { status: 206 });
    }
    return new Response(content, { status: 200 });
  });
}

const req = (extra: Partial<Parameters<typeof downloadVerified>[0]> = {}) => ({
  url: 'https://example.test/model.gguf',
  destination: path.join(dir, 'model.gguf'),
  sha256: sha(CONTENT),
  bytes: CONTENT.length,
  ...extra,
});

describe('downloadVerified', () => {
  it('downloads, verifies, renames and reports progress up to the total', async () => {
    const fetch = fakeFetch(CONTENT);
    const progress: Array<[number, number]> = [];
    const out = await downloadVerified(req({ onProgress: (d, t) => progress.push([d, t]) }), { fetch: fetch as any });
    expect(out).toBe(path.join(dir, 'model.gguf'));
    expect(fs.readFileSync(out).equals(CONTENT)).toBe(true);
    expect(fs.existsSync(`${out}.partial`)).toBe(false);
    expect(progress.at(-1)).toEqual([CONTENT.length, CONTENT.length]);
  });

  it('does nothing when a verified file already exists', async () => {
    fs.writeFileSync(path.join(dir, 'model.gguf'), CONTENT);
    const fetch = fakeFetch(CONTENT);
    await downloadVerified(req(), { fetch: fetch as any });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('re-downloads when the existing file has the wrong content', async () => {
    fs.writeFileSync(path.join(dir, 'model.gguf'), Buffer.alloc(CONTENT.length, 1));
    const fetch = fakeFetch(CONTENT);
    await downloadVerified(req(), { fetch: fetch as any });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(dir, 'model.gguf')).equals(CONTENT)).toBe(true);
  });

  it('resumes from a partial file with a Range request', async () => {
    fs.writeFileSync(path.join(dir, 'model.gguf.partial'), CONTENT.subarray(0, 700));
    const fetch = fakeFetch(CONTENT);
    await downloadVerified(req(), { fetch: fetch as any });
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).Range).toBe('bytes=700-');
    expect(fs.readFileSync(path.join(dir, 'model.gguf')).equals(CONTENT)).toBe(true);
  });

  it('restarts from zero when the server ignores the Range request', async () => {
    fs.writeFileSync(path.join(dir, 'model.gguf.partial'), CONTENT.subarray(0, 700));
    const fetch = fakeFetch(CONTENT, { honorRange: false });
    await downloadVerified(req(), { fetch: fetch as any });
    expect(fs.readFileSync(path.join(dir, 'model.gguf')).equals(CONTENT)).toBe(true);
  });

  it('deletes the partial and throws on a checksum mismatch', async () => {
    const fetch = fakeFetch(CONTENT);
    await expect(downloadVerified(req({ sha256: sha('something else') }), { fetch: fetch as any })).rejects.toThrow(
      'checksum mismatch for model.gguf',
    );
    expect(fs.existsSync(path.join(dir, 'model.gguf.partial'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'model.gguf'))).toBe(false);
  });

  it('deletes the partial and throws when the size is wrong', async () => {
    const fetch = fakeFetch(CONTENT.subarray(0, 900));
    await expect(downloadVerified(req(), { fetch: fetch as any })).rejects.toThrow('size mismatch');
    expect(fs.existsSync(path.join(dir, 'model.gguf.partial'))).toBe(false);
  });

  it('throws with the HTTP status on a failed request', async () => {
    const fetch = fakeFetch(CONTENT, { status: 404 });
    await expect(downloadVerified(req(), { fetch: fetch as any })).rejects.toThrow('HTTP 404');
  });

  it('keeps the partial file when the connection drops so a later call can resume', async () => {
    const dropping = vi.fn(async () => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          // A real connection delivers some bytes, then drops.
          if (pulls++ === 0) controller.enqueue(CONTENT.subarray(0, 500));
          else controller.error(new Error('connection reset'));
        },
      });
      return new Response(body, { status: 200 });
    });
    await expect(downloadVerified(req(), { fetch: dropping as any })).rejects.toThrow('connection reset');
    expect(fs.statSync(path.join(dir, 'model.gguf.partial')).size).toBe(500);
  });

  it('restarts when the partial is larger than the expected size', async () => {
    fs.writeFileSync(path.join(dir, 'model.gguf.partial'), Buffer.alloc(CONTENT.length + 10, 7));
    const fetch = fakeFetch(CONTENT);
    await downloadVerified(req(), { fetch: fetch as any });
    expect(fs.readFileSync(path.join(dir, 'model.gguf')).equals(CONTENT)).toBe(true);
    expect(fetch.mock.calls[0]![1]!.headers).toEqual({});
  });
});
