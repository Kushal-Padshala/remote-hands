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

    var cmdCharVal: AnyObject?
    if AXUIElementCopyAttributeValue(el, "AXMenuItemCmdChar" as CFString, &cmdCharVal) == .success,
       let ch = cmdCharVal as? String, !ch.isEmpty {
        dict["shortcut"] = ch
    }

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
