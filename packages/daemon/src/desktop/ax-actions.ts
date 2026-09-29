import { spawnSync } from 'node:child_process';
import type { ExecFunction } from './macos-driver.js';

export interface AxElementTarget {
  index?: number;
  bounds?: [number, number, number, number];
  role?: string;
  label?: string;
}

const defaultExec: ExecFunction = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: 'utf-8' });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
};

function normalizeTarget(target: number | AxElementTarget): AxElementTarget {
  return typeof target === 'number' ? { index: target } : target;
}

export async function performAxAction(
  appName: string,
  target: number | AxElementTarget,
  actionName: string = 'AXPress',
  execFunc: ExecFunction = defaultExec,
): Promise<boolean> {
  const normTarget = normalizeTarget(target);
  const escapedApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedAction = actionName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const targetIndex = normTarget.index ?? -1;
  const hasBounds = Array.isArray(normTarget.bounds) && normTarget.bounds.length === 4;
  const targetX = hasBounds ? normTarget.bounds![0] : 0;
  const targetY = hasBounds ? normTarget.bounds![1] : 0;
  const targetW = hasBounds ? normTarget.bounds![2] : 0;
  const targetH = hasBounds ? normTarget.bounds![3] : 0;
  const escapedRole = (normTarget.role ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedLabel = (normTarget.label ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp: NSRunningApplication?
if !query.isEmpty {
    targetApp = apps.first(where: {
        ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame
    }) ?? apps.first(where: {
        ($0.localizedName ?? "").localizedCaseInsensitiveContains(query) ||
        ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains(query)
    })
} else {
    targetApp = NSWorkspace.shared.frontmostApplication
}

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
if rootWindow == nil {
    var focVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focVal) == .success, let w = focVal {
        rootWindow = (w as! AXUIElement)
    }
}

guard let rw = rootWindow ?? appEl as AXUIElement? else {
    print("{\\"success\\":false,\\"error\\":\\"No window\\"}")
    exit(0)
}

func getAttr(_ el: AXUIElement, _ attr: String) -> String {
    var val: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success, let s = val as? String {
        return s
    }
    return ""
}

func getBounds(_ el: AXUIElement) -> (Int, Int, Int, Int)? {
    var posVal: AnyObject?
    var sizeVal: AnyObject?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posVal) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeVal) == .success,
          let pv = posVal, let sv = sizeVal,
          CFGetTypeID(pv) == AXValueGetTypeID(),
          CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &pt)
    AXValueGetValue(sv as! AXValue, .cgSize, &sz)
    return (Int(pt.x), Int(pt.y), Int(sz.width), Int(sz.height))
}

let targetIndex = ${targetIndex}
let hasBounds = ${hasBounds}
let targetX = ${targetX}
let targetY = ${targetY}
let targetW = ${targetW}
let targetH = ${targetH}
let targetRole = "${escapedRole}"
let targetLabel = "${escapedLabel}"

var currentCounter = 0
var targetEl: AXUIElement?
var fallbackEl: AXUIElement?

func checkElement(_ el: AXUIElement, depth: Int) {
    if depth > 10 || targetEl != nil { return }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            if targetEl != nil { return }
            if hasBounds {
                if let (x, y, w, h) = getBounds(c) {
                    if abs(x - targetX) <= 6 && abs(y - targetY) <= 6 && abs(w - targetW) <= 6 && abs(h - targetH) <= 6 {
                        let role = getAttr(c, kAXRoleAttribute)
                        if targetRole.isEmpty || role == targetRole || role.contains(targetRole) || targetRole.contains(role) {
                            targetEl = c
                            return
                        }
                    }
                }
            }
            if let (x, y, w, h) = getBounds(c), w >= 4, h >= 4, x >= 0, y >= 0 {
                let role = getAttr(c, kAXRoleAttribute)
                let title = getAttr(c, kAXTitleAttribute)
                let desc = getAttr(c, kAXDescriptionAttribute)
                let val = getAttr(c, kAXValueAttribute)
                let label = !title.isEmpty ? title : (!desc.isEmpty ? desc : val)
                let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
                let isHud = trimmed.contains("Type follow-up instruction") ||
                            trimmed.contains("press Esc to stop") ||
                            trimmed == "⏹ Stop" || trimmed == "✕" ||
                            trimmed.contains("• EXECUTING") || trimmed.contains("• WORKING") ||
                            trimmed.contains("✔ COMPLETE") || trimmed.contains("⏹ STOPPED")
                let isGroupEmpty = (role == "AXGroup" && trimmed.isEmpty)
                let isRender = trimmed.hasPrefix("<wxCustomRendererObject") || trimmed.contains("RendererObject")
                let isAllowed = !isHud && !isGroupEmpty && !isRender && (!trimmed.isEmpty || role.contains("Button") || role.contains("Text"))
                if isAllowed {
                    currentCounter += 1
                    if currentCounter == targetIndex {
                        if !hasBounds {
                            targetEl = c
                            return
                        } else {
                            fallbackEl = c
                        }
                    }
                }
            }
            checkElement(c, depth: depth + 1)
        }
    }
}

