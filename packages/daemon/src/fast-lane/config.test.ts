import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fastLaneConfigPath, readFastLaneConfig, writeFastLaneConfig } from './config.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-flc-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('fast lane config', () => {
  it('is off by default', () => {
    expect(readFastLaneConfig(home, {})).toEqual({ enabled: false });
  });

  it('reads the file', () => {
    writeFastLaneConfig(home, { enabled: true, tier: 'lite' });
    expect(readFastLaneConfig(home, {})).toEqual({ enabled: true, tier: 'lite' });
    expect(fastLaneConfigPath(home)).toBe(path.join(home, '.remote-hands', 'fast-lane', 'config.json'));
  });

  it('merges a patch and keeps the rest', () => {
    writeFastLaneConfig(home, { enabled: true, tier: 'standard' });
    writeFastLaneConfig(home, { enabled: false });
    expect(readFastLaneConfig(home, {})).toEqual({ enabled: false, tier: 'standard' });
  });

  it('lets RH_FAST_LANE override the file in both directions', () => {
    writeFastLaneConfig(home, { enabled: true });
    expect(readFastLaneConfig(home, { RH_FAST_LANE: '0' }).enabled).toBe(false);
    expect(readFastLaneConfig(home, { RH_FAST_LANE: 'off' }).enabled).toBe(false);
    writeFastLaneConfig(home, { enabled: false });
    expect(readFastLaneConfig(home, { RH_FAST_LANE: '1' }).enabled).toBe(true);
    expect(readFastLaneConfig(home, { RH_FAST_LANE: 'true' }).enabled).toBe(true);
    expect(readFastLaneConfig(home, { RH_FAST_LANE: 'maybe' }).enabled).toBe(false);
  });

  it('ignores a corrupt or wrongly shaped file', () => {
    fs.mkdirSync(path.dirname(fastLaneConfigPath(home)), { recursive: true });
    fs.writeFileSync(fastLaneConfigPath(home), '{not json');
    expect(readFastLaneConfig(home, {})).toEqual({ enabled: false });
    fs.writeFileSync(fastLaneConfigPath(home), JSON.stringify({ enabled: 'yes', tier: 'huge' }));
    expect(readFastLaneConfig(home, {})).toEqual({ enabled: false });
    fs.writeFileSync(fastLaneConfigPath(home), 'null');
    expect(readFastLaneConfig(home, {})).toEqual({ enabled: false });
  });

  it('writes atomically and leaves no temp files', () => {
    writeFastLaneConfig(home, { enabled: true });
    expect(fs.readdirSync(path.dirname(fastLaneConfigPath(home)))).toEqual(['config.json']);
  });
});
