/**
 * Pinned runtime and model artifacts for the fast lane. Every entry is verified by sha256 before
 * use; model URLs point at an immutable commit, never a moving branch. Bake-off numbers that chose
 * these entries: docs/fast-lane/bake-off-2026-10-04.md.
 */

export type PromptFormat = 'qwen3.5' | 'qwen3-instruct';
export type ModelTier = 'standard' | 'lite';

export interface ModelEntry {
  id: string;
  tier: ModelTier;
  repo: string;
  commit: string;
  file: string;
  sha256: string;
  bytes: number;
  license: string;
  promptFormat: PromptFormat;
  /** Hand over to the brain when the gap between the top two options is below this (nats). */
  handoffGapNats: number;
  contextTokens: number;
}

export interface RuntimeEntry {
  build: string;
  platform: 'darwin-arm64' | 'darwin-x64';
  url: string;
  sha256: string;
  bytes: number;
  /** Directory inside the archive that holds `llama-server`. */
  archiveDir: string;
}

const GB = 2 ** 30;

export const MODELS: readonly ModelEntry[] = [
  {
    id: 'qwen3-4b-instruct-2507-q4km',
    tier: 'standard',
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    commit: 'a06e946bb6b655725eafa393f4a9745d460374c9',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    bytes: 2_497_281_120,
    license: 'apache-2.0',
    promptFormat: 'qwen3-instruct',
    handoffGapNats: 2.0,
    contextTokens: 4096,
  },
  {
    id: 'qwen3.5-2b-q4km',
    tier: 'lite',
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    commit: 'f6d5376be1edb4d416d56da11e5397a961aca8ae',
    file: 'Qwen3.5-2B-Q4_K_M.gguf',
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
    bytes: 1_280_835_840,
    license: 'apache-2.0',
    promptFormat: 'qwen3.5',
    handoffGapNats: 1.5,
    contextTokens: 4096,
  },
];

export const RUNTIMES: readonly RuntimeEntry[] = [
  {
    build: 'b11401',
    platform: 'darwin-arm64',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11401/llama-b11401-bin-macos-arm64.tar.gz',
    sha256: 'cf6410ec5cb373e7f161852a0e2ad30e96c190b9282e75cbd7eae00bd96736b4',
    bytes: 11_921_253,
    archiveDir: 'llama-b11401',
  },
  {
    build: 'b11401',
    platform: 'darwin-x64',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11401/llama-b11401-bin-macos-x64.tar.gz',
    sha256: '84c0d9d17cea59b1b79d1de56b1bfa452abae84555db04da23bd3fe848416d81',
    bytes: 11_482_049,
    archiveDir: 'llama-b11401',
  },
];

export function modelUrl(entry: ModelEntry): string {
  return `https://huggingface.co/${entry.repo}/resolve/${entry.commit}/${entry.file}`;
}

/** 16GB and up: standard 4B. 8GB up to just under 16GB: lite 2B. Under 8GB: fast lane off. */
export function pickModel(totalRamBytes: number): ModelEntry | null {
  const tier: ModelTier | null = totalRamBytes >= 16 * GB ? 'standard' : totalRamBytes >= 8 * GB ? 'lite' : null;
  if (tier === null) return null;
  return MODELS.find((m) => m.tier === tier) ?? null;
}

export function pickRuntime(platform: NodeJS.Platform, arch: string): RuntimeEntry | null {
  if (platform !== 'darwin') return null;
  const key = arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x64' : null;
  if (key === null) return null;
  return RUNTIMES.find((r) => r.platform === key) ?? null;
}
