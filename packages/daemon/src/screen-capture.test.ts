import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { DefaultFrameSource } from './screen-capture.js';

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

  it('handles capture without throwing when no sources available', async () => {
    const source = new DefaultFrameSource();
    await expect(source.captureFrame()).resolves.toBeDefined();
  });
});
