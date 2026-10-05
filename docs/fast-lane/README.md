# Fast lane

A small decision model that runs on your Mac and handles simple requests in about a second. The agent (agy) stays in charge of anything hard.

## Turn it on

```bash
rh fast-lane install    # downloads the model once (free); `--tier=standard|lite` to choose its size
rh fast-lane enable     # on; takes effect for the next request, no restart needed
rh fast-lane status
rh fast-lane disable    # off: requests go straight to the agent, as before
```

Requirements: macOS, 8GB of memory or more (16GB gets the stronger model). The model is Apache-2.0 licensed and stays on your machine. Setting `RH_FAST_LANE=1` or `0` overrides the setting for one run.

## What it does

When you type a request in the HUD, the fast lane looks at it first:

| Request | What happens | Typical time |
|---|---|---|
| "open spotify", "launch Notes" | opens the app (only apps installed on this Mac) | about 1s |
| "open example.com" | opens the link in your browser (http and https only) | about 1s |
| "make a note called groceries with milk and eggs" | creates the note in Notes | about 1-2s |
| "text John saying I'm running late" | asks for your approval on your phone, then sends | your tap + 1-2s |
| "volume up", "mute", "pause" | changes the volume or controls Spotify/Music | about 1s |
| a web page is open and you ask to click through, fill in or move through it | the pilot reads the page, picks the next click one step at a time | 2-3s for a few steps |
| anything else (write, research, code, questions, other apps) | goes to the agent, untouched | unchanged |

If the fast lane is unsure, loops, gets blocked, or runs out of its time budget, it stops and hands the request to the agent with a note of the steps it already did, so nothing is repeated.

## Safety

- The local model only **chooses** among a fixed list of options. It never writes commands, scripts or text to type.
- Anything irreversible (sending a message, buying, deleting, posting) goes through the same approval as the agent, and a rejection stops the fast lane.
- Page content is treated as untrusted data: it cannot give the model new orders, and a link that says "ignore your instructions" is just a link.
- User text reaches the Mac only as data (never inside a script or shell command).
- Nothing is sent anywhere: the model runs locally and the fast lane makes no network calls other than the one-time download.

## Measured on an M4 with 16GB (honest numbers)

Model choice came from a bake-off (`docs/fast-lane/bake-off-2026-10-04.md`). End to end, against simulated websites rendered by the real engine, with the real model:

- 16GB tier (Qwen3 4B Instruct): login 3 steps in about 2.2s, a 5-page wizard in about 2.5s, "download my invoice" next to a page that tries to give orders: done in 0.9s and the page's instructions ignored. About 0.4-0.7s per decision.
- It stops and hands over instead of guessing on pages it does not understand (an unrelated page, a ranking widget in a survey), and never places an order without approval.
- 8GB tier (Qwen3.5 2B): simple flows work (the wizard), but it hands over more often than the 16GB model. People with 8GB can choose the stronger model with `rh fast-lane install --tier=standard`, at the cost of memory.
- Not measured: Intel Macs, real browsers (only simulated pages), heavy multitasking, battery.

## Limits (v1)

- macOS only. Windows and Linux need a different way of reading the screen.
- Web pages: only browsers the existing browser tools support. Pages with no readable controls (canvas, unlabeled UI) go to the agent.
- Subjective choices (which answers to give in a survey) need the agent to say what to answer; the pilot handles the clicking.
- Voice input, an installer for non-technical people, and learning saved shortcuts from your own runs are designed (see the spec) but not built yet.

## Where things live

- Local files: `~/.remote-hands/fast-lane/` (`runtime/`, `models/`, `config.json`, `state.json`). Delete the folder to remove everything.
- Code: `packages/daemon/src/fast-lane/` (`inference/` the local model service, `pilot/` the page pilot, `skills/` the instant skills, `conductor.ts` and `fast-lane.ts` the routing).
- Spec: `docs/superpowers/specs/2026-10-04-fast-lane-design.md`.

## For developers

```bash
npx vitest run packages/daemon/src/fast-lane     # hermetic unit and scripted acceptance tests
# live tests against the real model (need llama-server and a GGUF, see the headers of these files):
RH_FASTLANE_LIVE=1 FAST_LANE_SERVER_PATH=... FAST_LANE_MODEL_PATH=... npx vitest run \
  packages/daemon/src/fast-lane/inference/live.test.ts \
  packages/daemon/src/fast-lane/pilot/acceptance.live.test.ts \
  packages/daemon/src/fast-lane/conductor.live.test.ts
```
