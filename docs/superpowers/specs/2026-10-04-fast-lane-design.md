# Fast Lane: a local decision model that drives the computer in real time

Status: draft for review. Date: 2026-10-04. Scope: `packages/daemon`, `packages/cli`, installer.

## 1. Goal

Make the HUD act on a request about as fast as a person would: most clicks, app launches and message sends finish in one to three seconds, for ordinary (non-technical) people, on ordinary Macs, at zero cost, with no data sent anywhere for the fast path.

A small model that runs on the user's machine does the quick, repetitive deciding. The existing cloud agent (agy) stays as the "brain" for writing, planning, long jobs and anything the small model is unsure about.

### Non-goals (this spec)
- Windows or Linux support (the macOS accessibility layer is the current foundation; a port is a separate project).
- Vision-based control on the local model (see section 3).
- Skill learning from past runs (designed for, built later, section 4.9).
- Replacing agy.

## 2. Evidence (what is measured, what is not)

Measured on Apple M4, 16GB, 107 decisions I labelled (router 49, element pick 38, brief-following 20; 4 of the last are real survey pages from the HUD log). Throwaway harness, not in the repo.

| Model (Ollama, Metal) | RAM loaded | Accuracy | Median decision |
|---|---|---|---|
| Qwen3-0.6B | 1.06GB | 64% | 127ms |
| Qwen3-1.7B | 1.86GB | 88% (router 94%) | 218ms |
| Qwen3-4B-instruct | 3.38GB | 94% (router 94%, element 97%) | 423ms |
| Laya typed-decisions (torch) | 2.9GB | 73% | 50ms |

- Model load from idle: 0.6s / 0.9s / 1.4s for 0.6B / 1.7B / 4B (file cache warm).
- Prefill is the cost: about 300 tokens/s (4B) and 800 tokens/s (1.7B). Element picking with 12 options: 4B 100% at 746ms, 1.7B 74% at 329ms. With 30 options: 4B 95% at 1.9s, 1.7B 53% at 0.7s.
- Raw model confidence is useless for deciding when to ask for help (1.7B: 0.99 when right, 0.98 when wrong). Laya's confidence is usable but its accuracy and 2.9GB torch footprint lose to a plain small LLM.
- Current HUD cost per step from the log: about 3s cloud-model thinking plus fixed 2s waits the agent adds: a 72s, 18-step survey and a 142s, 51-step notes+Spotify task.
- Not measured: multi-step success rate, margin-based escalation, Qwen3.5 models (installed Ollama 0.18 cannot run them), 8GB machines, Intel Macs, battery, behavior under load.

Research this design relies on:
- Jev Ultrafast (browser-use) runs the same loop with a hosted decision model: one request returns operation and target, targets are validated before clicking, waits capped at 200ms. Reported 7.1s Google Flights, 2.8s Wikipedia, 1.9s hotel filter. https://github.com/browser-use/jev-ultrafast
- Jev Decision Index leaderboard (frozen suite of about 120k decisions): 4B-class open decision models score about 55-57, 2B about 46, sub-0.5B 22-32. https://multimodalart-jev-decision-index.static.hf.space/data/index.json
- Vision-based small agents (Fara-7B 73.5% WebVoyager, UI-TARS) need a 7B vision model and a GPU-class machine. https://arxiv.org/html/2511.19663v1
- Qwen3.5 small models (0.8B/2B/4B/9B) are Apache-2.0, have GGUF builds, tool use and vision input. https://unsloth.ai/docs/models/qwen3.5
- node-llama-cpp ships prebuilt Metal/CUDA/Vulkan binaries and runs in Electron; llama-server exposes logprobs. https://node-llama-cpp.withcat.ai/guide/Metal
- Apple SpeechAnalyzer (macOS 26) runs on-device at about 125-132ms median post-speech latency and beat Whisper-small in an independent benchmark; whisper.cpp small.en is about 122-125ms. https://dev.to/iravoice/apple-speechanalyzer-vs-whispercpp-a-40-speaker-mac-benchmark-40i4
- Agent security guidance: restrict the action space to a task allowlist, treat page content as untrusted data, require human approval for side effects. https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html

## 3. Decisions