checkElement(rw, depth: 0)

guard let found = targetEl ?? fallbackEl else {
    print("{\\"success\\":false,\\"error\\":\\"Element not found\\"}")
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
  target: number | AxElementTarget,
  execFunc: ExecFunction = defaultExec,
): Promise<string[]> {
  const normTarget = normalizeTarget(target);
  const escapedApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const targetIndex = normTarget.index ?? -1;
  const hasBounds = Array.isArray(normTarget.bounds) && normTarget.bounds.length === 4;
  const targetX = hasBounds ? normTarget.bounds![0] : 0;
  const targetY = hasBounds ? normTarget.bounds![1] : 0;
  const targetW = hasBounds ? normTarget.bounds![2] : 0;
  const targetH = hasBounds ? normTarget.bounds![3] : 0;
  const escapedRole = (normTarget.role ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedLabel = (normTarget.label ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp: NSRunningApplication?
if !query.isEmpty {
    targetApp = apps.first(where: {
        ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame
    }) ?? apps.first(where: {
        ($0.localizedName ?? "").localizedCaseInsensitiveContains(query) ||
        ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains(query)
    })
} else {
    targetApp = NSWorkspace.shared.frontmostApplication
}

guard let app = targetApp else {
    print("[]")
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
if rootWindow == nil {
    var focVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focVal) == .success, let w = focVal {
        rootWindow = (w as! AXUIElement)
    }
}

guard let rw = rootWindow ?? appEl as AXUIElement? else {
    print("[]")
    exit(0)
}

func getAttr(_ el: AXUIElement, _ attr: String) -> String {
    var val: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success, let s = val as? String {
        return s
    }
    return ""
}

func getBounds(_ el: AXUIElement) -> (Int, Int, Int, Int)? {
    var posVal: AnyObject?
    var sizeVal: AnyObject?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posVal) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeVal) == .success,
          let pv = posVal, let sv = sizeVal,
          CFGetTypeID(pv) == AXValueGetTypeID(),
          CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &pt)
    AXValueGetValue(sv as! AXValue, .cgSize, &sz)
    return (Int(pt.x), Int(pt.y), Int(sz.width), Int(sz.height))
}

let targetIndex = ${targetIndex}
let hasBounds = ${hasBounds}
let targetX = ${targetX}
let targetY = ${targetY}
let targetW = ${targetW}
let targetH = ${targetH}
let targetRole = "${escapedRole}"
let targetLabel = "${escapedLabel}"

var currentCounter = 0
var targetEl: AXUIElement?
var fallbackEl: AXUIElement?

func checkElement(_ el: AXUIElement, depth: Int) {
    if depth > 10 || targetEl != nil { return }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            if targetEl != nil { return }
            if hasBounds {
                if let (x, y, w, h) = getBounds(c) {
                    if abs(x - targetX) <= 6 && abs(y - targetY) <= 6 && abs(w - targetW) <= 6 && abs(h - targetH) <= 6 {
                        let role = getAttr(c, kAXRoleAttribute)
                        if targetRole.isEmpty || role == targetRole || role.contains(targetRole) || targetRole.contains(role) {
                            targetEl = c
                            return
                        }
                    }
                }
            }
            if let (x, y, w, h) = getBounds(c), w >= 4, h >= 4, x >= 0, y >= 0 {
                let role = getAttr(c, kAXRoleAttribute)
                let title = getAttr(c, kAXTitleAttribute)
                let desc = getAttr(c, kAXDescriptionAttribute)
                let val = getAttr(c, kAXValueAttribute)
                let label = !title.isEmpty ? title : (!desc.isEmpty ? desc : val)
                let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
                let isHud = trimmed.contains("Type follow-up instruction") ||
                            trimmed.contains("press Esc to stop") ||
                            trimmed == "⏹ Stop" || trimmed == "✕" ||
                            trimmed.contains("• EXECUTING") || trimmed.contains("• WORKING") ||
                            trimmed.contains("✔ COMPLETE") || trimmed.contains("⏹ STOPPED")
                let isGroupEmpty = (role == "AXGroup" && trimmed.isEmpty)
                let isRender = trimmed.hasPrefix("<wxCustomRendererObject") || trimmed.contains("RendererObject")
                let isAllowed = !isHud && !isGroupEmpty && !isRender && (!trimmed.isEmpty || role.contains("Button") || role.contains("Text"))
                if isAllowed {
                    currentCounter += 1
                    if currentCounter == targetIndex {
                        if !hasBounds {
                            targetEl = c
                            return
                        } else {
                            fallbackEl = c
                        }
                    }
                }
            }
            checkElement(c, depth: depth + 1)
        }
    }
}

