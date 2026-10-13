# Windows browser use: implementation plan

> Stages are done in order, each with tests, a live check where one is possible on this Mac, and a Codex review before the next starts. Nothing is pushed or installed on the user's machine without being asked.

**Goal:** a non-technical person on Windows installs Remote Hands, presses a hotkey, types a task, and the agent (agy, the same as on Mac) does it in a Chrome window quickly. Browser use first; native Windows app control is out of scope for this plan.

**Architecture:** the Mac "fast browser path" is `FastBrowserEngine` (`packages/daemon/src/browser/engine.ts`) running small page scripts through a transport that only needs five methods (`BrowserTransportLike`: `environment`, `evaluate`, `listTabs`, `focusTab`, `openUrl`). On Mac that transport is AppleScript. On Windows it is a new `CdpTransport` that speaks the Chrome DevTools Protocol to a Chrome started with a debugging port, so the same page scripts, rendering, targets and fall-back logic are reused unchanged. Chrome is started and owned by `ChromeManager` in its own "Remote Hands" profile (Chrome 136+ refuses a debugging port on the default profile), so the person signs in to their sites once in that window. The agent runs through the same warm agy process and `rh-computer` MCP server as on Mac. The HUD (hotkey + prompt window) is a small Windows program compiled at setup by the compiler that ships with Windows (`csc.exe`, C# 5), speaking the same JSON-lines protocol as the Swift HUD.

**Tech stack:** Node 22 (global `WebSocket`), TypeScript, vitest; C# 5 / WinForms for the HUD; PowerShell for the one-line installer.

## Global constraints

- macOS behaviour must not change: every Windows branch is selected by platform, and the Mac test suite must keep passing unchanged.
- Windows work cannot be run on this Mac. Anything that only exists on Windows (paths, `tasklist`, `taskkill`, registry, `csc.exe`) is isolated in small functions taking injectable dependencies, unit tested with fakes, and reviewed by Codex. The CDP logic itself is tested live against real Chrome on this Mac (CDP is identical on Windows).
- C# is limited to C# 5 (the compiler built into Windows) and compile-checked here with Roslyn at `-langversion:5`.
- Setup must need no technical knowledge: one command, plain-language prompts, no admin rights, no edits to PATH by hand.

## Stages

### W1. Fast browser path over CDP (`CdpTransport`) and Chrome start-up on Windows
Files: `packages/daemon/src/browser/cdp-transport.ts` (+ test), `chrome-manager.ts` (Windows executable lookup, running check, launch), `computer/session.ts` (choose transport by platform), `browser.ts` CLI helper `findChromeBinary`.
Done when: against a real Chrome on this Mac, `FastBrowserEngine` + `CdpTransport` opens a page, snapshots it, clicks and types; with no Chrome running it starts the Remote Hands Chrome by itself; the Mac path is untouched.

### W2. Agent plumbing on Windows
`which` → a cross-platform lookup (`where`), agy start (`.cmd`/`.exe`), killing the whole agy process tree (`taskkill /T`), MCP registration with paths that contain spaces, `rh-computer` server on Windows (no Mac-only helpers started), call log and config paths.

### W3. Windows HUD
`spotlight-hud.cs` (WinForms, C# 5): global hotkey, borderless black prompt window, progress feed, model picker, JSON-lines protocol identical to the Swift HUD; built at setup with `csc.exe`; run at login (Startup folder shortcut, no admin).

### W4. One-command install and setup
`install.ps1` (Node via winget if missing, `npm i -g remote-hands-cli`, `rh setup`), `rh setup` Windows flow (agy install and sign-in, Chrome check, HUD build and autostart, a final self-test), `rh doctor` for Windows, README and docs.

## Review Focus

- A Chrome that is already running without a debugging port (the person's own Chrome): Remote Hands must not close it, must not corrupt its profile, and must say in plain words what it opens instead.
- Two Chrome windows / several tabs: the right tab is driven, and a tab the person switched to is not acted on by mistake.
- A page that navigates during an action, a tab that closes, a crashed or closed Chrome mid-task: errors become plain messages and the slower fallback still works.
- Paths with spaces and non-ASCII characters (`C:\Users\José Müller\...`), Windows line endings.
- No admin rights, no antivirus-triggering behaviour (no hidden persistence beyond the Startup shortcut the person agreed to).
