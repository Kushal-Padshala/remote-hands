import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DecideInput, DecideResult, DecisionEngine } from '../types.js';
import { modelUrl, type ModelEntry } from './catalog.js';
import { LlamaDecisionEngine } from './decide.js';
import { downloadVerified } from './download.js';
import { assessCapability, detectHardware, type HardwareInfo } from './hardware.js';
import { ensureRuntime, isRuntimeInstalled, runtimeServerPath } from './runtime.js';
import { LlamaSidecar } from './server.js';

export interface InferenceStatus {
  state: 'unsupported' | 'not-installed' | 'ready' | 'running';
  reason?: string;
  model?: string;
  tier?: 'standard' | 'lite';
  handoffGapNats?: number;
}

export type InstallStage = 'runtime' | 'model';

type SidecarHandle = Pick<LlamaSidecar, 'ensureStarted' | 'baseUrl' | 'apiKey' | 'touch' | 'stop' | 'isRunning'>;

export interface FastLaneInferenceOptions {
  homeDir?: string | undefined;
  hardware?: HardwareInfo | undefined;
  deps?: Partial<{
    download: typeof downloadVerified;
    ensureRuntime: typeof ensureRuntime;
    createSidecar: (o: { serverPath: string; modelPath: string; contextTokens: number }) => SidecarHandle;
    fetch: typeof fetch;
  }> | undefined;
}

interface InstallState {
  version: 1;
  modelId: string;
  runtimeBuild: string;
  verified: boolean;
}

/**
 * The one entry point to the local decision model: install, status, prewarm and decide. Everything
 * else in the fast lane depends on `DecisionEngine`, which this implements.
 */
export class FastLaneInference implements DecisionEngine {
  private readonly home: string;
  private readonly hardware: HardwareInfo;
  private readonly deps: NonNullable<FastLaneInferenceOptions['deps']>;
  private sidecar: SidecarHandle | undefined;
  private engine: LlamaDecisionEngine | undefined;

  constructor(opts: FastLaneInferenceOptions = {}) {
    this.home = opts.homeDir ?? os.homedir();
    this.hardware = opts.hardware ?? detectHardware();
    this.deps = opts.deps ?? {};
  }

  private dir(...parts: string[]): string {
    return path.join(this.home, '.remote-hands', 'fast-lane', ...parts);
  }

  private modelPath(model: ModelEntry): string {
    return this.dir('models', model.file);
  }

  private installedPaths(): { modelPath: string; serverPath: string; model: ModelEntry } | null {
    const cap = assessCapability(this.hardware);
    if (!cap.supported || !cap.model || !cap.runtime) return null;
    let state: InstallState;
    try {
      state = JSON.parse(fs.readFileSync(this.dir('state.json'), 'utf8')) as InstallState;
    } catch {
      return null;
    }
    if (state.verified !== true || state.modelId !== cap.model.id || state.runtimeBuild !== cap.runtime.build) return null;
    const modelPath = this.modelPath(cap.model);
    if (!isRuntimeInstalled(this.home, cap.runtime)) return null;
    try {
      if (fs.statSync(modelPath).size !== cap.model.bytes) return null;
    } catch {
      return null;
    }
    return { modelPath, serverPath: runtimeServerPath(this.home, cap.runtime), model: cap.model };
  }

  status(): InferenceStatus {
    const cap = assessCapability(this.hardware);
    if (!cap.supported || !cap.model) return { state: 'unsupported', ...(cap.reason ? { reason: cap.reason } : {}) };
    const common = { model: cap.model.id, tier: cap.model.tier, handoffGapNats: cap.model.handoffGapNats } as const;
    if (this.installedPaths() === null) return { state: 'not-installed', ...common };
    return { state: this.sidecar?.isRunning() ? 'running' : 'ready', ...common };
  }

  /** Gap (nats) below which the pilot hands over to the brain; 2.0 when the hardware is unsupported. */
  handoffGapNats(): number {
    return assessCapability(this.hardware).model?.handoffGapNats ?? 2.0;
  }

  async install(onProgress?: (stage: InstallStage, done: number, total: number) => void): Promise<void> {
    const cap = assessCapability(this.hardware);
    if (!cap.supported || !cap.model || !cap.runtime) throw new Error(cap.reason ?? 'The fast lane is not supported on this machine.');
    const install = this.deps.ensureRuntime ?? ensureRuntime;
    const download = this.deps.download ?? downloadVerified;
    await install(cap.runtime, { homeDir: this.home, onProgress: (d, t) => onProgress?.('runtime', d, t) });
    await download({
      url: modelUrl(cap.model),
      destination: this.modelPath(cap.model),
      sha256: cap.model.sha256,
      bytes: cap.model.bytes,
      onProgress: (d, t) => onProgress?.('model', d, t),
    });
    const state: InstallState = { version: 1, modelId: cap.model.id, runtimeBuild: cap.runtime.build, verified: true };
    fs.mkdirSync(this.dir(), { recursive: true });
    const temporary = `${this.dir('state.json')}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, this.dir('state.json'));
  }

  private getSidecar(): SidecarHandle | null {
    if (this.sidecar) return this.sidecar;
    const installed = this.installedPaths();
    if (installed === null) return null;
    const options = { serverPath: installed.serverPath, modelPath: installed.modelPath, contextTokens: installed.model.contextTokens };
    this.sidecar = this.deps.createSidecar ? this.deps.createSidecar(options) : new LlamaSidecar(options);
    return this.sidecar;
  }

  /** Starts the model so the first decision is fast. Never throws; false when it could not start. */
  async prewarm(): Promise<boolean> {
    try {
      const sidecar = this.getSidecar();
      if (sidecar === null) return false;
      await sidecar.ensureStarted();
      return true;
    } catch {
      return false;
    }
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    const status = this.status();
    if (status.state === 'unsupported') throw new Error(`The fast lane is not available: ${status.reason ?? 'unsupported machine'}`);
    const sidecar = this.getSidecar();
    if (sidecar === null) throw new Error('The fast lane is not installed yet.');
    if (this.engine === undefined) {
      const model = assessCapability(this.hardware).model!;
      this.engine = new LlamaDecisionEngine(sidecar, model.promptFormat, this.deps.fetch);
    }
    return this.engine.decide(input);
  }

  async dispose(): Promise<void> {
    await this.sidecar?.stop();
  }
}
