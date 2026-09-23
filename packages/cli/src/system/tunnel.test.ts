import { describe, expect, it, vi } from 'vitest';
import { findCloudflaredBinary, startQuickTunnel } from './tunnel.js';

describe('tunnel', () => {
  it('finds cloudflared binary or returns null safely', () => {
    const bin = findCloudflaredBinary();
    expect(bin === null || typeof bin === 'string').toBe(true);
  });

  it('handles startQuickTunnel failure gracefully when binary is invalid', async () => {
    const result = await startQuickTunnel(9999, {
      binPath: '/nonexistent/path/to/binary',
      timeoutMs: 100,
    });
    expect(result).toBeNull();
  });
});
