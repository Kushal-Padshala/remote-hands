# Fast HUD Computer Use Design

Date: 2026-10-03
Status: implemented on branch feat/fast-hud-computer-use; pending user review

## Goal

Make the Spotlight-style HUD feel fast and fun: a typed request that needs a few desktop or browser actions finishes in seconds, not minutes. The model must still come from the user's `agy` (Antigravity CLI) login, with no external API key, and `agy` keeps full terminal and codebase access.

## Measured causes of slowness (2026-10-03, this machine)

Baseline medians before the work, from `scripts/bench-actions.mjs` against the installed `rh`: `rh desktop window list` 881 ms, `rh desktop snapshot --no-ocr` 494 ms, `rh browser tabs` 845 ms, `agy` cold turn 5896 ms. An earlier single-run figure of 1350 ms for the snapshot was a first-call outlier and is not used.

1. Every action is a fresh `rh ...` process, so each action pays process start-up on top of the work itself (see the medians above).
2. Desktop actions run Swift through `swift -e <script>`, which compiles on every call (about 0.8s for a trivial script, more for the AX walker). `click <index>` walks the tree and then runs a second `swift -e` for the press. `BrowserDriver.clickIndex` re-snapshots on every click.
3. Actions do not return the new state, so each step costs two model turns (act, then snapshot).
4. Raw snapshots contain about 300 AX nodes, many of them `AXStaticText ""` noise.
5. Each HUD task spawns a cold `agy -p` and re-sends a roughly 10KB prose system prompt. `agy` already adds about 16.8K input tokens of its own tool prompt per turn.

## Design

Keep the HUD, approval gate (`rh approve`), AX engine and `BrowserDriver`. Change the plumbing:

1. **Cached Swift binaries.** A shared `fastExec` replaces the default `exec` in the AX walker, AX actions, menu crawler and `MacOsDriver`. For `swift -e <script>` it hoists top-level literal parameters into environment variables, compiles the parameter-free template once with `swiftc -O`, caches the binary by template hash, then runs the binary. Existing tests that inject their own `exec` are unaffected.
2. **Warm MCP server.** `rh mcp serve` is a stdio MCP server hosting one long-lived `ComputerSession` (cached snapshots, warm drivers). `rh mcp install` registers it with `agy mcp add`. Tools: `desktop_*`, `browser_*`, `computer_batch`. Every mutating tool returns a compact post-action state so the model needs one turn per step. `desktop_click` takes the index from the latest snapshot but does not act on the index alone: the session sends the cached element's bounds and role to the AX action with strict matching, so a UI that changed since the snapshot fails with `no longer present` instead of pressing a different element. Tool results can carry `note:` lines, for example when AX press is unsupported and a physical click at the element center was used.
3. **Compact state.** Noise elements are dropped, labels truncated, output capped, with an optional `filter`.
4. **Warm `agy` session.** `agy --input-format stream-json --output-format stream-json` stays alive across HUD tasks. One process, one system prompt, no cold start. It is pre-warmed when the HUD starts listening, using the HUD task mode so the prewarmed process matches the one the first task needs. There is no per-turn timeout (`--print-timeout 0`); cancel kills the process and the next turn respawns it. A slim prompt replaces the prose command manual, since tool schemas now carry that information.

## Non-goals (follow-up plans)

- Local no-LLM fast path for deterministic intents (open app, shortcut).
- Replacing the AX engine or `BrowserDriver` with an open-source engine (Playwright MCP, Chrome DevTools MCP, mcp-server-macos-use, Terminator). Decide after the benchmark in the plan shows what remains slow.
- A persistent Swift AX helper process (only needed if cached binaries are still too slow).

## Success criteria

- AX script execution about 10x faster than the `swift -e` path it replaces; `rh desktop snapshot --no-ocr` end to end 494 ms to about 350 ms, including process start-up.
- Second and later turns within one HUD conversation run without the `agy` cold start. Each hotkey press starts a fresh conversation: the warm process is kept when it is idle and has never served a turn, otherwise it is respawned.
- All tests pass.

### Measurements so far

- Snapshot: the implementer measured 1216 ms for the uncached snapshot on a loaded machine; the controller's earlier bench baseline for `rh desktop snapshot --no-ocr` was 494 ms (installed `rh`). Medians of the cached path were about 330-368 ms; they exclude a one-time compile of 2.4-3.1 s per template. The improvement is about 1.4x against the 494 ms baseline and about 3x against 1216 ms.
- AX action script alone (implementer, 7-run median on the repo build): 711 ms to 73 ms, about 10x.
- Warm `agy` session (real `agy`, gemini-3.8-flash, low effort): first turn 22.2 s cold (`agy` loads its MCP servers), second turn 3.2 s, turn after an abort 7.1 s. These figures were measured before `rh-computer` was registered with `agy`; end-to-end timings with the MCP server are still to be recorded.
- End-to-end HUD timings are still to be recorded after the CLI bundle is installed and the HUD is run.

## Risks

- `swiftc` behaviour can differ from `swift -e`; mitigated by a darwin-only test that type-checks every real script template.
- `agy` stream-json multi-turn behaviour is only documented in `--help`; the plan starts with a probe.
- `~/.remote-hands/cli/index.js` (what `rh` runs) is a copied bundle, so a rebuild must be installed explicitly.
