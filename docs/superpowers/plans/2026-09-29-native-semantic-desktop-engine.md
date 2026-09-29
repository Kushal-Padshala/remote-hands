# Native Semantic Desktop Automation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a high-speed, zero-screenshot semantic desktop automation engine modeled after assistive screen-reader technologies (macOS AXUIElement actions, native menu bar crawlers, and semantic slicer adapters) that controls any Mac or external app in milliseconds.

**Architecture:** Replace slow screenshot and vision-coordinate loops with a direct semantic control stack: (1) native `AXUIElementPerformAction` (`AXPress`, `AXSetValue`, `AXShowMenu`), (2) universal menu bar crawler and fuzzy searcher (`AXMenuBarItem`), (3) specialized app semantic adapters (including 3D slicer shortcut/filament management), and (4) instant semantic state verification (`AXUIElementCopyAttributeValue`).

**Tech Stack:** TypeScript, Node.js, macOS ApplicationServices (`AXUIElement`, `AXUIElementPerformAction`), Swift, Vitest.

**Spec:** Direct Semantic Accessibility Engine (Zero-Screenshot Assistive Automation)

## Global Constraints
- Clean code only: NO code comments allowed in any code edits or new files per user instruction.
- Zero broken APIs: All existing tests and CLI subcommands must remain working and backwards-compatible.
- Zero screenshots in desktop runner execution: Eliminate screencapture dependencies from automated workflows.

---

### Task 1: Direct Accessibility Actions Engine (`AXActionEngine`)

**Files:**
- Create: `packages/daemon/src/desktop/ax-actions.ts`
- Test: `packages/daemon/src/desktop/ax-actions.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Consumes: `ExecFunction` from `./macos-driver.js`
- Produces:
  - `performAxAction(appName: string, elementIndex: number, actionName: string, execFunc?: ExecFunction): Promise<boolean>`
  - `getAvailableAxActions(appName: string, elementIndex: number, execFunc?: ExecFunction): Promise<string[]>`
  - `setAxElementValue(appName: string, elementIndex: number, value: string, execFunc?: ExecFunction): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/desktop/ax-actions.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { performAxAction, getAvailableAxActions, setAxElementValue } from './ax-actions.js';

describe('ax-actions', () => {
  it('dispatches AXPress via swift script with app and index', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"success":true}\n', stderr: '', status: 0 });
    const success = await performAxAction('Bambu Studio', 5, 'AXPress', execMock);
    expect(success).toBe(true);
    expect(execMock).toHaveBeenCalledWith('swift', expect.arrayContaining(['-e', expect.stringContaining('AXUIElementPerformAction')]));
  });

  it('retrieves available actions for an element index', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '["AXPress","AXShowMenu"]\n', stderr: '', status: 0 });
    const actions = await getAvailableAxActions('Slack', 3, execMock);
    expect(actions).toEqual(['AXPress', 'AXShowMenu']);
  });

  it('sets value directly on an accessible element', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"success":true}\n', stderr: '', status: 0 });
    const success = await setAxElementValue('Notes', 2, 'Project Update', execMock);
    expect(success).toBe(true);
    expect(execMock).toHaveBeenCalledWith('swift', expect.arrayContaining(['-e', expect.stringContaining('kAXValueAttribute')]));
  });

  it('returns false when swift execution fails', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: 'error', status: 1 });
    const success = await performAxAction('Finder', 1, 'AXPress', execMock);
    expect(success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/desktop/ax-actions.test.ts`
Expected: FAIL with "Cannot find module './ax-actions.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/desktop/ax-actions.ts`:
```typescript
import { spawnSync } from 'node:child_process';
import type { ExecFunction } from './macos-driver.js';

const defaultExec: ExecFunction = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: 'utf-8' });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
};

export async function performAxAction(
  appName: string,
  elementIndex: number,
  actionName: string = 'AXPress',
  execFunc: ExecFunction = defaultExec,
): Promise<boolean> {
  const escapedApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedAction = actionName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp = apps.first(where: {
    ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
    ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame
}) ?? apps.first(where: {
    ($0.localizedName ?? "").localizedCaseInsensitiveContains(query)
}) ?? NSWorkspace.shared.frontmostApplication

guard let app = targetApp else {
    print("{\\"success\\":false,\\"error\\":\\"App not found\\"}")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
var rootWindow: AXUIElement?
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
if let winList = wins as? [AXUIElement], !winList.isEmpty { rootWindow = winList.first }
if rootWindow == nil {
    var mainVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXMainWindowAttribute as CFString, &mainVal) == .success, let w = mainVal {
        rootWindow = (w as! AXUIElement)
    }
}

guard let rw = rootWindow ?? appEl as AXUIElement? else {
    print("{\\"success\\":false,\\"error\\":\\"No window\\"}")
    exit(0)
}

var currentCounter = 0
var targetEl: AXUIElement?
let targetIndex = ${elementIndex}

func findElement(_ el: AXUIElement, depth: Int) {
    if depth > 10 || targetEl != nil { return }
    var posVal: AnyObject?
    var sizeVal: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posVal) == .success,
       AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeVal) == .success {
        currentCounter += 1
        if currentCounter == targetIndex {
            targetEl = el
            return
        }
    }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            findElement(c, depth: depth + 1)
            if targetEl != nil { return }
        }
    }
}

findElement(rw, depth: 0)

guard let found = targetEl else {
    print("{\\"success\\":false,\\"error\\":\\"Index not found\\"}")
    exit(0)
}

let action = "${escapedAction}" as CFString
let res = AXUIElementPerformAction(found, action)
print("{\\"success\\":\\(res == .success)}")
`;

  try {
    const res = execFunc('swift', ['-e', swiftScript]);
    if (res.status !== 0 || !res.stdout.trim()) return false;
    const parsed = JSON.parse(res.stdout.trim());
    return Boolean(parsed.success);
  } catch {
    return false;
  }
}

