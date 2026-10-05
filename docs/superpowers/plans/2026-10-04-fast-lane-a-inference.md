# Fast Lane Stage A: Local Inference Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox syntax. Commit and push after every task.

**Goal:** A hermetically tested local decision service: pinned `llama-server` runtime and model files that download with resume and checksum, a supervised sidecar process, and a `decide()` API that returns option probabilities plus the log-probability gap, all behind a `DecisionEngine` interface.

**Architecture:** New directory `packages/daemon/src/fast-lane/inference/`. Everything touching the network, the filesystem, child processes or time is injected, so unit tests never download or spawn anything. A separate opt-in live test (`RH_FASTLANE_LIVE=1`) runs the real runtime and real model against the fixture decisions.

**Tech Stack:** TypeScript (NodeNext, strict, exactOptionalPropertyTypes), Node 22 built-ins only (`fetch`, `node:child_process`, `node:crypto`, `node:fs`), vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-fast-lane-design.md` (sections 3, 4.6). Bake-off numbers: `docs/fast-lane/bake-off-2026-10-04.md`.

## Global Constraints

- The default behaviour of every existing command and of the HUD must not change. Nothing in Stage A is wired into existing code except additive exports in `packages/daemon/src/index.ts`.
- Unit tests must be hermetic: no network, no spawning `llama-server`, no writes outside a temp dir. Live tests are skipped unless `RH_FASTLANE_LIVE=1`.
- All local files live under `~/.remote-hands/fast-lane/` (`runtime/`, `models/`, `state.json`). The home directory is injectable.
- The sidecar binds `127.0.0.1` only, on a random free port, with a per-run random API key.
- Pinned artifacts (sha256 verified before use, size checked): llama.cpp `b11401` macOS arm64 `cf6410ec5cb373e7f161852a0e2ad30e96c190b9282e75cbd7eae00bd96736b4` (11921253 bytes) and macOS x64 `84c0d9d17cea59b1b79d1de56b1bfa452abae84555db04da23bd3fe848416d81` (11482049 bytes); `Qwen3.5-2B-Q4_K_M.gguf` `aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223` (1280835840 bytes, repo `unsloth/Qwen3.5-2B-GGUF` commit `f6d5376be1edb4d416d56da11e5397a961aca8ae`); `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` (2497281120 bytes, repo `unsloth/Qwen3-4B-Instruct-2507-GGUF` commit `a06e946bb6b655725eafa393f4a9745d460374c9`). All Apache-2.0.
- Tier thresholds: 16GB or more total RAM uses the 4B model with handoff gap 2.0 nats; 8GB up to under 16GB uses the 2B model with gap 1.5; under 8GB the fast lane is off.
- The model prompt format is fixed by `promptFormat` in the catalog: `qwen3.5` models get the empty think block prefilled; `qwen3-instruct` models get none.

## Review Focus

- Corrupt or truncated download: sha256 mismatch must delete the partial file and fail, never use it.
- Interrupted download resumes from the partial file with an HTTP Range request; a server that ignores Range restarts from zero.
- Server that never becomes healthy: start fails after the timeout and the child is killed.
- Server crash while idle: the next `decide()` restarts it once, then surfaces the error.
- Model answers with a token that is not one of the option letters (for example `<think>`): treated as no decision, never mapped to an option.
- More options than letters: rejected up front with a clear error.

## File Structure

- `fast-lane/types.ts`: shared `DecideInput`, `DecideResult`, `DecisionEngine`.
- `fast-lane/inference/catalog.ts`: pinned runtime and model entries, tiers, thresholds.
- `fast-lane/inference/hardware.ts`: RAM and architecture detection, tier choice.
- `fast-lane/inference/download.ts`: resumable verified downloader.
- `fast-lane/inference/runtime.ts`: install the pinned `llama-server`.
- `fast-lane/inference/server.ts`: sidecar supervisor.
- `fast-lane/inference/decide.ts`: prompt building, response parsing, `LlamaDecisionEngine`.
- `fast-lane/inference/service.ts`: `FastLaneInference` facade, state file, prewarm and idle unload.
- Tests next to each file; live test `fast-lane/inference/live.test.ts`.

---

### Task 1: Shared types and the catalog

**Files:** Create `fast-lane/types.ts`, `fast-lane/inference/catalog.ts`, `fast-lane/inference/catalog.test.ts`.

**Interfaces:**
- Produces:
  - `interface DecideInput { state: string; question: string; options: ReadonlyArray<{ id: string; text: string }>; system?: string }`
  - `interface DecideResult { choice: string | null; probabilities: Record<string, number>; gapNats: number; latencyMs: number; promptTokens: number }` (`choice` null when the model emitted no option letter; `gapNats` is best minus second-best log-probability, 20 when only one option scored, 0 when `choice` is null)
  - `interface DecisionEngine { decide(input: DecideInput): Promise<DecideResult> }`
  - `type PromptFormat = 'qwen3.5' | 'qwen3-instruct'`
  - `interface ModelEntry { id: string; tier: 'standard' | 'lite'; repo: string; commit: string; file: string; sha256: string; bytes: number; license: string; promptFormat: PromptFormat; handoffGapNats: number; contextTokens: number }`
  - `interface RuntimeEntry { build: string; platform: 'darwin-arm64' | 'darwin-x64'; url: string; sha256: string; bytes: number; archiveDir: string }`
  - `MODELS: readonly ModelEntry[]`, `RUNTIMES: readonly RuntimeEntry[]`
  - `modelUrl(entry: ModelEntry): string` returns `https://huggingface.co/<repo>/resolve/<commit>/<file>`
  - `pickModel(totalRamBytes: number): ModelEntry | null` (null under 8GB)
  - `pickRuntime(platform: NodeJS.Platform, arch: string): RuntimeEntry | null`

