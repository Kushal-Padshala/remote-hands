---
name: remote-hands-operator
description: Use when automating computer tasks via Remote Hands, controlling web browsers, interacting with native macOS applications, switching between windows and tabs, or executing cross-app desktop workflows.
---

# Remote Hands Operator

Unified system operator skill for controlling web browsers, native macOS desktop applications, terminal workspaces, and window environments at maximum speed through Remote Hands (`rh`).

## Overview

Remote Hands turns the host operating system into an ultra-low latency, deterministic automation canvas. This skill dictates how agents navigate between running browser profiles, manage application windows, execute coding instructions, and request user approvals without exploratory stalls or UI disruption.

## When to Use

- Operating web browsers on active, authenticated user profiles.
- Switching between browser tabs or finding specific open documents/pages without creating duplicates.
- Automating native macOS desktop software (VS Code, Xcode, Finder, Slack, Terminal, System Settings).
- Performing end-to-end tasks spanning both codebase files and GUI applications.
- Guiding the user visually using targeted UI arrows and highlight annotations.
- Requesting mobile human approval before publishing, financial, or destructive operations.

## When NOT to Use

- Plain HTTP requests for public static web data where `curl` or standard fetch suffices without browser sessions.
- Isolated filesystem edits where no GUI inspection, browser interaction, or desktop window management is required.

## Speed Mandate: Zero Discovery

Agents operating Remote Hands must begin execution immediately on the primary objective.
Exploratory diagnostic commands are strictly forbidden:
- Never run `which rh`, `rh --help`, `rh browser --help`, `rh desktop --help`, `rh profiles`, or test approval calls.
- All CLI utilities (`rh browser`, `rh desktop`, `rh guide`, `rh approve`) are pre-installed in `PATH` and available instantly.
- Jump directly to the relevant files, tabs, or application windows.

## Browser Automation & In-Place Tab Continuity

Chrome is pre-launched and authenticated with the user's primary personal profile (logged into Google, GitHub, X, etc.).

### Tab Continuity Rules
- Never query or read local SQLite cookie files or Keychain passwords.
- Always inspect existing open tabs before navigating to avoid opening duplicate windows or tabs.
- If the required service or URL is already open in any window or tab, focus that existing tab directly in-place.
- Never steal window focus unnecessarily; keep user workflows uninterrupted.

### Browser Workflow

1. Inspect open tabs:
```bash
rh browser tabs
```

2. Focus an existing tab by index, title, or URL substring:
```bash
rh browser focus "github.com"
```

3. Open a URL only if not already open (reuses matching tabs automatically):
```bash
rh browser open "https://github.com/pulls"
```

4. Inspect the interactive DOM elements:
```bash
rh browser snapshot
```

5. Click interactive elements by numeric index:
```bash
rh browser click 14
```

6. Type into inputs by numeric index:
```bash
rh browser type 3 "Antigravity Remote Hands"
```

### Advanced In-Place Browser Scripting

For complex sequences, table scraping, or custom multi-step actions:
```bash
browser-harness <<'PY'
print(page_info())
PY
```

Available pre-imported helpers in `browser-harness`:
- `page_info()`
- `list_tabs()`
- `switch_tab(id)`
- `goto_url(url)`
- `click_at_xy(x, y)`
- `fill_input(selector, text)`
- `type_text(text)`
- `press_key(key)`
- `scroll(x, y, dy)`
- `js("expression")`
- `wait_for_load()`
- `wait_for_element(selector)`

## Native Desktop & Window Management

Control native macOS software using accessibility-driven inspection, native accessibility actions, and menu bar search.

### Zero Screenshots & Instant Accessibility Mandate

Never capture screenshots or run vision loops for desktop automation. Screen capture is strictly prohibited during autonomous execution. Speak directly to the application layer using Accessibility APIs and native menu commands:
- `rh desktop menu-search <app> "<item>"`: Trigger any application menu item instantly (<5ms)
- `rh desktop menu-list <app>`: Inspect available native application menus
- `rh desktop ax-action <app> <index> [action]`: Execute accessibility action directly on a control (e.g. `AXPress`)
- `rh desktop key <combo>`: Send native keyboard shortcuts
- `rh desktop snapshot`: Fast semantic inspection of the UI element hierarchy

### Window Operations

1. List all active application windows:
```bash
rh desktop window list
```

2. Focus a native window:
```bash
rh desktop window focus "Visual Studio Code"
```

3. Open or launch an application:
```bash
rh desktop open "Slack"
```

### UI Interaction

1. Snapshot the native UI hierarchy:
```bash
rh desktop snapshot
```