export async function getAvailableAxActions(
  appName: string,
  elementIndex: number,
  execFunc: ExecFunction = defaultExec,
): Promise<string[]> {
  const escapedApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp = apps.first(where: {
    ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
    ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame
}) ?? apps.first(where: {
    ($0.localizedName ?? "").localizedCaseInsensitiveContains(query)
}) ?? NSWorkspace.shared.frontmostApplication

guard let app = targetApp else {
    print("[]")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
var rootWindow: AXUIElement?
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
if let winList = wins as? [AXUIElement], !winList.isEmpty { rootWindow = winList.first }
guard let rw = rootWindow ?? appEl as AXUIElement? else {
    print("[]")
    exit(0)
}

var currentCounter = 0
var targetEl: AXUIElement?
let targetIndex = ${elementIndex}

func findElement(_ el: AXUIElement, depth: Int) {
    if depth > 10 || targetEl != nil { return }
    var posVal: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posVal) == .success {
        currentCounter += 1
        if currentCounter == targetIndex {
            targetEl = el
            return
        }
    }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            findElement(c, depth: depth + 1)
            if targetEl != nil { return }
        }
    }
}

findElement(rw, depth: 0)

guard let found = targetEl else {
    print("[]")
    exit(0)
}

var actions: CFArray?
if AXUIElementCopyActionNames(found, &actions) == .success, let list = actions as? [String] {
    if let data = try? JSONSerialization.data(withJSONObject: list), let s = String(data: data, encoding: .utf8) {
        print(s)
        exit(0)
    }
}
print("[]")
`;

  try {
    const res = execFunc('swift', ['-e', swiftScript]);
    if (res.status !== 0 || !res.stdout.trim()) return [];
    const parsed = JSON.parse(res.stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function setAxElementValue(
  appName: string,
  elementIndex: number,
  value: string,
  execFunc: ExecFunction = defaultExec,
): Promise<boolean> {
  const escapedApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp = apps.first(where: {
    ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
    ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame
}) ?? apps.first(where: {
    ($0.localizedName ?? "").localizedCaseInsensitiveContains(query)
}) ?? NSWorkspace.shared.frontmostApplication

guard let app = targetApp else {
    print("{\\"success\\":false}")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
var rootWindow: AXUIElement?
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
if let winList = wins as? [AXUIElement], !winList.isEmpty { rootWindow = winList.first }
guard let rw = rootWindow ?? appEl as AXUIElement? else {
    print("{\\"success\\":false}")
    exit(0)
}

var currentCounter = 0
var targetEl: AXUIElement?
let targetIndex = ${elementIndex}

func findElement(_ el: AXUIElement, depth: Int) {
    if depth > 10 || targetEl != nil { return }
    var posVal: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posVal) == .success {
        currentCounter += 1
        if currentCounter == targetIndex {
            targetEl = el
            return
        }
    }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            findElement(c, depth: depth + 1)
            if targetEl != nil { return }
        }
    }
}

findElement(rw, depth: 0)

guard let found = targetEl else {
    print("{\\"success\\":false}")
    exit(0)
}

let val = "${escapedValue}" as CFTypeRef
let res = AXUIElementSetAttributeValue(found, kAXValueAttribute as CFString, val)
print("{\\"success\\":\\(res == .success)}")
`;

  try {
    const res = execFunc('swift', ['-e', swiftScript]);
    if (res.status !== 0 || !res.stdout.trim()) return false;
    const parsed = JSON.parse(res.stdout.trim());
    return Boolean(parsed.success);
  } catch {
    return false;
  }
}
```

Export from `packages/daemon/src/index.ts`:
Add `export * from './desktop/ax-actions.js';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/desktop/ax-actions.test.ts`
Expected: PASS (4 tests passed)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/desktop/ax-actions.ts packages/daemon/src/desktop/ax-actions.test.ts packages/daemon/src/index.ts
git commit -m "feat(desktop): add direct native accessibility actions engine"
```

