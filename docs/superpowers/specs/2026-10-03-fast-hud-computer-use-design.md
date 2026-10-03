# Fast HUD Computer Use Design

Date: 2026-10-03
Status: draft, not yet reviewed by the user

## Goal

Make the Spotlight-style HUD feel fast and fun: a typed request that needs a few desktop or browser actions finishes in seconds, not minutes. The model must still come from the user's `agy` (Antigravity CLI) login, with no external API key, and `agy` keeps full terminal and codebase access.

## Measured causes of slowness (2026-10-03, this machine)

1. Every action is a fresh `rh ...` process. `rh desktop window list` 1.7s, `rh browser tabs` 1.07s, `rh desktop snapshot --no-ocr` 1.35s.
2. Desktop actions run Swift through `swift -e <script>`, which compiles on every call (about 0.8s for a trivial script, more for the AX walker). `click <index>` walks the tree and then runs a second `swift -e` for the press. `BrowserDriver.clickIndex` re-snapshots on every click.
3. Actions do not return the new state, so each step costs two model turns (act, then snapshot).
4. Raw snapshots contain about 300 AX nodes, many of them `AXStaticText ""` noise.
5. Each HUD task spawns a cold `agy -p` and re-sends a roughly 10KB prose system prompt. `agy` already adds about 16.8K input tokens of its own tool prompt per turn.

## Design

Keep the HUD, approval gate (`rh approve`), AX engine and `BrowserDriver`. Change the plumbing:

1. **Cached Swift binaries.** A shared `fastExec` replaces the default `exec` in the AX walker, AX actions, menu crawler and `MacOsDriver`. For `swift -e <script>` it hoists top-level literal parameters into environment variables, compiles the parameter-free template once with `swiftc -O`, caches the binary by template hash, then runs the binary. Existing tests that inject their own `exec` are unaffected.
2. **Warm MCP server.** `rh mcp serve` is a stdio MCP server hosting one long-lived `ComputerSession` (cached snapshots, warm drivers). `rh mcp install` registers it with `agy mcp add`. Tools: `desktop_*`, `browser_*`, `computer_batch`. Every mutating tool returns a compact post-action state so the model needs one turn per step.
3. **Compact state.** Noise elements are dropped, labels truncated, output capped, with an optional `filter`.
4. **Warm `agy` session.** `agy --input-format stream-json --output-format stream-json` stays alive across HUD tasks. One process, one system prompt, no cold start. It is pre-warmed when the HUD starts. A slim prompt replaces the prose command manual, since tool schemas now carry that information.

## Non-goals (follow-up plans)

- Local no-LLM fast path for deterministic intents (open app, shortcut).
- Replacing the AX engine or `BrowserDriver` with an open-source engine (Playwright MCP, Chrome DevTools MCP, mcp-server-macos-use, Terminator). Decide after the benchmark in the plan shows what remains slow.
- A persistent Swift AX helper process (only needed if cached binaries are still too slow).

## Success criteria

- `rh desktop snapshot --no-ocr` median under 500ms after the first run (was 1350ms).
- A desktop click through the MCP tool under 400ms including the returned state.
- Second and later HUD tasks start streaming agent output without an `agy` cold start.
- All existing tests still pass.

## Risks

- `swiftc` behaviour can differ from `swift -e`; mitigated by a darwin-only test that type-checks every real script template.
- `agy` stream-json multi-turn behaviour is only documented in `--help`; the plan starts with a probe.
- `~/.remote-hands/cli/index.js` (what `rh` runs) is a copied bundle, so a rebuild must be installed explicitly.
