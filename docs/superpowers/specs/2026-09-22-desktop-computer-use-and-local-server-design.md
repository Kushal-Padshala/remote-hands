# Architecture Specification: Desktop Computer Use & Embedded Local Server

**Author:** Remote Hands Core Team  
**Date:** 2026-09-22  
**Status:** Approved  
**Target Platform:** macOS (Darwin ARM64/x64) with cross-platform abstractions for Windows  

---

## 1. Executive Summary

Remote Hands is evolving from a browser-only automation tool into a full **autonomous computer use control plane**. This specification defines two major architectural advancements:

1. **Embedded Zero-Account Local Server**: Eliminates mandatory Cloudflare Workers, Cloudflare D1 cloud databases, and Wrangler deployments. When `rh start` or `rh daemon` executes, an embedded, event-driven Node.js HTTP/WebSocket server and local SQLite database start automatically. The web PWA is served directly from the laptop. It consumes <35 MB RAM, operates at 0.0% idle CPU with zero fan spin/heat, and shuts down cleanly on exit.
2. **High-Speed Desktop Computer Use Engine**: Inspired by `typesafe-computer-use`, `BrowserClaw`, and `jev-ultrafast`, the engine uses a **Two-Tier "Macro Planner + Semantic Micro-Loop"** architecture. Antigravity (`agy`) acts as the macro planner for coding and high-level workflows, while a fast local micro-loop operates macOS desktop windows, applications, menus, and controls via pruned accessibility trees (`AXUIElement`), native Vision OCR, and direct event dispatch (`AXPress`) in sub-500ms intervals without slow full-screen VLM roundtrips.

---

## 2. System Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Mobile Client (Smartphone)                      │
│             Phone-first PWA (React + Vite, served locally)             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │  Local Wi-Fi (LAN) or --remote Tunnel
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Remote Hands Embedded Daemon (`packages/daemon`)          │
│                                                                        │
│  ┌─────────────────────────────┐    ┌───────────────────────────────┐  │
│  │   Embedded HTTP & WS Hub    │    │      Local SQLite Database    │  │
│  │  • Serves static PWA bundle │    │  • Tasks, approvals, events   │  │
│  │  • WebSocket task rooms     │    │  • Stored at ~/.remote-hands/ │  │
│  │  • Live frame streaming     │    │    local.db (WAL mode)        │  │
│  └──────────────┬──────────────┘    └───────────────┬───────────────┘  │
│                 │                                   │                  │
│                 ▼                                   ▼                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                   Task Supervisor & Approval Gate                │  │
│  │  • Zero-trust human-in-the-loop gate (`rh approve`)              │  │
│  │  • Ephemeral cryptographic pairing tokens                        │  │
│  └──────────────────────────────┬───────────────────────────────────┘  │
└─────────────────────────────────┼──────────────────────────────────────┘
                                  │
          ┌───────────────────────┴───────────────────────┐
          ▼                                               ▼
┌───────────────────────────────────┐   ┌────────────────────────────────┐
│   Macro Planner: Antigravity CLI  │   │     Desktop & Browser Drivers  │
│              (`agy`)              │   │                                │
│  • Autonomous code generation     │   │  • Chrome CDP Driver           │
│  • Terminal execution & tests     │   │  • macOS Desktop Driver (JXA)  │
│  • Calls `rh browser` &           │   │  • AXUIElement & Vision OCR    │
│    `rh desktop` tools             │   │  • Semantic Micro-Loop         │
└───────────────────────────────────┘   └────────────────────────────────┘
```

---

## 3. Embedded Local Server Subsystem

### 3.1 Motivation & Resource Profile
To remove third-party cloud accounts (Cloudflare Workers, D1) while preventing thermal overhead:
* **Runtime**: Built with native Node.js (`node:http`, `node:crypto`, `node:fs`, and `ws`).
* **Storage**: Local SQLite via `better-sqlite3` or `node:sqlite` stored at `~/.remote-hands/local.db`. Uses `PRAGMA journal_mode = WAL;` and `PRAGMA synchronous = NORMAL;`.
* **Zero Idle Footprint**: When no task is executing and no WebSocket clients are connected, the event loop sleeps. Benchmarked resource usage is <35MB RSS and 0.0% CPU.
* **Lifecycle**: Bound to the terminal process. Starting `rh start` spins up the server; pressing `Ctrl+C` immediately closes all sockets, flushes SQLite transactions, and terminates.

### 3.2 Networking & Connectivity
1. **Local Wi-Fi Mode (Default)**:
   * Detects local network interfaces (`en0`/Wi-Fi).
   * Binds to `0.0.0.0:3000` (or next available port).
   * Generates a terminal QR code encoding `http://<lan-ip>:<port>/?token=<pairing-token>`.
   * Directly accessible by phones on the same Wi-Fi with <5ms latency.
2. **Remote Mode (`--remote`)**:
   * For access outside home Wi-Fi (5G/Cellular) without requiring a Cloudflare account.
   * Automatically invokes `cloudflared tunnel --url http://localhost:3000` in quick tunnel mode, outputting a secure, temporary `https://*.trycloudflare.com` URL.
   * Shuts down the tunnel process when `rh start` exits.