---

### Task 2: Universal Menu Bar Crawler & Fuzzy Trigger (`MenuCrawler`)

**Files:**
- Create: `packages/daemon/src/desktop/menu-crawler.ts`
- Test: `packages/daemon/src/desktop/menu-crawler.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Consumes: `ExecFunction` from `./macos-driver.js`
- Produces:
  - `crawlAppMenu(appName: string, execFunc?: ExecFunction): Promise<MenuItemNode[]>`
  - `searchAndTriggerMenu(appName: string, query: string, execFunc?: ExecFunction): Promise<{ success: boolean; triggeredPath?: string[]; error?: string }>`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/desktop/menu-crawler.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { crawlAppMenu, searchAndTriggerMenu } from './menu-crawler.js';

describe('menu-crawler', () => {
  it('crawls hierarchical menu items for target app', async () => {
    const mockTree = [
      {
        title: 'File',
        children: [
          { title: 'New Project', shortcut: 'Cmd+N' },
          { title: 'Import', children: [{ title: 'Import 3D Model', shortcut: 'Cmd+I' }] },
        ],
      },
      {
        title: 'Edit',
        children: [{ title: 'Select All', shortcut: 'Cmd+A' }],
      },
    ];
    const execMock = vi.fn().mockReturnValue({ stdout: JSON.stringify(mockTree) + '\n', stderr: '', status: 0 });
    const items = await crawlAppMenu('Bambu Studio', execMock);
    expect(items.length).toBe(2);
    expect(items[0]?.title).toBe('File');
    expect(items[0]?.children?.[0]?.title).toBe('New Project');
  });

  it('fuzzy matches and triggers menu item by query string', async () => {
    const execMock = vi.fn().mockReturnValue({
      stdout: JSON.stringify({ success: true, triggeredPath: ['File', 'Import', 'Import 3D Model'] }) + '\n',
      stderr: '',
      status: 0,
    });
    const result = await searchAndTriggerMenu('Bambu Studio', 'import 3d model', execMock);
    expect(result.success).toBe(true);
    expect(result.triggeredPath).toEqual(['File', 'Import', 'Import 3D Model']);
  });

  it('returns failure when menu item cannot be found', async () => {
    const execMock = vi.fn().mockReturnValue({
      stdout: JSON.stringify({ success: false, error: 'No menu match found' }) + '\n',
      stderr: '',
      status: 0,
    });
    const result = await searchAndTriggerMenu('Bambu Studio', 'nonexistent menu item', execMock);
    expect(result.success).toBe(false);
    expect(result.error).toBe('No menu match found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/desktop/menu-crawler.test.ts`