1. **Decide, never write.** The local model only chooses among a closed, typed list of options (action x element). It never produces shell commands, selectors, coordinates or code. This is what makes a small model safe and fast, and it is the Jev design.
2. **Text-only observation.** The model reads the indexed element table the HUD tools already produce (`[7] button "Next"`), plus deltas. Local vision is out: it needs 7B-class models. Screens with no usable element table (canvas, unlabeled UIs) are handed to the brain with a screenshot.
3. **One resident model, two jobs.** The same model routes requests and picks actions, so RAM stays at one model: Qwen3.5-4B-Instruct on 16GB+ Macs, Qwen3.5-2B-Instruct on 8GB Macs. Machines below 8GB run with the fast lane off (brain only). Release gate: the Qwen3.5 pair must beat the measured Qwen3 baseline (4B-instruct / 1.7B) on the acceptance set (section 7); otherwise ship the Qwen3 baseline. Apache-2.0 only, so the model can be redistributed. The model is a config value, not code.
4. **Runtime: pinned `llama-server` sidecar, bundled by our installer.** It gives logprobs, prompt-prefix caching, crash isolation, restart supervision, and needs no separate install. Ollama is dev-only (requires a separate app, version drift, 5-minute idle unload). Models download on first run from Hugging Face with progress, resume and checksum into `~/.remote-hands/models`.
5. **Speed comes from fewer, cheaper steps, not only a faster model.** Shortlist to at most 12 candidates before the model sees them, cache the instruction prefix, send deltas, wait for the page to change instead of fixed sleeps, and fill whole forms in one decision pass.
6. **The brain is pluggable and optional.** agy stays the default brain (already integrated). A local-only mode works with the fast lane alone for the supported task types.
7. **Safety is structural.** Allowlisted actions, validated targets, untrusted-content isolation, and approval for every irreversible action (section 4.8).

## 4. Architecture

```
voice or keyboard -> Conductor (local model, ~0.2-0.4s) -> instant "On it: ..." in HUD
                         |
      +------------------+---------------------+----------------------+
      |                  |                     |
  NATIVE SKILLS      PILOT LOOP            BRAIN LANE (agy)
  open app, media,   observe -> shortlist  writing, plans, long jobs,
  notes, messages    -> decide -> validate handoff recovery,
  (deterministic)    -> act -> wait ->     briefs for the pilot
                     verify                (background, streams progress)
      |                  |                     |
      +------ every irreversible step goes through the approval gate ------+
```

### 4.1 Conductor
Input: request text and window context. Output: `{ lane, skill?, slots, needsBrief }` from one decision pass over the 7-way lane list. Slots (contact, message text, app, URL) are copied verbatim from the request, never paraphrased. It emits the HUD acknowledgement immediately, before any action runs.

### 4.2 Action space
Typed operations only: `click`, `type`, `select`, `check`, `press`, `scroll`, `wait`, `open_app`, `focus_tab`, `read`, `done`, `handoff`. Each decision is a choice among `(operation, element-id)` pairs plus `done` and `handoff`. Text to type comes from the user's request, the brain's brief, or a slot; the pilot never invents it.

### 4.3 Pilot loop
1. Observe: element table, as a delta from the previous state.
2. Shortlist: rank elements by lexical overlap with the goal and brief, role priors, and position; keep at most 12.
3. Decide: one pass with the fixed prefix cached; the model returns probabilities over the options.
4. Validate: the target must be visible, enabled and not covered; otherwise retry once, then hand off.
5. Act through the existing `ComputerSession` (so the approval gate and tab pinning still apply).
6. Wait for change: resolve as soon as the page or element table changes, capped at 1s, replacing fixed 2s waits.
7. Verify with plain code: expected state change, no loop (same action twice without change), progress toward `done`.

Form mode: for a page of fields with a brief, score every field in one pass and apply the answers as one `browser_do` batch.

Handoff triggers (any one): free text needed that is not in the brief or request; top-two probability margin below a threshold fitted on the acceptance set; two consecutive failed validations; no state change after an action; a loop; an irreversible action the user did not name; an empty or unusable element table. Handoff carries what was done (reusing the previous-task digest format) so the brain continues, not restarts.

### 4.4 Brain lane
Runs as today through the warm agy session, in the background so the user can keep working. For pilot-eligible work (a survey, a form) the brain writes a short brief once (persona, answer policy, any text to type) and then the pilot runs the pages. Progress streams to the HUD.

### 4.5 Native skills
Deterministic, instant, non-GUI actions registered in a typed registry with slot schemas: open or focus an app, media keys and playback, create a note, send a message, clipboard, open a file or URL. A skill declares its risk class; `send`, `delete`, `pay`, `post` are always gated. The registry is data plus a handler, so adding a skill never touches the router prompt beyond one description line; the conductor shortlists skills the same way the pilot shortlists elements (keyword rank, then at most 12 to the model).