### 3.3 Security & Zero-Trust Pairing
* **Token Generation**: On startup, a 32-byte cryptographic hex token (`crypto.randomBytes(32).toString('hex')`) is created.
* **Timing-Safe Authentication**: Requests require `Authorization: Bearer <token>` or `?token=<token>`. Authenticated using constant-time comparison (`crypto.timingSafeEqual`).
* **Static File Serving**: Serves the prebuilt React PWA from `apps/web/dist` with strict path traversal protections (`path.normalize`, forbidding `..`).

---

## 4. High-Speed Desktop Computer Use Subsystem

### 4.1 The Two-Tier Architecture
Following `typesafe-computer-use` and `jev-ultrafast`:
1. **Macro Planner (`agy`)**: Emits sub-goals (e.g. `rh desktop act "Open Notes, click New Note, and type meeting notes"`).
2. **Semantic Micro-Loop (`desktop-act`)**: Executes locally inside the daemon in tight cycles (<500ms/step):
   * **Observe**: Extracts interactive controls into a numbered 1-based index table.
   * **Select**: Matches the action (`CLICK`, `TYPE_TEXT`, `MENU`, `KEY`, `DONE`) and target index `[N]` using structured heuristics or fast local model.
   * **Act**: Fires native macOS events (`AXPress`, `osascript`, or `CGEvent`).
   * **Verify**: Reads delta state and proceeds to the next sub-step until sub-goal completion.

### 4.2 macOS Native Driver (`packages/daemon/src/desktop/macos-driver.ts`)
Executes direct system calls via JavaScript for Automation (JXA) and AppleScript:
* `openApp(appName: string)`: Launches or brings application to front (`open -a "<app>"`).
* `listWindows()`: Returns array of active applications and window titles.
* `focusWindow(appName: string, windowTitle?: string)`: Sets application to frontmost.
* `closeWindow(appName: string)`: Sends `Cmd+W` or triggers window close button.
* `triggerMenu(appName: string, menuPath: string[])`: Clicks native application menu bar items (`tell process appName to click menu item X of menu Y`).
* `sendKeyCombo(keys: string[], modifiers: string[])`: Dispatches native modifier keystrokes.

### 4.3 Pruned Accessibility Tree Walker (`packages/daemon/src/desktop/ax-walker.ts`)
Reads frontmost application UI hierarchy through macOS Accessibility (`AXUIElement`):
* **Pruning Invariants**:
  * Skip invisible elements or subtrees outside display bounds.
  * Skip layout wrappers (`AXGroup`) lacking accessibility labels.
  * Skip closed menus (`AXMenu`) unless active.
  * Cap at 1,500 interactive nodes or 300ms execution cutoff.
* **Fallback to Vision OCR**: When an application (e.g. Spotify, Electron canvas, terminal) lacks an accessibility tree, calls macOS native Vision OCR (`screencapture` + Vision framework text recognition) to extract clickable text bounding boxes.
* **Element Table Output Format**:
  ```text
  [1] button    "New Document" (ax: AXPress, bounds: [100, 50, 180, 80])
  [2] textfield "Search"       (ax: AXValue, bounds: [200, 50, 450, 80])
  [3] menuitem  "File -> Save" (menu: File/Save)
  ```

### 4.4 Action Primitives & Direct Execution
* `CLICK [N]`: If element has `AXPress` action, dispatches `AXUIElementPerformAction` directly (zero cursor drag delay, no window focus theft). If not, dispatches instant synthetic click via native event tap.
* `TYPE_TEXT [N] "text"`: Sets `AXValue` on focused control; falls back to keystrokes.
* `KEY "combo"`: Dispatches key combinations (`cmd+c`, `cmd+v`, `enter`, `tab`, `escape`).
* `MENU "app" "menu" "item"`: Direct menu trigger.

---

## 5. CLI & Tooling Suite for Antigravity

The daemon adds `rh desktop` to PATH alongside `rh browser`:

```bash
# High-speed semantic goal execution
rh desktop act "<goal>"

# Deterministic direct commands
rh desktop open "<app>"
rh desktop window <list|focus|close|minimize> [app]
rh desktop snapshot [--json]
rh desktop click <index|x,y>
rh desktop type "<text>"
rh desktop key <combo>
rh desktop menu "<app>" "<menu>" "<item>"
```

### System Prompt Injection
In `agy-runner.ts`, `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT` is updated to describe the new desktop capabilities:
* Autonomous code generation + terminal commands + desktop GUI operations in a single task.
* Mandatory `rh approve` gate for sensitive desktop actions (quitting apps with unsaved work, sending messages, deleting data).

---

## 6. Verification & Quality Gates

* **Unit & Integration Tests**:
  * Embedded HTTP/WebSocket server tests (auth token verification, static file serving, task CRUD).
  * macOS driver tests with mock/real JXA scripts (window listing, app focusing).
  * AX walker tests with mock accessibility trees and pruning assertions.
  * CLI parameter parsing and dispatch tests.
* **Safety Invariants**:
  * Zero-trust pairing token on all HTTP/WS endpoints.
  * Strict path sanitization on all static asset endpoints.
  * Clamshell sleep prevention restoration on daemon exit (`disablesleep 0`).
  * Process cleanup: all child processes (tunnels, runners) killed on SIGINT/SIGTERM.
