import { describe, expect, it } from 'vitest';
import { getRuntimeMetadata } from './runtime.js';

describe('getRuntimeMetadata', () => {
  it('returns injected runtime values without reading global state', () => {
    expect(
      getRuntimeMetadata({
        hostname: () => 'test-host',
        daemonVersion: '0.0.7',
        agyVersion: 'agy 1.2.4',
      }),
    ).toEqual({
      hostname: 'test-host',
      daemonVersion: '0.0.7',
      agyVersion: 'agy 1.2.4',
    });
  });

  it('uses null when agy version has not been probed yet', () => {
    expect(
      getRuntimeMetadata({
        hostname: () => 'test-host',
        daemonVersion: '0.0.7',
      }).agyVersion,
    ).toBeNull();
  });
});

