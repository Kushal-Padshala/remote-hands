# Architecture Specification: Unified Hybrid Guidance & Annotation Overlay

**Author:** Remote Hands Core Team  
**Date:** 2026-09-23  
**Status:** Approved  
**Target Platform:** macOS (Darwin ARM64/x64) and Google Chrome (via CDP)

---

## 1. Executive Summary

Remote Hands introduces an interactive, high-speed visual guidance and annotation overlay engine. Instead of only executing actions autonomously in the background, Antigravity (`agy`) and Remote Hands can guide the human user interactively by projecting animated floating directional arrows, spotlight cutouts, and step indicators directly over UI elements in both Google Chrome and macOS native desktop applications.

The architecture takes the best architectural patterns from proven open-source systems:
1. **Web (Google Chrome via CDP)**: Adopts the **Driver.js** and **React-Tourlight** architecture—SVG cutout backdrop mask (`fill-rule: evenodd`), hardware-accelerated cubic-bezier transitions between elements, DOM-relative bounding rect calculation, and click-through event passthrough with reactive click interception.
2. **Desktop (macOS System-Wide)**: Adopts the **Glint** and **Annotate** architecture—a lightweight, native AppKit borderless transparent floating panel (`NSPanel` with `.nonactivatingPanel`, `.floating` level, and `ignoresMouseEvents = true`) rendering CoreAnimation vector arrows and pulse rings at 120 FPS without stealing keyboard focus or obstructing user clicks.
3. **Reactive Multi-Step Orchestration**: State machine inspired by **Clickalong** and **Tango**—when the user performs the indicated action (clicks the highlighted button), the overlay detects the event and transitions the arrow to the next target in sub-100ms.

---

## 2. System Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Antigravity Planner (`agy`)                     │
│    Analyzes user goal (e.g. "Show me where to upload a new file")      │
│    Inspects current page/desktop snapshot -> computes target sequence  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Remote Hands Daemon Guidance Orchestrator                 │
│                 (`packages/daemon/src/guidance`)                       │
│                                                                        │
│  ┌─────────────────────────────┐    ┌───────────────────────────────┐  │
│  │   Interactive Guide Session │    │     Target Resolver           │  │
│  │  • Multi-step state machine │    │  • Browser DOM index/selector │  │
│  │  • Auto-advance on click    │    │  • Desktop AX element / bounds│  │
│  │  • Dynamic scroll tracking  │    │  • Real-time viewport mapping │  │
│  └──────────────┬──────────────┘    └───────────────┬───────────────┘  │
└─────────────────┼───────────────────────────────────┼──────────────────┘
                  │                                   │
      ┌───────────┴───────────┐           ┌───────────┴───────────┐
      ▼ (Browser Context)     │           │ (macOS Desktop)       ▼
┌─────────────────────────────▼──┐     ┌──▼──────────────────────────────┐
│  Chrome CDP Overlay Controller │     │  Native macOS Overlay Helper    │
│  • Injected Driver.js runtime  │     │  • Transparent floating NSPanel │
│  • SVG cutout spotlight        │     │  • CoreAnimation glowing arrow  │
│  • Animated directional arrow  │     │  • AXUIElement bounds tracking  │
│  • Passthrough click listener  │     │  • Click-through event tap      │
└────────────────────────────────┘     └─────────────────────────────────┘
```

---

## 3. Web Guidance Architecture (Google Chrome via CDP)

### 3.1 Zero-Install Runtime Injection
- Injected directly into the active Chrome tab via `Runtime.evaluate` on the existing Chrome DevTools Protocol (CDP) WebSocket connection.
- No Chrome extension installation required. Works on any active tab, including private intranets, GitHub, AWS Console, or local development ports.
- Binds to `window.__rhGuide` namespace.

### 3.2 Cutout Mask & Vector Arrow
- **Backdrop**: Smooth dark backdrop (`rgba(0, 0, 0, 0.45)`) rendered via an SVG path overlay utilizing `evenodd` fill rule to clip out a spotlight rectangle matching the target element's exact bounding box with border-radius smoothing.
- **Directional Arrow & Popover**: High-performance SVG floating arrow pointing towards the element (top, right, bottom, or left, selected dynamically based on viewport margins).
- **Smooth Transition**: When switching from step 1 to step 2, CSS `transform` and SVG `d` paths animate using a spring curve (`cubic-bezier(0.16, 1, 0.3, 1)`), gliding the arrow seamlessly to the next button.
- **Click-Through & Advance Detection**: The spotlight area has `pointer-events: auto` to allow the user's click to directly trigger the underlying button while intercepting the mouseup event to notify the daemon and trigger the next step.

---

## 4. Desktop Guidance Architecture (Native macOS)

### 4.1 Transparent Floating Panel
- Compiled native Swift helper (`rh-overlay`) bundled in `packages/daemon/bin/rh-overlay` or driven via JXA/AppKit.
- Uses `NSPanel` with styles `[.borderless, .nonactivatingPanel]`, `level = .floating`, `isOpaque = false`, `backgroundColor = .clear`.
- `ignoresMouseEvents = true` guarantees zero interference with user workflow.
- High refresh rate (ProMotion 120Hz) vector arrow and pulse beacon rendered via CoreAnimation.

### 4.2 Element Targeting via Accessibility
- Uses `AXUIElement` bounds via `ax-walker.ts`.
- Automatically maps desktop app window coordinates to screen global coordinates.
- Listens for global mouse clicks in target bounding box to auto-advance steps.

---

## 5. CLI & Agent Integration

### 5.1 CLI Commands (`rh guide`)
```bash
# Highlight a specific element and point an arrow at it
rh guide show --browser --target="button#upload" --text="Click here to upload"

# Point to an element by its snapshot index
rh guide show --browser --index=4 --text="Upload file"

# Desktop app guidance
rh guide show --desktop --app="Finder" --target="New Folder" --text="Click to create folder"

# Advance or dismiss
rh guide next
rh guide dismiss
```

### 5.2 AGY System Prompt Integration
AGY receives guidance primitives so when a user asks "Show me where to do X", AGY runs `rh browser snapshot`, identifies the button, and executes `rh guide show` instead of clicking autonomously.