- [ ] **Step 1: Write the failing test** (`catalog.test.ts`):
  - `pickModel(16 * 2**30)` is the Qwen3-4B-Instruct-2507 entry, `pickModel(17_179_869_184)` too; `pickModel(8 * 2**30)` and `pickModel(15.9 * 2**30)` are the Qwen3.5-2B entry; `pickModel(7.9 * 2**30)` is null.
  - Every model entry has a 64-hex sha256, positive bytes, `license === 'apache-2.0'`, a 40-hex commit, and `modelUrl` contains the commit and not `main`.
  - `pickRuntime('darwin','arm64')` and `('darwin','x64')` return entries whose url contains the build and whose sha256 is 64-hex; `('linux','x64')` and `('win32','x64')` return null.
  - Handoff thresholds: standard 2.0, lite 1.5.
- [ ] **Step 2:** Run `npx vitest run packages/daemon/src/fast-lane/inference/catalog.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `types.ts` and `catalog.ts` with the pinned values from Global Constraints.
- [ ] **Step 4:** Re-run. Expected: PASS. Run `npx tsc --noEmit -p packages/daemon`. Expected: no output.
- [ ] **Step 5:** `git add` the three files, commit `feat(fast-lane): shared types and pinned model/runtime catalog`, push.

### Task 2: Hardware detection

**Files:** Create `fast-lane/inference/hardware.ts`, `hardware.test.ts`.

**Interfaces:**
- Consumes: `pickModel`, `pickRuntime`.
- Produces: `interface HardwareInfo { platform: NodeJS.Platform; arch: string; totalRamBytes: number }`, `detectHardware(os?: { platform(): NodeJS.Platform; arch(): string; totalmem(): number }): HardwareInfo`, `interface Capability { supported: boolean; reason?: string; model: ModelEntry | null; runtime: RuntimeEntry | null }`, `assessCapability(hw: HardwareInfo): Capability`.

- [ ] **Step 1: Failing tests:** 16GB arm64 darwin is supported with the standard model and the arm64 runtime; 8GB is supported with the lite model; 4GB is unsupported with a reason mentioning memory; linux is unsupported with a reason mentioning the platform; an injected fake `os` is used (no real machine access).
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, expect PASS; typecheck.
- [ ] **Step 5:** Commit `feat(fast-lane): hardware capability assessment`, push.

### Task 3: Resumable verified downloader

**Files:** Create `fast-lane/inference/download.ts`, `download.test.ts`.

**Interfaces:**
- Produces: `interface DownloadDeps { fetch: typeof fetch; fs: typeof import('node:fs'); }`, `interface DownloadRequest { url: string; destination: string; sha256: string; bytes: number; onProgress?: (done: number, total: number) => void }`, `downloadVerified(req: DownloadRequest, deps?: Partial<DownloadDeps>): Promise<string>` returning the final path. Writes to `<destination>.partial`, renames to `destination` only after the size and sha256 both match. If `destination` already exists and verifies, returns without fetching. On mismatch deletes the partial and throws `Error('checksum mismatch for <basename>')`.

- [ ] **Step 1: Failing tests** with a fake `fetch` and a temp dir: (a) downloads, verifies, renames, reports progress ending at total; (b) existing verified file means zero fetch calls; (c) existing file with the wrong content is re-downloaded; (d) a `.partial` of N bytes makes the request carry `Range: bytes=N-` and a 206 response is appended; (e) a 200 response to a Range request restarts from zero; (f) wrong sha256 deletes the partial and throws the checksum error; (g) wrong total size throws and deletes the partial; (h) HTTP 404 throws with the status.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement with streaming `response.body` into an `fs` write stream (flags `a` when resuming, `w` otherwise), incremental `crypto.createHash('sha256')` over the full final file (re-hash the partial prefix on resume by reading it first).
- [ ] **Step 4:** Run, expect PASS; typecheck.
- [ ] **Step 5:** Commit `feat(fast-lane): resumable checksum-verified downloader`, push.

### Task 4: Runtime installer

**Files:** Create `fast-lane/inference/runtime.ts`, `runtime.test.ts`.

**Interfaces:**
- Consumes: `downloadVerified`, `RuntimeEntry`.
- Produces: `ensureRuntime(entry: RuntimeEntry, opts: { homeDir: string; deps?: { download?: typeof downloadVerified; extract?: (archive: string, dir: string) => Promise<void>; fs?: typeof import('node:fs') }; onProgress?: ... }): Promise<{ serverPath: string }>`. Installs to `<home>/.remote-hands/fast-lane/runtime/<build>-<platform>/`; the server binary is `<archiveDir>/llama-server`. Skips when the binary exists and is executable. Extraction runs `tar -xzf <archive> -C <dir>` through an injectable `extract`. After extraction it verifies `llama-server` exists and chmods it 0o755, else throws `Error('llama-server missing from runtime archive')`. Never extracts a path containing `..` (verify with `tar -tzf` listing first inside `extract`).

- [ ] **Step 1: Failing tests** with fakes: skip when installed; downloads then extracts then returns the path; throws when the binary is missing after extraction; rejects an archive listing containing `../`; passes progress through.
- [ ] **Step 2-4:** Run fail, implement, run pass, typecheck.
- [ ] **Step 5:** Commit `feat(fast-lane): pinned llama-server runtime installer`, push.

### Task 5: Sidecar supervisor

**Files:** Create `fast-lane/inference/server.ts`, `server.test.ts`.

**Interfaces:**
- Produces: `interface SidecarOptions { serverPath: string; modelPath: string; contextTokens: number; spawn?: typeof import('node:child_process').spawn; fetch?: typeof fetch; randomPort?: () => Promise<number>; randomKey?: () => string; healthTimeoutMs?: number; idleMs?: number; now?: () => number; setTimer?: ...; clearTimer?: ... }`, `class LlamaSidecar { start(): Promise<void>; ensureStarted(): Promise<void>; baseUrl(): string; apiKey(): string; touch(): void; stop(): Promise<void>; isRunning(): boolean }`. Arguments to the binary: `-m <model> --host 127.0.0.1 --port <p> -c <ctx> -ngl 99 -np 1 --no-webui --api-key <key>`. `start` resolves when `GET /health` returns `{"status":"ok"}` (poll every 100ms), rejects and kills the child after `healthTimeoutMs` (default 60000) or if the child exits first. Idle timer stops the process after `idleMs` (default 600000) without `touch()`. If the child exits unexpectedly, `isRunning()` becomes false and `ensureStarted()` starts a new one.

- [ ] **Step 1: Failing tests** with a fake spawn returning an EventEmitter child, fake fetch for `/health`, fake timers: arguments exactly as specified (host `127.0.0.1`, api key present, random port from the injected function); resolves on health ok; rejects and kills on timeout; rejects when the child exits before healthy; `ensureStarted` is a no-op when running and restarts after an unexpected exit; idle timer stops the child and a later `ensureStarted` restarts it; `stop` kills with SIGTERM and is idempotent; the API key never appears in thrown error messages.
- [ ] **Step 2-4:** Run fail, implement, run pass, typecheck.
- [ ] **Step 5:** Commit `feat(fast-lane): supervised llama-server sidecar`, push.

### Task 6: Decision engine

**Files:** Create `fast-lane/inference/decide.ts`, `decide.test.ts`.

**Interfaces:**
- Consumes: `DecisionEngine`, `DecideInput`, `DecideResult`, `PromptFormat`.
- Produces: `buildPrompt(input: DecideInput, format: PromptFormat): { prompt: string; letters: string[] }` (letters `A-Z` then `1-4`, so at most 30 options, else throws `Error('too many options (max 30)')`; empty options throws), `parseDecision(response: unknown, letters: string[], options: DecideInput['options']): Omit<DecideResult, 'latencyMs' | 'promptTokens'>`, `class LlamaDecisionEngine implements DecisionEngine { constructor(sidecar: Pick<LlamaSidecar,'ensureStarted'|'baseUrl'|'apiKey'|'touch'>, format: PromptFormat, fetchImpl?: typeof fetch) }`. The request is `POST {base}/completion` with body `{ prompt, n_predict: 1, n_probs: 30, temperature: 0, cache_prompt: true }` and header `Authorization: Bearer <key>`. Probabilities are softmax-normalised over the option letters found in `completion_probabilities[0].top_logprobs` (token trimmed and uppercased). Prompt text: system line `You are a decision engine. Read the state and the question, then answer with exactly one option letter and nothing else.` (overridable by `input.system`), the state, `Question: <question>`, lettered options, `Answer with the letter only.`, wrapped in ChatML; `qwen3.5` format appends `<think>\n\n</think>\n\n` after the assistant tag.

- [ ] **Step 1: Failing tests:** prompt for two options contains `A. ...` and `B. ...` and the exact instruction lines; `qwen3.5` format ends with the empty think block and `qwen3-instruct` does not; 31 options throws; 0 options throws; parse picks the best letter and normalises probabilities to sum 1; gap is best minus second in nats; a single scored option gives gap 20; response whose top token is `<think>` with no letters gives `choice: null`, gap 0; lowercase `b` maps to option B; duplicate letter tokens use the higher logprob; the engine posts the right URL, bearer header and body, calls `touch` and `ensureStarted`, and reports `latencyMs` and `promptTokens` from `tokens_evaluated`; a non-200 response throws an error mentioning the status but not the API key.
- [ ] **Step 2-4:** Run fail, implement, run pass, typecheck.
- [ ] **Step 5:** Commit `feat(fast-lane): llama-server decision engine with log-probability gap`, push.

### Task 7: Service facade, state file and live test

**Files:** Create `fast-lane/inference/service.ts`, `service.test.ts`, `live.test.ts`; modify `packages/daemon/src/index.ts` (additive exports).

**Interfaces:**
- Consumes: everything above.
- Produces: `interface InferenceStatus { state: 'unsupported' | 'not-installed' | 'ready' | 'running'; reason?: string; model?: string; tier?: 'standard' | 'lite'; handoffGapNats?: number }`, `class FastLaneInference implements DecisionEngine { constructor(opts: { homeDir?: string; hardware?: HardwareInfo; deps?: ... }); status(): InferenceStatus; install(onProgress?): Promise<void> (runtime then model); prewarm(): Promise<void> (starts the sidecar if installed, never throws, resolves false when not ready); decide(input): Promise<DecideResult> (throws a clear 'fast lane not installed' error when not ready); dispose(): Promise<void>; handoffGapNats(): number }`. `status()` is computed from hardware and from files present with verified size (not re-hashing 2.5GB on every call; `install` writes `<home>/.remote-hands/fast-lane/state.json` with the model id, runtime build and a `verified: true` marker after verification, and `status()` trusts the marker only if the file sizes still match).
- Live test: skipped unless `RH_FASTLANE_LIVE=1`; installs nothing; uses `FAST_LANE_MODEL_PATH` and `FAST_LANE_SERVER_PATH` env vars to start the real sidecar on the fixture sets and asserts accuracy at least 0.85 on router and element decisions for the standard model.

- [ ] **Step 1: Failing tests:** unsupported hardware gives `unsupported` with the reason and `decide` throws; no files gives `not-installed`; install calls runtime then model downloads with the catalog entries and writes the state marker; after install `status()` is `ready`; a truncated model file makes it `not-installed` again; `prewarm` returns false and does not throw when not installed; `decide` after install starts the sidecar once and reuses it; `dispose` stops it.
- [ ] **Step 2-4:** Run fail, implement, add exports (`export * from './fast-lane/...'` for types, catalog, service), run the full daemon suite and typecheck.
- [ ] **Step 5:** Commit `feat(fast-lane): inference service facade with install state`, push.
- [ ] **Step 6 (verification, no commit):** Run the live test against the real runtime and model downloaded during the bake-off (`FAST_LANE_SERVER_PATH` and `FAST_LANE_MODEL_PATH` pointing at the scratch copies) and record the numbers in the ledger. If accuracy is below 0.85, stop and investigate before continuing.

## Self-Review

- Spec section 4.6 (supervisor, prewarm, idle unload, `decide` API) maps to Tasks 5-7; section 3.4 (pinned runtime, checksums, resume) to Tasks 3-4; tiers and thresholds to Tasks 1-2.
- The engine's handoff gap thresholds are carried in the catalog so later stages read them from one place.
- No task wires into the HUD; Stage C does that behind a flag.