checkElement(rw, depth: 0)

guard let found = targetEl ?? fallbackEl else {
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
  target: number | AxElementTarget,
  value: string,
  execFunc: ExecFunction = defaultExec,
): Promise<boolean> {
  const normTarget = normalizeTarget(target);
  const escapedApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const targetIndex = normTarget.index ?? -1;
  const hasBounds = Array.isArray(normTarget.bounds) && normTarget.bounds.length === 4;
  const targetX = hasBounds ? normTarget.bounds![0] : 0;
  const targetY = hasBounds ? normTarget.bounds![1] : 0;
  const targetW = hasBounds ? normTarget.bounds![2] : 0;
  const targetH = hasBounds ? normTarget.bounds![3] : 0;
  const escapedRole = (normTarget.role ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedLabel = (normTarget.label ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp: NSRunningApplication?
if !query.isEmpty {
    targetApp = apps.first(where: {
        ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame
    }) ?? apps.first(where: {
        ($0.localizedName ?? "").localizedCaseInsensitiveContains(query) ||
        ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains(query)
    })
} else {
    targetApp = NSWorkspace.shared.frontmostApplication
}

guard let app = targetApp else {
    print("{\\"success\\":false}")
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
if rootWindow == nil {
    var focVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focVal) == .success, let w = focVal {
        rootWindow = (w as! AXUIElement)
    }
}

guard let rw = rootWindow ?? appEl as AXUIElement? else {
    print("{\\"success\\":false}")
    exit(0)
}

func getAttr(_ el: AXUIElement, _ attr: String) -> String {
    var val: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success, let s = val as? String {
        return s
    }
    return ""
}

func getBounds(_ el: AXUIElement) -> (Int, Int, Int, Int)? {
    var posVal: AnyObject?
    var sizeVal: AnyObject?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posVal) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeVal) == .success,
          let pv = posVal, let sv = sizeVal,
          CFGetTypeID(pv) == AXValueGetTypeID(),
          CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &pt)
    AXValueGetValue(sv as! AXValue, .cgSize, &sz)
    return (Int(pt.x), Int(pt.y), Int(sz.width), Int(sz.height))
}

let targetIndex = ${targetIndex}
let hasBounds = ${hasBounds}
let targetX = ${targetX}
let targetY = ${targetY}
let targetW = ${targetW}
let targetH = ${targetH}
let targetRole = "${escapedRole}"
let targetLabel = "${escapedLabel}"

var currentCounter = 0
var targetEl: AXUIElement?
var fallbackEl: AXUIElement?

func checkElement(_ el: AXUIElement, depth: Int) {
    if depth > 10 || targetEl != nil { return }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            if targetEl != nil { return }
            if hasBounds {
                if let (x, y, w, h) = getBounds(c) {
                    if abs(x - targetX) <= 6 && abs(y - targetY) <= 6 && abs(w - targetW) <= 6 && abs(h - targetH) <= 6 {
                        let role = getAttr(c, kAXRoleAttribute)
                        if targetRole.isEmpty || role == targetRole || role.contains(targetRole) || targetRole.contains(role) {
                            targetEl = c
                            return
                        }
                    }
                }
            }
            if let (x, y, w, h) = getBounds(c), w >= 4, h >= 4, x >= 0, y >= 0 {
                let role = getAttr(c, kAXRoleAttribute)
                let title = getAttr(c, kAXTitleAttribute)
                let desc = getAttr(c, kAXDescriptionAttribute)
                let val = getAttr(c, kAXValueAttribute)
                let label = !title.isEmpty ? title : (!desc.isEmpty ? desc : val)
                let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
                let isHud = trimmed.contains("Type follow-up instruction") ||
                            trimmed.contains("press Esc to stop") ||
                            trimmed == "⏹ Stop" || trimmed == "✕" ||
                            trimmed.contains("• EXECUTING") || trimmed.contains("• WORKING") ||
                            trimmed.contains("✔ COMPLETE") || trimmed.contains("⏹ STOPPED")
                let isGroupEmpty = (role == "AXGroup" && trimmed.isEmpty)
                let isRender = trimmed.hasPrefix("<wxCustomRendererObject") || trimmed.contains("RendererObject")
                let isAllowed = !isHud && !isGroupEmpty && !isRender && (!trimmed.isEmpty || role.contains("Button") || role.contains("Text"))
                if isAllowed {
                    currentCounter += 1
                    if currentCounter == targetIndex {
                        if !hasBounds {
                            targetEl = c
                            return
                        } else {
                            fallbackEl = c
                        }
                    }
                }
            }
            checkElement(c, depth: depth + 1)
        }
    }
}

checkElement(rw, depth: 0)

guard let found = targetEl ?? fallbackEl else {
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