2. Execute direct accessibility action on control (instant <5ms, no mouse movement):
```bash
rh desktop ax-action "Bambu Studio" 5 AXPress
```

3. Fuzzy search and execute application menu bar items instantly:
```bash
rh desktop menu-search "Bambu Studio" "Import 3D Model"
```

4. List application menu hierarchy:
```bash
rh desktop menu-list "Bambu Studio"
```

5. Click a native control by numeric index:
```bash
rh desktop click 5
```

6. Type into the focused control:
```bash
rh desktop type "New Project"
```

7. Execute keyboard shortcuts:
```bash
rh desktop key "cmd+s"
rh desktop key "enter"
```

8. Select application menu bar items:
```bash
rh desktop menu "Code" "File" "Save All"
```

9. High-level goal automation:
```bash
rh desktop act "create a new file named test.py"
```

## Interactive Guidance Overlays

When the user asks "how do I...", "where do I click...", "point to...", or "show me where to...":
Do NOT click the button autonomously. Project an interactive arrow overlay over the target UI element.

### Browser Guidance
```bash
rh guide show --browser --index=12 --text="Click to create repository"
```

### Desktop Guidance
```bash
rh guide show --desktop --app="Slack" --target="Channels" --text="Find project channel"
```

### Guidance Navigation
```bash
rh guide next
rh guide dismiss
```

## Human-in-the-Loop Approval Protocol

Before performing sensitive, irreversible, financial, or public actions:
- Publishing or posting content to social media (X, LinkedIn).
- Deleting files, branches, or repositories.
- Sending emails or direct messages.
- Submitting payments or subscriptions.
- Deploying to production environments.

You MUST request approval on the user's paired mobile device:
```bash
rh approve "Post announcement tweet to @account: Launching Remote Hands 2.0" --risk=high --action=publish
```

### Protocol Handling
- Exit status `0`: Human approval granted. Execute the action immediately without asking again.
- Exit status `1`: Approval rejected. Read stderr for the user's rejection reason (`Approval rejected by user: <reason>`). Modify the proposed content or action according to the feedback and re-request approval, or terminate if instructed.
- When resuming with `[HUMAN APPROVAL GRANTED]`, proceed directly to execution.

## Quick Reference

| Action | Command |
|---|---|
| List browser tabs | `rh browser tabs` |
| Focus browser tab | `rh browser focus <index\|url\|title>` |
| Open URL (with auto-reuse) | `rh browser open "<url>"` |
| Snapshot browser DOM | `rh browser snapshot` |
| Click browser element | `rh browser click <index>` |
| Type into browser field | `rh browser type <index> "<text>"` |
| List desktop windows | `rh desktop window list` |
| Focus desktop window | `rh desktop window focus "<app>"` |
| Snapshot desktop UI | `rh desktop snapshot` |
| Execute accessibility action | `rh desktop ax-action <app> <index> [action]` |
| Search and trigger menu | `rh desktop menu-search <app> "<item>"` |
| List app menu bar items | `rh desktop menu-list <app>` |
| Click desktop element | `rh desktop click <index>` |
| Type desktop text | `rh desktop type "<text>"` |
| Send keyboard shortcut | `rh desktop key "<combo>"` |
| Select menu item | `rh desktop menu "<app>" "<menu>" "<item>"` |
| Show browser guidance arrow | `rh guide show --browser --index=<idx> --text="<msg>"` |
| Show desktop guidance arrow | `rh guide show --desktop --app="<app>" --target="<btn>" --text="<msg>"` |
| Request phone approval | `rh approve "<summary>" [--risk=high] [--action=publish\|delete\|push\|pay\|send]` |

## Common Mistakes & Rationalization Table

| Rationalization / Mistake | Reality & Correct Behavior |
|---|---|
| "I should run `rh --help` to inspect arguments." | Never run discovery commands. All commands match the syntax in this guide. |
| "I should capture screenshots or use vision to find buttons." | Never take screenshots. Use `rh desktop snapshot`, `rh desktop ax-action`, or `rh desktop menu-search` directly. |
| "I need to open a new tab for each site." | Always check `rh browser tabs` first. Switch to existing tabs in-place with `rh browser focus`. |
| "I should scrape SQLite cookie databases to authenticate." | Chrome is already authenticated with the user's active session. Use the browser directly. |
| "I will click the button for the user when they asked 'where is'." | When asked 'where is' or 'how do I', use `rh guide show` to project an interactive arrow. |
| "I can post or delete without approval if the prompt said 'do it'." | Irreversible or public actions strictly require `rh approve` before execution. |
| "The user rejected my approval so I should retry the exact same request." | Read the rejection reason from stderr, revise the content or approach, and re-request approval. |
