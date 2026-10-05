import { describe, it, expect } from 'vitest';
import { MODELS, RUNTIMES, modelUrl, pickModel, pickRuntime } from './catalog.js';

const GB = 2 ** 30;

describe('pickModel', () => {
  it('uses the standard 4B model from 16GB up', () => {
    expect(pickModel(16 * GB)?.file).toBe('Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
    expect(pickModel(17_179_869_184)?.tier).toBe('standard');
    expect(pickModel(64 * GB)?.tier).toBe('standard');
  });

  it('uses the lite 2B model from 8GB to just under 16GB', () => {
    expect(pickModel(8 * GB)?.file).toBe('Qwen3.5-2B-Q4_K_M.gguf');
    expect(pickModel(15.9 * GB)?.tier).toBe('lite');
  });

  it('turns the fast lane off under 8GB', () => {
    expect(pickModel(7.9 * GB)).toBeNull();
    expect(pickModel(0)).toBeNull();
  });
});

describe('pickModel with a tier override', () => {
  it('lets someone with 8GB choose the standard model, and someone with plenty choose the lite one', () => {
    expect(pickModel(8 * GB, 'standard')?.tier).toBe('standard');
    expect(pickModel(32 * GB, 'lite')?.tier).toBe('lite');
  });

  it('still refuses machines under 8GB whatever the override', () => {
    expect(pickModel(7.9 * GB, 'standard')).toBeNull();
    expect(pickModel(7.9 * GB, 'lite')).toBeNull();
  });
});

describe('catalog integrity', () => {
  it('pins every model by checksum, size, license and immutable commit', () => {
    expect(MODELS.length).toBe(2);
    for (const m of MODELS) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(m.bytes).toBeGreaterThan(1_000_000_000);
      expect(m.license).toBe('apache-2.0');
      expect(modelUrl(m)).toBe(`https://huggingface.co/${m.repo}/resolve/${m.commit}/${m.file}`);
      expect(modelUrl(m)).not.toContain('/main/');
    }
  });

  it('carries the prompt format and handoff gap fitted in the bake-off', () => {
    const standard = MODELS.find((m) => m.tier === 'standard')!;
    const lite = MODELS.find((m) => m.tier === 'lite')!;
    expect(standard.promptFormat).toBe('qwen3-instruct');
    expect(standard.handoffGapNats).toBe(2.0);
    expect(lite.promptFormat).toBe('qwen3.5');
    expect(lite.handoffGapNats).toBe(1.5);
  });

  it('pins the llama.cpp runtime per platform with checksums', () => {
    expect(RUNTIMES.map((r) => r.platform).sort()).toEqual(['darwin-arm64', 'darwin-x64']);
    for (const r of RUNTIMES) {
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.url).toContain(`/${r.build}/`);
      expect(r.url.startsWith('https://github.com/ggml-org/llama.cpp/releases/download/')).toBe(true);
      expect(r.bytes).toBeGreaterThan(1_000_000);
    }
  });
});

describe('pickRuntime', () => {
  it('maps macOS architectures and rejects other platforms', () => {
    expect(pickRuntime('darwin', 'arm64')?.platform).toBe('darwin-arm64');
    expect(pickRuntime('darwin', 'x64')?.platform).toBe('darwin-x64');
    expect(pickRuntime('linux', 'x64')).toBeNull();
    expect(pickRuntime('win32', 'x64')).toBeNull();
    expect(pickRuntime('darwin', 'ia32')).toBeNull();
  });
});
