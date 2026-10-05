import { describe, it, expect } from 'vitest';
import { assessCapability, detectHardware } from './hardware.js';

const GB = 2 ** 30;

describe('detectHardware', () => {
  it('reads platform, arch and memory from the injected os module', () => {
    const hw = detectHardware({ platform: () => 'darwin', arch: () => 'arm64', totalmem: () => 16 * GB });
    expect(hw).toEqual({ platform: 'darwin', arch: 'arm64', totalRamBytes: 16 * GB });
  });
});

describe('assessCapability', () => {
  it('supports a 16GB Apple Silicon Mac with the standard model and arm64 runtime', () => {
    const cap = assessCapability({ platform: 'darwin', arch: 'arm64', totalRamBytes: 16 * GB });
    expect(cap.supported).toBe(true);
    expect(cap.model?.tier).toBe('standard');
    expect(cap.runtime?.platform).toBe('darwin-arm64');
    expect(cap.reason).toBeUndefined();
  });

  it('supports an 8GB Mac with the lite model', () => {
    const cap = assessCapability({ platform: 'darwin', arch: 'arm64', totalRamBytes: 8 * GB });
    expect(cap.supported).toBe(true);
    expect(cap.model?.tier).toBe('lite');
  });

  it('reports not enough memory below 8GB', () => {
    const cap = assessCapability({ platform: 'darwin', arch: 'arm64', totalRamBytes: 4 * GB });
    expect(cap.supported).toBe(false);
    expect(cap.reason).toMatch(/memory/i);
    expect(cap.model).toBeNull();
  });

  it('reports an unsupported platform', () => {
    const cap = assessCapability({ platform: 'linux', arch: 'x64', totalRamBytes: 32 * GB });
    expect(cap.supported).toBe(false);
    expect(cap.reason).toMatch(/platform/i);
    expect(cap.runtime).toBeNull();
  });

  it('reports an unsupported platform before memory when both fail', () => {
    const cap = assessCapability({ platform: 'win32', arch: 'x64', totalRamBytes: 2 * GB });
    expect(cap.supported).toBe(false);
    expect(cap.reason).toMatch(/platform/i);
  });
});