### 4.6 Inference service
A supervisor in the daemon starts `llama-server` on a random localhost port with a per-run token, preloads the model on the HUD hotkey (the 0.6-1.4s load finishes while the user speaks or types), keeps it resident while active, and unloads after 10 idle minutes. API used by everything else: `decide({ state, question, options }) -> { probabilities, topMargin, latencyMs }`. All callers go through this one interface so the model and runtime can change.

### 4.7 Voice
Push-to-talk on the existing hotkey. On macOS 26+ use Apple SpeechAnalyzer (on-device, free, nothing to install); on older macOS use whisper.cpp small.en. On-device only: never the server-backed recognizer. The conductor starts on the final transcript; a spoken task begins roughly 0.15s after the user stops speaking.

### 4.8 Trust and safety
- Irreversible actions (send, submit, purchase, delete, post, deploy) always require approval. Phone approval stays; a local on-screen confirm in the HUD is added so people without the phone app are protected too. No setting removes the gate.
- Page text is data, never instructions: the goal and rules sit outside the delimited page block, the model can only emit options from the offered list, and nothing it outputs is executed as code.
- The user sees a live one-line ticker of each action and can stop everything with Escape at any time.
- The local path sends nothing off the machine. The brain is the only networked component and is used only for lane handoffs.
- Models and the installer are checksummed; the sidecar binds to localhost with a token.

### 4.9 Learning (designed now, built later)
Every run records a trace (operation, role+label locator, result). A later phase distills successful traces into saved skills with typed slots, shown to the user for one-tap save. Trace schema is part of phase 3 so the data exists by then. Nothing is saved silently.

## 5. Performance budget (targets, to be verified)

| Stage | Budget |
|---|---|
| Acknowledge | under 0.3s from end of input |
| Conductor decision | 0.2s (2B) to 0.4s (4B) |
| Native skill, end to end | 1-3s |
| Pilot step (decide + act + wait) | 0.6-1.2s, p50 |
| Form page in form mode | 1-2s |
| Model load | hidden behind speaking or typing |
| RAM, fast lane | 2GB (8GB tier), 3.5GB (16GB tier) |

## 6. Honest limits
- A task seen for the first time on a hard page can still escalate to the brain at brain speed.
- Small models are less accurate than agy per decision; the handoff checks, not model confidence, are the safety net.
- Whole-task success of the pilot is unmeasured until phase 0.
- macOS only in v1; 8GB Apple Silicon is the floor; Intel Macs and CPU-only speeds are unmeasured.

## 7. Acceptance criteria
Built in phase 0 and re-run every phase: local test pages (survey, login, multi-step wizard, shopping cart, long form) plus replay of logged HUD tasks.
- Task completion rate and the escalation rate are reported separately; a wrong action that is not caught is the failure that counts.
- Zero ungated irreversible actions across the suite.
- p50 pilot step 1.2s or less on an M4 16GB and on an 8GB Apple Silicon Mac.
- Qwen3.5 bake-off against the Qwen3 baseline on the same suite decides the shipped model.
- RAM within the budget in section 5 with a browser, Notes and Spotify open.

## 8. Phases (each gets its own plan)
0. **Validation spike**: pilot loop against local test pages with wait-for-change, shortlist, margin-based handoff; model bake-off incl. Qwen3.5 (needs a current runtime); fix thresholds.
1. **Inference service**: sidecar supervisor, model download and tiers, prefix cache, `decide()` API.
2. **Conductor and native skills**: lane routing, instant acknowledgement, typed skill registry, handoff protocol and digest.
3. **Pilot loop** in the daemon on top of `ComputerSession`, form mode, trace recording.
4. **Brain integration**: briefs, background jobs, progress streaming.
5. **Voice input.**
6. **Installer and onboarding** for non-technical users: one install, plain-language permissions, local confirm UI, health check.
7. **Skill learning.**

## 9. Risks
| Risk | Retired by |
|---|---|
| Small model fails long flows | Phase 0 completion numbers; handoff triggers; brain brief for long flows |
| Qwen3.5 not better than Qwen3 | Bake-off gate; model is config |
| `llama-server` logprobs or caching behave differently from Ollama | Phase 0 and phase 1 re-measure on the real runtime |
| 8GB machines too slow or too tight | Tiering; fast lane off below the floor |
| Element table missing or poor in some apps | Handoff with screenshot; coverage reported by the suite |
| Injection through page text | Section 4.8 structural controls; injection pages in the test suite |
