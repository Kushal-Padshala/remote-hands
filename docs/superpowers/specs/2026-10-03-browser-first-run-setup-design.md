# Browser First-Run Setup Design

Date: 2026-10-03
Status: approved direction in chat ("make it easy ... auto opens or something before the first time")

## Problem

The fast browser path needs two macOS/browser gates that cannot be skipped:

1. macOS Automation permission for the app that runs Remote Hands to control each browser (macOS shows its own prompt the first time an Apple event is sent).
2. The browser's own "Allow JavaScript from Apple Events" setting (Chrome, Brave, Arc, Edge: View > Developer; Safari: Develop menu), off by default.

Open-source users should not have to find these themselves.

## Design

`rh browser setup` (idempotent, interactive, opt-in) plus automatic offers at the moments a user is already at a terminal:

1. **Detect**: for every running supported browser, probe with a harmless `1` evaluate (this also triggers the macOS Automation prompt, which is a normal system dialog the user clicks Allow on).
2. **Automation denied**: print exactly which toggle to switch and open the macOS Automation settings pane (`open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"`), then re-probe after the user presses Enter.
3. **JavaScript from Apple Events off**: explain what it does and what it allows (any app with Automation permission can run JavaScript in your tabs), ask `Enable it in <Browser> now? [Y/n]`, and on yes toggle the menu item through System Events UI scripting (needs the Accessibility permission Remote Hands already asks for; it reads the menu item's check mark first and clicks only if unchecked), then verify with a probe. Safari: the Develop menu must exist; if it does not, print the two manual steps (Safari > Settings > Advanced > Show features for web developers; Develop > Allow JavaScript from Apple Events) instead of changing Safari preferences.
4. **Never silent**: nothing is changed without an explicit yes (or `--yes`), a browser that is not running is skipped with a note (never launched), and the command prints how to undo (`View > Developer > Allow JavaScript from Apple Events` again) and a `--disable` flag that turns it back off.
5. **Where it runs automatically**: `rh hud install`, `rh hud listen` and `rh setup` call the same flow once when stdin is a TTY and a state file (`~/.remote-hands/browser-setup.json`) shows the browser has not been offered yet (a declined browser is not asked again until `rh browser setup` is run explicitly). Non-interactive contexts (launchd, CI) never prompt and never change settings.
6. **When it is still missing at task time**: the fast-path-unavailable note and `rh browser doctor` both point to `rh browser setup`. Without the setting the old Chrome-only CDP/accessibility fallback keeps working, slower.

## Non-goals

- Editing browser preference files or managed-policy plists (browser running overwrites them; policies show an organisation banner).
- Silent enabling; Safari preference changes; Windows/Linux.

## Success criteria

- A new user runs `rh browser setup` (or `rh hud install`) and finishes with at most: one macOS Allow click per browser plus one `y` per browser.
- Re-running is a no-op that reports ✔.
- All logic unit-tested with injected runners (no real browser/System Events in tests); live verification by the user on their own machine.

## Risks

- UI scripting depends on menu titles (English UI) and Accessibility permission; failure falls back to printed manual steps.
- The Automation prompt attributes to the process that sends the Apple event; users must run the setup from the same kind of context they will use (Terminal). A launchd HUD may need its own prompt: documented.
