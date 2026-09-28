# At-Mention Context Tagging Architecture & Design

## Overview
This specification details the `@-mention` context tagging system for Remote Hands. It enables users to type `@` in either the native macOS Spotlight HUD overlay (`Shift + Cmd + Space`) or the Web/Mobile PWA, opening an intelligent drill-down menu to attach specific browser tabs (Chrome, Arc, Brave, Safari, Edge), profiles, desktop app windows, and local files directly to an agent task.

The attached context items are formatted into structured metadata and injected into the agent's task prompt, enabling zero-discovery, instantaneous targeting of pre-authenticated tabs and local assets at blazing speed.

---

## 1. Domain Models & Types

Shared definitions located in `packages/shared/src/context-attachment.ts`:

```typescript
export type ContextAttachmentType = 'browser_tab' | 'app_window' | 'local_file';

export interface BrowserTabAttachment {
  type: 'browser_tab';
  id: string;
  browser: string;
  profile?: string;
  title: string;
  url: string;
  tabIndex?: number;
}

export interface AppWindowAttachment {
  type: 'app_window';
  id: string;
  app: string;
  title?: string;
  windowId?: number | string;
}

export interface LocalFileAttachment {
  type: 'local_file';
  id: string;
  path: string;
  name: string;
  sizeBytes?: number;
  isDir?: boolean;
}

export type ContextAttachment = BrowserTabAttachment | AppWindowAttachment | LocalFileAttachment;

export interface ContextBrowserProfile {
  id: string;
  name: string;
  tabs: Array<{
    id: string;
    title: string;
    url: string;
    tabIndex?: number;
  }>;
}

export interface ContextBrowserTarget {
  id: string;
  name: string;
  profiles: ContextBrowserProfile[];
}

export interface ContextAppTarget {
  id: string;
  name: string;
  windows: Array<{
    id: string;
    title: string;
  }>;
}

export interface ContextFileTarget {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
}

export interface ContextHierarchy {
  browsers: ContextBrowserTarget[];
  apps: ContextAppTarget[];
  files: ContextFileTarget[];
}
```

The `Task` interface in `packages/shared/src/api.ts` is updated to include:
```typescript
attachments?: ContextAttachment[] | undefined;
```

---

## 2. Daemon Context Service

Located in `packages/daemon/src/context/context-service.ts`:

- **Browser Tab Inspector**:
  - Chrome: Discovers tabs and profiles via CDP connection and local Chrome profile structures.
  - Arc, Brave, Safari, Edge: Queries active tabs via JXA / AppleScript without opening or altering windows.
- **Desktop Window Inspector**:
  - Uses `MacOsDriver` / Accessibility APIs to list non-background visible application windows.
- **Local File Inspector**:
  - Queries recent files, `~/Downloads`, `~/Desktop`, and the current workspace directory.
- **Methods**:
  - `getHierarchy(): Promise<ContextHierarchy>`
  - `filterTargets(query: string): Promise<ContextHierarchy>`

---

## 3. CLI Command & Daemon Server Endpoint

- **CLI**: `rh context list [--json]` implemented in `packages/cli/src/commands/context.ts`.
- **Daemon HTTP Endpoint**: `GET /api/context/targets` implemented in the local daemon server for the Web PWA.

---

## 4. Prompt Context Injection

In `packages/daemon/src/guidance/hud-coordinator.ts` and `packages/daemon/src/hermes-brain.ts`:

When `task.attachments` is present, the prompt builder appends:
```text
[Active User Attachments:
- Tab: [Google Chrome - Profile: Personal] "Property Details" -> https://example.com/prop/101 (Tab Index: 2)
- Tab: [Arc] "Meta Ads Manager" -> https://adsmanager.facebook.com/campaigns
- Local Asset: "/Users/kushal/Downloads/banner.png"

Mandate: The user pre-attached these exact resources. Target and interact with them directly using `rh browser focus` or reading the file. Never execute exploratory discovery scans.]
```

---

## 5. Frontend & UI Implementation

### Web / Mobile PWA (`apps/web`):
- `AtMentionDropdown.tsx`:
  - Detects `@` in the prompt input textarea.
  - Renders floating dropdown tethered to the caret / input bar.
  - Level 1: Category list (`Browsers`, `Running Apps`, `Files`).
  - Level 2: Browsers list profiles (auto-skips if only 1 profile).
  - Level 3: Open tabs with instant search input and multi-select checkboxes.
  - Clicking "Done" or pressing Enter commits selections.
- `AttachmentChips.tsx`:
  - Displays selected items as interactive pill chips above the input bar.
  - Displays icon, browser/app name, title, and an `×` button to remove.

### Native macOS Spotlight HUD (`spotlight-hud.swift`):
- Detects `@` character typed in `NSTextField`.
- Opens an AppKit floating popover window below the search bar.
- Populates data from `rh context list --json`.
- Supports keyboard navigation (Up/Down/Enter) and click multi-selection.
- Appends selected items as removable token chips into the HUD input container.
- Passes `attachments` in the JSON payload to `HudCoordinator`.