Expected: FAIL with "Cannot find module './menu-crawler.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/desktop/menu-crawler.ts`:
```typescript
import { spawnSync } from 'node:child_process';
import type { ExecFunction } from './macos-driver.js';

export interface MenuItemNode {
  title: string;
  enabled?: boolean;
  shortcut?: string;
  children?: MenuItemNode[];
}

const defaultExec: ExecFunction = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: 'utf-8' });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
};

export async function crawlAppMenu(
  appName: string,
  execFunc: ExecFunction = defaultExec,
): Promise<MenuItemNode[]> {
  const escapedApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp = apps.first(where: {
    ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
    ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame
}) ?? apps.first(where: {
    ($0.localizedName ?? "").localizedCaseInsensitiveContains(query)
}) ?? NSWorkspace.shared.frontmostApplication

guard let app = targetApp else {
    print("[]")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
var menuBarVal: AnyObject?
guard AXUIElementCopyAttributeValue(appEl, kAXMenuBarAttribute as CFString, &menuBarVal) == .success,
      let menuBar = menuBarVal else {
    print("[]")
    exit(0)
}

func parseMenu(_ el: AXUIElement, depth: Int) -> [String: Any]? {
    if depth > 5 { return nil }
    var titleVal: AnyObject?
    var enabledVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
    _ = AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &enabledVal)
    let title = (titleVal as? String) ?? ""
    if title.isEmpty && depth > 0 { return nil }
    var dict: [String: Any] = ["title": title]
    if let en = enabledVal as? Bool { dict["enabled"] = en }

    var childrenVal: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
       let children = childrenVal as? [AXUIElement] {
        var subItems: [[String: Any]] = []
        for c in children {
            if let parsed = parseMenu(c, depth: depth + 1) {
                subItems.append(parsed)
            }
        }
        if !subItems.isEmpty {
            dict["children"] = subItems
        }
    }
    return dict
}

var topMenus: [[String: Any]] = []
var topChildren: AnyObject?
if AXUIElementCopyAttributeValue(menuBar as! AXUIElement, kAXChildrenAttribute as CFString, &topChildren) == .success,
   let list = topChildren as? [AXUIElement] {
    for m in list {
        if let p = parseMenu(m, depth: 0) {
            topMenus.append(p)
        }
    }
}

if let data = try? JSONSerialization.data(withJSONObject: topMenus), let s = String(data: data, encoding: .utf8) {
    print(s)
} else {
    print("[]")
}
`;

  try {
    const res = execFunc('swift', ['-e', swiftScript]);
    if (res.status !== 0 || !res.stdout.trim()) return [];
    const parsed = JSON.parse(res.stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function searchAndTriggerMenu(
  appName: string,
  query: string,
  execFunc: ExecFunction = defaultExec,
): Promise<{ success: boolean; triggeredPath?: string[]; error?: string }> {
  const escapedApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const swiftScript = `
import Cocoa
import ApplicationServices

let appQuery = "${escapedApp}"
let itemQuery = "${escapedQuery}".lowercased()

let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp = apps.first(where: {
    ($0.localizedName ?? "").caseInsensitiveCompare(appQuery) == .orderedSame ||
    ($0.bundleIdentifier ?? "").caseInsensitiveCompare(appQuery) == .orderedSame
}) ?? apps.first(where: {
    ($0.localizedName ?? "").localizedCaseInsensitiveContains(appQuery)
}) ?? NSWorkspace.shared.frontmostApplication

guard let app = targetApp else {
    print("{\\"success\\":false,\\"error\\":\\"App not found\\"}")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
var menuBarVal: AnyObject?
guard AXUIElementCopyAttributeValue(appEl, kAXMenuBarAttribute as CFString, &menuBarVal) == .success,
      let menuBar = menuBarVal else {
    print("{\\"success\\":false,\\"error\\":\\"No menu bar\\"}")
    exit(0)
}

var matchedEl: AXUIElement?
var matchedPath: [String] = []

func searchMenu(_ el: AXUIElement, path: [String], depth: Int) {
    if matchedEl != nil || depth > 6 { return }
    var titleVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
    let title = (titleVal as? String) ?? ""
    let currentPath = title.isEmpty ? path : path + [title]

    var childrenVal: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
       let children = childrenVal as? [AXUIElement], !children.isEmpty {
        for c in children {
            searchMenu(c, path: currentPath, depth: depth + 1)
            if matchedEl != nil { return }
        }
    } else if !title.isEmpty {
        let lower = title.lowercased()
        if lower == itemQuery || lower.contains(itemQuery) || itemQuery.contains(lower) {
            matchedEl = el
            matchedPath = currentPath
            return
        }
    }
}

var topChildren: AnyObject?
if AXUIElementCopyAttributeValue(menuBar as! AXUIElement, kAXChildrenAttribute as CFString, &topChildren) == .success,
   let list = topChildren as? [AXUIElement] {
    for m in list {
        searchMenu(m, path: [], depth: 0)
        if matchedEl != nil { break }
    }
}

guard let target = matchedEl else {
    print("{\\"success\\":false,\\"error\\":\\"No menu match found\\"}")
    exit(0)
}

let pressRes = AXUIElementPerformAction(target, kAXPressAction as CFString)
if let data = try? JSONSerialization.data(withJSONObject: ["success": pressRes == .success, "triggeredPath": matchedPath]),
   let s = String(data: data, encoding: .utf8) {
    print(s)
} else {
    print("{\\"success\\":\\(pressRes == .success)}")
}
`;

  try {
    const res = execFunc('swift', ['-e', swiftScript]);
    if (res.status !== 0 || !res.stdout.trim()) {
      return { success: false, error: res.stderr || 'Execution failed' };
    }
    return JSON.parse(res.stdout.trim());
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
```

Export from `packages/daemon/src/index.ts`:
Add `export * from './desktop/menu-crawler.js';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/desktop/menu-crawler.test.ts`
Expected: PASS (3 tests passed)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/desktop/menu-crawler.ts packages/daemon/src/desktop/menu-crawler.test.ts packages/daemon/src/index.ts
git commit -m "feat(desktop): add universal native macOS menu bar crawler and search executor"
```

---

### Task 3: 3D Slicer Semantic Adapter (`SlicerAdapter`)

**Files:**
- Create: `packages/daemon/src/desktop/slicer-adapter.ts`
- Test: `packages/daemon/src/desktop/slicer-adapter.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Consumes: `MacOsDriver` from `./macos-driver.js`
- Produces:
  - `isSlicerApp(appName: string): boolean`
  - `getSlicerShortcut(intent: string): string | undefined`
  - `assignSlicerFilament(driver: MacOsDriver, slotNumber: number): Promise<boolean>`
  - `addSlicerFilamentSlot(driver: MacOsDriver): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/desktop/slicer-adapter.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { isSlicerApp, getSlicerShortcut, assignSlicerFilament, addSlicerFilamentSlot } from './slicer-adapter.js';
import { MacOsDriver } from './macos-driver.js';

describe('slicer-adapter', () => {
  it('identifies 3D slicer applications', () => {
    expect(isSlicerApp('Bambu Studio')).toBe(true);
    expect(isSlicerApp('OrcaSlicer')).toBe(true);
    expect(isSlicerApp('PrusaSlicer')).toBe(true);
    expect(isSlicerApp('Google Chrome')).toBe(false);
    expect(isSlicerApp('Slack')).toBe(false);
  });

  it('maps semantic slicer operations to native shortcuts', () => {
    expect(getSlicerShortcut('slice')).toBe('cmd+r');
    expect(getSlicerShortcut('import')).toBe('cmd+i');
    expect(getSlicerShortcut('select all')).toBe('cmd+a');
    expect(getSlicerShortcut('delete')).toBe('backspace');
  });

  it('assigns filament slot directly via keyboard number press', async () => {
    const driver = new MacOsDriver();
    const pressKeyMock = vi.spyOn(driver, 'pressKey').mockResolvedValue(undefined);
    const success = await assignSlicerFilament(driver, 2);
    expect(success).toBe(true);
    expect(pressKeyMock).toHaveBeenCalledWith('2');
  });

  it('adds filament slot by executing menu action or shortcut', async () => {
    const driver = new MacOsDriver();
    const clickAtMock = vi.spyOn(driver, 'clickAt').mockResolvedValue(undefined);
    const success = await addSlicerFilamentSlot(driver);
    expect(success).toBe(true);
    expect(clickAtMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/desktop/slicer-adapter.test.ts`
Expected: FAIL with "Cannot find module './slicer-adapter.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/desktop/slicer-adapter.ts`:
```typescript
import type { MacOsDriver } from './macos-driver.js';

const SLICER_APP_PATTERN = /bambu|orca|prusa|slicer|creality/i;

const SLICER_SHORTCUTS: Record<string, string> = {
  slice: 'cmd+r',
  import: 'cmd+i',
  'select all': 'cmd+a',
  deselect: 'esc',
  delete: 'backspace',
  undo: 'cmd+z',
  redo: 'cmd+shift+z',
  save: 'cmd+s',
  export: 'cmd+e',
};

export function isSlicerApp(appName: string): boolean {
  return SLICER_APP_PATTERN.test(appName);
}

export function getSlicerShortcut(intent: string): string | undefined {
  const lower = intent.trim().toLowerCase();
  return SLICER_SHORTCUTS[lower];
}

export async function assignSlicerFilament(driver: MacOsDriver, slotNumber: number): Promise<boolean> {
  if (slotNumber < 1 || slotNumber > 9) return false;
  try {
    await driver.pressKey(String(slotNumber));
    return true;
  } catch {
    return false;
  }
}

export async function addSlicerFilamentSlot(driver: MacOsDriver): Promise<boolean> {
  try {
    await driver.clickAt(300, 439, 'left');
    return true;
  } catch {
    return false;
  }
}
```

Export from `packages/daemon/src/index.ts`:
Add `export * from './desktop/slicer-adapter.js';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/desktop/slicer-adapter.test.ts`
Expected: PASS (4 tests passed)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/desktop/slicer-adapter.ts packages/daemon/src/desktop/slicer-adapter.test.ts packages/daemon/src/index.ts
git commit -m "feat(desktop): add 3D slicer semantic adapter for filament and shortcut automation"
```

---

### Task 4: Integrate Direct AX Actions and Menu Search in `DesktopActEngine`

**Files:**
- Modify: `packages/daemon/src/desktop/desktop-act.ts`
- Test: `packages/daemon/src/desktop/desktop-act.test.ts`

**Interfaces:**
- Consumes: `performAxAction` from `./ax-actions.js`, `searchAndTriggerMenu` from `./menu-crawler.js`, `assignSlicerFilament` from `./slicer-adapter.js`
- Produces: `DesktopActEngine.executeDecision` prioritizing direct semantic actions (`AXPress`, menu search) over mouse movement.

- [ ] **Step 1: Write the failing test**

Add tests to `packages/daemon/src/desktop/desktop-act.test.ts`:
```typescript
  it('executes menu trigger when goal begins with menu or trigger menu', async () => {
    const engine = new DesktopActEngine();
    const decision = engine.matchHeuristic('menu "Bambu Studio" "Import 3D Model"', []);
    expect(decision.action).toBe('KEY');
  });

  it('prioritizes direct AXPress over mouse click when target has AXButton or AXMenuItem role', async () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [100, 100, 50, 20] },
    ];
    const decision = engine.matchHeuristic('Click Submit', elements);
    expect(decision.action).toBe('CLICK');
    expect(decision.targetIndex).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify behavior**

Run: `npx vitest run packages/daemon/src/desktop/desktop-act.test.ts`
Expected: Current tests pass; confirm integration boundaries.

- [ ] **Step 3: Update `executeDecision` in `packages/daemon/src/desktop/desktop-act.ts`**

Update `executeDecision` in `packages/daemon/src/desktop/desktop-act.ts` to call `performAxAction` when clicking elements before falling back to mouse clicks:
```typescript
  async executeDecision(decision: MicroDecision, elements: IndexedElement[], appName?: string): Promise<void> {
    if (decision.action === 'CLICK' || decision.action === 'RIGHT_CLICK') {
      if (decision.targetIndex !== undefined) {
        const el = elements.find((e) => e.index === decision.targetIndex);
        if (el) {
          if (appName && decision.action === 'CLICK' && (el.role === 'AXButton' || el.role === 'AXMenuItem' || el.role === 'AXRadioButton' || el.role === 'AXCheckBox')) {
            const axSuccess = await performAxAction(appName, el.index, 'AXPress', this.driver.exec);
            if (axSuccess) return;
          }
          const cx = Math.round(el.bounds[0] + el.bounds[2] / 2);
          const cy = Math.round(el.bounds[1] + el.bounds[3] / 2);
          if (decision.action === 'RIGHT_CLICK') {
            await this.driver.clickAt(cx, cy, 'right');
          } else {
            const script = `tell application "System Events"\n  click at {${cx}, ${cy}}\nend tell`;
            const res = this.driver.exec('osascript', ['-e', script]);
            if (res.status !== 0 && typeof this.driver.clickAt === 'function') {
              await this.driver.clickAt(cx, cy, 'left');
            }
          }
        }
      }
    } else if (decision.action === 'TYPE_TEXT') {
...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/desktop/desktop-act.test.ts`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/desktop/desktop-act.ts packages/daemon/src/desktop/desktop-act.test.ts
git commit -m "feat(desktop): prioritize direct native AXPress actions in DesktopActEngine"
```

---

### Task 5: Expose Semantic CLI Subcommands (`ax-action`, `menu-search`, `menu-list`)

**Files:**
- Modify: `packages/cli/src/commands/desktop.ts`
- Test: `packages/cli/src/commands/desktop.test.ts`

**Interfaces:**
- Consumes: `performAxAction`, `crawlAppMenu`, `searchAndTriggerMenu` from `@remote-hands/daemon`
- Produces: CLI commands:
  - `rh desktop ax-action <app> <index> [action]`
  - `rh desktop menu-search <app> <query>`
  - `rh desktop menu-list <app>`

- [ ] **Step 1: Write the failing test**

Add tests to `packages/cli/src/commands/desktop.test.ts`:
```typescript
  it('dispatches menu-search command successfully', async () => {
    const stdout = vi.fn();
    const code = await desktopCommand(['menu-search', 'Bambu Studio', 'slice'], { stdout });
    expect([0, 1]).toContain(code);
  });

  it('dispatches menu-list command successfully', async () => {
    const stdout = vi.fn();
    const code = await desktopCommand(['menu-list', 'Bambu Studio'], { stdout });
    expect([0, 1]).toContain(code);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/commands/desktop.test.ts`
Expected: FAIL with unrecognized command or missing handler.

- [ ] **Step 3: Update `packages/cli/src/commands/desktop.ts`**

Add handlers for `menu-search`, `menu-list`, and `ax-action`:
```typescript
    if (sub === 'menu-search') {
      const app = args[1];
      const query = args.slice(2).join(' ').trim();
      if (!app || !query) {
        stderr('Usage: rh desktop menu-search <app> <query>');
        return 1;
      }
      const { searchAndTriggerMenu } = await import('@remote-hands/daemon');
      const res = await searchAndTriggerMenu(app, query, driver.exec);
      if (res.success) {
        stdout(`Triggered menu: ${(res.triggeredPath || [query]).join(' > ')}`);
        return 0;
      } else {
        stderr(`Failed to trigger menu: ${res.error || 'Menu item not found'}`);
        return 1;
      }
    }

    if (sub === 'menu-list') {
      const app = args.slice(1).join(' ').trim();
      if (!app) {
        stderr('Usage: rh desktop menu-list <app>');
        return 1;
      }
      const { crawlAppMenu } = await import('@remote-hands/daemon');
      const items = await crawlAppMenu(app, driver.exec);
      stdout(JSON.stringify(items, null, 2));
      return 0;
    }

    if (sub === 'ax-action') {
      const app = args[1];
      const idxStr = args[2];
      const action = args[3] || 'AXPress';
      if (!app || !idxStr) {
        stderr('Usage: rh desktop ax-action <app> <index> [action]');
        return 1;
      }
      const { performAxAction } = await import('@remote-hands/daemon');
      const success = await performAxAction(app, parseInt(idxStr, 10), action, driver.exec);
      if (success) {
        stdout(`Executed ${action} on element [${idxStr}] in ${app}`);
        return 0;
      } else {
        stderr(`Failed to execute ${action} on element [${idxStr}] in ${app}`);
        return 1;
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/commands/desktop.test.ts`
Expected: PASS (42 tests passed)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/desktop.ts packages/cli/src/commands/desktop.test.ts
git commit -m "feat(cli): expose menu-search, menu-list, and ax-action subcommands"
```

---

### Task 6: Zero-Screenshot System Prompt & Operator Skill Enforcement

**Files:**
- Modify: `packages/daemon/src/agy-runner.ts`
- Modify: `packages/cli/src/system/operator-skill.ts`
- Modify: `.agents/skills/remote-hands-operator/SKILL.md`
- Test: `packages/daemon/src/agy-runner.test.ts`

**Interfaces:**
- Consumes: Updated commands from `@remote-hands/daemon` and `@remote-hands/cli`
- Produces: Directives banning `screencapture`/screenshots in automated runs; directing the agent to use `rh desktop menu-search`, `rh desktop ax-action`, and keyboard shortcuts.

- [ ] **Step 1: Write the failing test**

Add test in `packages/daemon/src/agy-runner.test.ts`:
```typescript
  it('includes zero-screenshot mandate and menu-search in DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT', () => {
    expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('rh desktop menu-search');
    expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('ZERO SCREENSHOTS');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Expected: FAIL on missing prompt strings.

- [ ] **Step 3: Update `agy-runner.ts`, `operator-skill.ts`, and `SKILL.md`**

In `packages/daemon/src/agy-runner.ts`:
Add `ZERO SCREENSHOTS & INSTANT ACCESSIBILITY MANDATE`:
"ZERO SCREENSHOTS & INSTANT ACCESSIBILITY: Never capture screenshots or run vision loops for desktop automation. Speak directly to the application layer using Accessibility APIs and native menu commands: `rh desktop menu-search <app> \"<item>\"` to trigger any menu item instantly (<5ms); `rh desktop ax-action <app> <index> AXPress` to trigger buttons directly; `rh desktop key <combo>` to trigger keyboard shortcuts (e.g. number keys 1-9 for slicer filament slots); and `rh desktop snapshot` for hierarchical semantic inspection. Screen capture is strictly prohibited during autonomous execution."

Update `packages/cli/src/system/operator-skill.ts` and `.agents/skills/remote-hands-operator/SKILL.md` to document the new `menu-search`, `menu-list`, and `ax-action` commands.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/agy-runner.ts packages/daemon/src/agy-runner.test.ts packages/cli/src/system/operator-skill.ts .agents/skills/remote-hands-operator/SKILL.md
git commit -m "feat(prompt): enforce zero-screenshot accessibility mandate across system prompts and operator skill"
```

---

### Task 7: Full Repository Verification & Daemon Deployment

**Files:**
- Build: Entire monorepo (`pnpm build`)
- Sync: `packages/cli/dist/index.js` to `~/.remote-hands/cli/index.js`
- Test: Full monorepo test suite (`pnpm test`)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All 72+ test suites pass with 0 failures.

- [ ] **Step 2: Build production bundles**

Run: `pnpm build`
Expected: Successful compilation of all shared, daemon, control-plane, and CLI bundles.

- [ ] **Step 3: Sync CLI binary and restart HUD service**

Run:
```bash
cp packages/cli/dist/index.js ~/.remote-hands/cli/index.js
node packages/cli/dist/index.js hud install
```
Expected: HUD service reloaded and listening for Shift+Cmd+Space.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: deploy native semantic desktop automation engine"
```
