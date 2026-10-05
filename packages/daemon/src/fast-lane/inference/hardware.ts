import os from 'node:os';
import { pickModel, pickRuntime, type ModelEntry, type RuntimeEntry } from './catalog.js';

export interface HardwareInfo {
  platform: NodeJS.Platform;
  arch: string;
  totalRamBytes: number;
}

export interface Capability {
  supported: boolean;
  /** Plain-language reason when `supported` is false. */
  reason?: string;
  model: ModelEntry | null;
  runtime: RuntimeEntry | null;
}

interface OsLike {
  platform(): NodeJS.Platform;
  arch(): string;
  totalmem(): number;
}

export function detectHardware(osModule: OsLike = os): HardwareInfo {
  return { platform: osModule.platform(), arch: osModule.arch(), totalRamBytes: osModule.totalmem() };
}

export function assessCapability(hw: HardwareInfo): Capability {
  const runtime = pickRuntime(hw.platform, hw.arch);
  if (runtime === null) {
    return {
      supported: false,
      reason: `The fast lane supports macOS on Apple Silicon or Intel for now; this platform (${hw.platform}/${hw.arch}) is not supported yet.`,
      model: null,
      runtime: null,
    };
  }
  const model = pickModel(hw.totalRamBytes);
  if (model === null) {
    return {
      supported: false,
      reason: 'The fast lane needs at least 8GB of memory to run the local model.',
      model: null,
      runtime,
    };
  }
  return { supported: true, model, runtime };
}
