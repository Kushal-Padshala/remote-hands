# Fast Lane Stage C: Conductor, Skills and HUD Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Commit and push after every task, gated on green tests and a clean typecheck.

**Goal:** Requests typed into the HUD are first offered to the fast lane. Instant skills (open an app, open a URL, new note, send a message, volume, media) run in about a second; web-page tasks go to the pilot; everything else, and everything the fast lane is unsure about, goes to agy exactly as today, carrying a summary of what the fast lane already did.

**Architecture:** `packages/daemon/src/fast-lane/`: `skills/` (typed registry, strict extractors, injected command runner), `conductor.ts` (route a request), `fast-lane.ts` (`FastLane.attempt()` returning handled/continue), a single hook in `HudCoordinator.executeTaskStandalone`, and `packages/cli` commands plus a config file. The whole thing is OFF by default and absent unless `fastLane` is injected, so existing behaviour is unchanged.

**Tech Stack:** TypeScript (NodeNext, strict, exactOptionalPropertyTypes), vitest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-fast-lane-design.md` (sections 4.1, 4.5, 4.8).

## Global Constraints

- Default off: `~/.remote-hands/fast-lane/config.json` `{ "enabled": false }` when absent; `RH_FAST_LANE=1|0` overrides the file. Nothing in the HUD changes unless a `FastLane` is injected.
- Nothing is ever run through a shell. Every command is `spawn(file, args)` with an argument array; user text reaches AppleScript only as `argv` items, never interpolated into script source.
- App names are a closed set: only apps found in `/Applications`, `/System/Applications`, `~/Applications` can be opened. URLs must parse and use `http` or `https`.
- `messages_send` asks the approval gate before sending, with a label containing "Send"; a rejected gate stops the skill, never retried. No test or live check ever sends a real message.
- Slot text (message body, note text) is copied verbatim from the request; if it cannot be located verbatim the skill declines and the request goes to the brain.
- A skill failure never fails the task: it becomes a handoff to agy with the reason.
- The pilot runs only when the frontmost application is a supported browser. The active-task marker (`writeActiveTask`) is set for the duration of any fast-lane action so the approval gate applies, and cleared afterwards, even on error.

## Review Focus

- A request that merely resembles a skill ("open the pod bay doors", "send mom flowers", "play a song by X"): must not trigger a skill.
- Request text containing quotes, backslashes, newlines, `$()`, backticks, AppleScript syntax: only ever passed as argv.
- A fast-lane crash or timeout: the task still reaches agy.
- Abort while the fast lane is running: the pilot stops, the active-task marker is cleared, the task is cancelled by the existing path.
- The model unavailable or not installed: silently continue to agy, no error shown to the user.

## File Structure

- `fast-lane/skills/types.ts`, `registry.ts`, `apps.ts`, `builtin.ts`, tests.
- `fast-lane/conductor.ts`, `fast-lane/fast-lane.ts`, tests.
- `fast-lane/config.ts`: config file read/write.
- Modify `guidance/hud-coordinator.ts` (+ test), `packages/daemon/src/index.ts` (exports).
- `packages/cli/src/commands/fast-lane.ts` (+ test), `packages/cli/src/index.ts`, `packages/cli/src/commands/hud.ts`.

---

### Task 1: Skill types, registry and the installed-apps catalog

**Files:** Create `skills/types.ts`, `skills/registry.ts`, `skills/apps.ts` and tests.

**Interfaces:**
- Produces: `interface CommandRunner { run(file: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> }`; `interface SkillContext { runner: CommandRunner; apps: AppCatalog; gate?: ActionGate; decide?: DecisionEngine; onProgress?: (text: string) => void }`; `type Slots = Record<string, string>`; `interface Skill { id: string; description: string; extract(query: string, ctx: SkillContext): Promise<Slots | null>; run(slots: Slots, ctx: SkillContext): Promise<SkillResult> }`; `type SkillResult = { ok: true; summary: string } | { ok: false; reason: string; declined?: boolean }`; `class SkillRegistry { register(skill: Skill): void; match(query: string, ctx): Promise<{ skill: Skill; slots: Slots } | null> }` (first skill whose extractor succeeds, in registration order); `interface AppCatalog { names(): string[]; resolve(spoken: string): { name: string } | { candidates: string[] } | null }` built by `createAppCatalog(opts?: { dirs?: string[]; fs?: ... })` listing `*.app` directory names; `resolve` is case-insensitive exact, then unique prefix, then unique substring; several matches return candidates (max 8).
- [ ] Tests: registry order and first-match; no match returns null; catalog lists `.app` names without the suffix from injected directories, ignores non-app entries and unreadable directories, resolves exact/prefix/substring/ambiguous/unknown; "Notes" does not resolve "Notes Helper" over exact.

### Task 2: Built-in skills

**Files:** Create `skills/builtin.ts`, `skills/builtin.test.ts`.

**Interfaces:** `openApp`, `openUrl`, `notesCreate`, `messagesSend`, `setVolume`, `mediaControl`: `Skill` objects; `defaultSkills(): Skill[]`.
- `open_app`: matches `open|launch|start|switch to|bring up` + a name; resolves through the catalog (several candidates: a decision among them via `ctx.decide` when available, else decline); runs `open -a <App>`; summary `Opened <App>`.
- `open_url`: first `http(s)://` URL, or a bare domain after `open|go to|visit`; `open <url>`; summary `Opened <host>`.
- `notes_create`: title after `called|titled|named`, body after `saying|that says|with|containing|:` or a lone quoted string; body verbatim; script via `osascript` with argv (`on run argv ... make new note with properties {name:..., body:...}`, body HTML-escaped with newlines as `<br>`).
- `messages_send`: `send|text|message <contact> saying|that says|:|with the message <text>` and `send|text "<text>" to <contact>`; asks the gate with label `Send message to <contact>: <first 60 chars>` before running; rejection returns `{ ok:false, declined:true }`; script via argv.
- `set_volume`: `volume to N`, `set volume N`, `mute`, `unmute`, `volume up/down` (+/-10), N clamped 0-100.
- `media`: `play|pause|resume|stop|skip|next|previous|go back` optionally followed by `the music|song|track|playback|spotify`; targets Spotify if installed, else Music; constant AppleScript verbs only.
- [ ] Tests (fake runner recording `[file, args]`): each skill's extractor on 6+ phrasings including non-matches ("open the pod bay doors", "send mom flowers", "play a song by Queen", "pause for a moment and think"); hostile text (`"; do shell script "rm -rf ~"`, backticks, `$(...)`, newlines, quotes, backslashes) appears only inside argv items and never in a script source argument; app resolution; ambiguous app declines without a decider and uses the decider with one; gate called before the Messages script, rejection means no runner call; volume clamping; media target selection; verbatim body.

### Task 3: Conductor

**Files:** Create `conductor.ts`, `conductor.test.ts`.

**Interfaces:** `type Route = { lane: 'skill'; skill: Skill; slots: Slots } | { lane: 'pilot'; gapNats: number } | { lane: 'brain'; reason: string }`; `routeRequest(input: { query: string; frontApp: string; frontIsBrowser: boolean; registry: SkillRegistry; ctx: SkillContext; engine: DecisionEngine; handoffGapNats: number }): Promise<Route>`. Order: skills first (strict extractors, no model call); if the frontmost app is not a browser the answer is `brain`; otherwise one decision between `pilot` ("Operate the web page in front of me: click, fill in forms, move through pages") and `brain` ("Something else: write text, research, run code, answer a question, or use another app"); a gap below the threshold, no choice or an engine error means `brain`.
- [ ] Tests with a scripted engine: skill match makes no engine call; non-browser front app never reaches the engine; browser + pilot choice with a good gap; low gap, null choice and thrown error give brain with a reason; the request text is inside the prompt and frontmost app named.

### Task 4: Handoff digest and the FastLane orchestrator

**Files:** Create `fast-lane.ts`, `fast-lane.test.ts`.

**Interfaces:** `type FastLaneOutcome = { kind: 'handled'; status: 'done'; summary: string } | { kind: 'continue'; addendum?: string }`; `class FastLane { constructor(deps: { enabled: () => boolean; inference: FastLaneInference-like (status, prewarm, decide, handoffGapNats); registry: SkillRegistry; skillContext: () => SkillContext; browser: () => PilotBrowser; frontmost: () => Promise<{ app: string; isBrowser: boolean }>; setActiveTask: (id: string | null) => void; now?: () => number }); prewarm(): void; attempt(input: { taskId: string; query: string; signal?: AbortSignal; onUpdate?: (text: string) => void }): Promise<FastLaneOutcome> }`; `describePilotHandoff(result: PilotResult): string`.
- `attempt`: disabled or inference not `ready`/`running` -> `continue` (no addendum). Otherwise route; `skill` -> run it, success -> `handled` with the skill summary, `{declined}` -> `handled` saying it stopped because the approval was declined, other failure -> `continue` with `The fast lane tried <skill> and it failed: <reason>`; `pilot` -> `runPilot` with `shouldStop` wired to the signal, step updates through `onUpdate`; `done` -> handled with `Done in N steps (Xs): <descriptions>`; `declined` -> handled (stopped, nothing more done); `handoff` -> `continue` with `describePilotHandoff`; `brain` -> `continue`. Everything is wrapped: any thrown error is a `continue`. `setActiveTask(id)` before, `setActiveTask(null)` in `finally`. Abort mid-run returns `handled` with `Stopped.` so the coordinator's abort path cancels the task.
- `describePilotHandoff` text starts `The fast lane already did these steps in the browser: 1. ... Then it handed over because <reason>. The page now is "<title>" (<url>).` and never includes typed values.
- [ ] Tests: each branch above; marker set and cleared (also on error and abort); disabled and not-installed pass straight through; the handoff text lists steps, reason and page, with no typed values; a skill throwing is a continue.

### Task 5: HudCoordinator integration

**Files:** Modify `guidance/hud-coordinator.ts`, `guidance/hud-coordinator.test.ts`, `index.ts`.

**Interfaces:** new optional `HudCoordinatorOptions.fastLane?: Pick<FastLane, 'attempt' | 'prewarm'>`. In `executeTaskStandalone`, right before the runner is called: when `fastLane` is set, `await fastLane.attempt({ taskId: running.id, query: query ?? running.prompt, signal: abortController.signal, onUpdate: (t) => sendUpdate?.('WORKING', t) })`; `handled` produces the same `res` shape the runner returns (`status: 'done'`, the summary, no conversation id) and flows through the existing completion code; `continue` runs the agent with `prompt` extended by the addendum. On the hotkey event `fastLane?.prewarm()` is called. Without `fastLane` the code path is byte-for-byte the old one.
- [ ] Tests: no `fastLane` leaves the runner call unchanged (existing tests); handled completes the task with the summary and never calls the runner; continue calls the runner with the addendum appended and the original prompt first; `attempt` throwing still runs the runner; abort after a handled outcome cancels the task; prewarm on hotkey.

### Task 6: Config, CLI commands and wiring

**Files:** Create `fast-lane/config.ts`, `fast-lane/config.test.ts`, `packages/cli/src/commands/fast-lane.ts`, `fast-lane.test.ts`; modify `packages/cli/src/index.ts`, `packages/cli/src/commands/hud.ts`, `README.md`.

**Interfaces:** `readFastLaneConfig(homeDir, env): { enabled: boolean; tier?: 'standard' | 'lite' }` (file then `RH_FAST_LANE`); `writeFastLaneConfig(homeDir, patch)`; `rh fast-lane status | install | enable | disable`: status prints state, model, tier, memory, enabled flag and a next step in plain words; install shows progress and refuses unsupported machines with the reason; enable refuses when not installed ("run `rh fast-lane install` first"); disable always works. `hud listen` builds a `FastLane` only when enabled and status is ready, otherwise prints one line explaining how to turn it on.
- [ ] Tests: config defaults, file, env override, invalid file ignored; each command's output and exit codes with a fake inference; hud wiring passes `fastLane` only when enabled and installed.

## Self-Review

- Spec 4.1 conductor: Tasks 3-4 (skills matched by strict extractors instead of a model call: more precise and instant; the model decides pilot versus brain). Spec 4.5 native skills: Tasks 1-2. Spec 4.8 gate and marker: Task 4 and Global Constraints. Spec section 3 default-off and rollout safety: Task 6.
- Not in this stage: brain briefs and facts (Stage D), trace recording (Stage E), voice, installer, Windows.
