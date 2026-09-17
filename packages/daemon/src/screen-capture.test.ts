import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { DefaultFrameSource, cleanupStaleFrameFiles } from './screen-capture.js';

describe('DefaultFrameSource', () => {
  it('reads recent screenshot file when present', async () => {
    const source = new DefaultFrameSource();
    const testPath = '/tmp/rh_screen_frame.jpg';
    const fakeData = Buffer.from('fake-jpeg-image-bytes');
    await fs.promises.writeFile(testPath, fakeData);

    try {
      const frame = await source.captureFrame();
      expect(frame).not.toBeNull();
      expect(frame?.jpegBase64).toContain('data:image/jpeg;base64,');

      const second = await source.captureFrame();
      expect(second).toBeNull();
    } finally {
      await fs.promises.unlink(testPath).catch(() => {});
    }
  });

  it('ignores candidate files modified before task start time', async () => {
    const testPath = '/tmp/rh_screen_frame.jpg';
    const fakeData = Buffer.from('old-stale-image');
    await fs.promises.writeFile(testPath, fakeData);

    try {
      const pastTime = Date.now() - 5000;
      await fs.promises.utimes(testPath, pastTime / 1000, pastTime / 1000);

      const source = new DefaultFrameSource({ taskStartTime: Date.now() });
      const frame = await source.captureFrame();
      expect(frame).toBeNull();
    } finally {
      await fs.promises.unlink(testPath).catch(() => {});
    }
  });

  it('cleans up stale candidate files older than cutoff time', async () => {
    const testPath = '/tmp/rh_screen_frame.png';
    await fs.promises.writeFile(testPath, Buffer.from('stale-frame-content'));

    try {
      const past = Date.now() - 2000;
      await fs.promises.utimes(testPath, past / 1000, past / 1000);

      cleanupStaleFrameFiles(Date.now() - 500);
      expect(fs.existsSync(testPath)).toBe(false);
    } finally {
      await fs.promises.unlink(testPath).catch(() => {});
    }
  });

  it('handles capture without throwing when no sources available', async () => {
    const source = new DefaultFrameSource();
    await expect(source.captureFrame()).resolves.toBeDefined();
  });
});
