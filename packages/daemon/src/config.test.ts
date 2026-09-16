import { describe, expect, it } from 'vitest';
import { parseDaemonConfig } from './config.js';

const validEnv = {
  REMOTE_HANDS_SUPABASE_URL: 'https://example.supabase.co',
  REMOTE_HANDS_SUPABASE_ANON_KEY: 'anon-key',
  REMOTE_HANDS_MACHINE_NAME: 'office-mac',
} satisfies Record<string, string>;

describe('parseDaemonConfig', () => {
  it('uses safe defaults for optional daemon settings', () => {
    const config = parseDaemonConfig(validEnv);

    expect(config.agyCommand).toBe('agy');
    expect(config.pollIntervalMs).toBe(5_000);
    expect(config.heartbeatIntervalMs).toBe(15_000);
    expect(config.workspaceAllowlist).toEqual([]);
  });

  it('requires a Supabase URL', () => {
    expect(() => parseDaemonConfig({})).toThrow(/REMOTE_HANDS_SUPABASE_URL/);
  });

  it('rejects non-positive polling intervals', () => {
    expect(() =>
      parseDaemonConfig({ ...validEnv, REMOTE_HANDS_POLL_INTERVAL_MS: '0' }),
    ).toThrow(/positive/);
  });

  it('parses workspace allowlist entries from a colon-delimited value', () => {
    const config = parseDaemonConfig({
      ...validEnv,
      REMOTE_HANDS_WORKSPACE_ALLOWLIST: '/Users/kushal/project:/tmp/work',
    });

    expect(config.workspaceAllowlist).toEqual(['/Users/kushal/project', '/tmp/work']);
  });
});

