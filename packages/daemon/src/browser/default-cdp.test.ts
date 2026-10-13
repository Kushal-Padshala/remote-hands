import { describe, expect, it } from 'vitest';
import { cdpTargetFromEnv } from './default-cdp.js';

describe('cdpTargetFromEnv', () => {
  it('defaults to the local port 9222', () => {
    expect(cdpTargetFromEnv({})).toEqual({ host: '127.0.0.1', port: 9222, local: true });
  });
  it('reads host and port, and only treats this computer as local', () => {
    expect(cdpTargetFromEnv({ BU_CDP_URL: 'http://127.0.0.1:9333' })).toEqual({ host: '127.0.0.1', port: 9333, local: true });
    expect(cdpTargetFromEnv({ BU_CDP_URL: 'http://localhost:9444' })).toMatchObject({ port: 9444, local: true });
    expect(cdpTargetFromEnv({ BU_CDP_URL: 'http://192.168.1.5:9222' })).toEqual({ host: '192.168.1.5', port: 9222, local: false });
  });
  it('falls back for anything it cannot read', () => {
    for (const bad of ['not a url', 'http://127.0.0.1:99999', 'http://127.0.0.1:0']) {
      expect(cdpTargetFromEnv({ BU_CDP_URL: bad })).toEqual({ host: '127.0.0.1', port: 9222, local: true });
    }
  });
});
