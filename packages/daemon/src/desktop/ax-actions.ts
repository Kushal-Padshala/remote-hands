import { spawnSync } from 'node:child_process';
import type { ExecFunction } from './macos-driver.js';

export interface AxElementTarget {
  index?: number;
  bounds?: [number, number, number, number];
  role?: string;
  label?: string;
  windowTitle?: string | undefined;
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
  const escapedWinTitle = (normTarget.windowTitle ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp: NSRunningApplication?
if !query.isEmpty {
    let matched = apps.filter {
        ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.localizedName ?? "").localizedCaseInsensitiveContains(query) ||
        ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains(query)
    }
    targetApp = matched.first(where: { $0.isActive }) ?? matched.first
} else {
    targetApp = NSWorkspace.shared.frontmostApplication
}

guard let app = targetApp else {
    print("{\\"success\\":false,\\"error\\":\\"App not found\\"}")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
_ = app.activate(options: [])

let targetWinTitle = "${escapedWinTitle}"
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
let winList = (wins as? [AXUIElement]) ?? []

var rootWindow: AXUIElement?
if !targetWinTitle.isEmpty {
    for w in winList {
        let title = getAttr(w, kAXTitleAttribute)
        if title.localizedCaseInsensitiveContains(targetWinTitle) || targetWinTitle.localizedCaseInsensitiveContains(title) {
            rootWindow = w
            break
        }
    }
}
if rootWindow == nil {
    var focVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focVal) == .success, let w = focVal {
        rootWindow = (w as! AXUIElement)
    }
}
if rootWindow == nil {
    var mainVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXMainWindowAttribute as CFString, &mainVal) == .success, let w = mainVal {
        rootWindow = (w as! AXUIElement)
    }
}
if rootWindow == nil {
    for w in winList {
        let sub = getAttr(w, kAXSubroleAttribute)
        let title = getAttr(w, kAXTitleAttribute)
        if sub == "AXStandardWindow" && !title.isEmpty {
            rootWindow = w
            break
        }
    }
}
if rootWindow == nil && !winList.isEmpty {
    rootWindow = winList.first
}

if let rw = rootWindow {
    AXUIElementSetAttributeValue(rw, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementPerformAction(rw, "AXRaise" as CFString)
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
    if depth > 64 || targetEl != nil { return }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            if targetEl != nil { return }
            let role = getAttr(c, kAXRoleAttribute)
            let title = getAttr(c, kAXTitleAttribute)
            let desc = getAttr(c, kAXDescriptionAttribute)
            let val = getAttr(c, kAXValueAttribute)
            let label = !title.isEmpty ? title : (!desc.isEmpty ? desc : val)
            let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)

            let bounds = getBounds(c)
            var isAllowed = false
            if let (x, y, w, h) = bounds, w >= 4, h >= 4, x >= -20000, y >= -20000 {
                let isHud = trimmed.contains("Type follow-up instruction") ||
                            trimmed.contains("press Esc to stop") ||
                            trimmed == "⏹ Stop" || trimmed == "✕" ||
                            trimmed.contains("• EXECUTING") || trimmed.contains("• WORKING") ||
                            trimmed.contains("✔ COMPLETE") || trimmed.contains("⏹ STOPPED")
                let isRender = trimmed.hasPrefix("<wxCustomRendererObject") || trimmed.contains("RendererObject")
                let isInteractive = role.contains("Button") || role.contains("Text") || role.contains("Radio") || role.contains("Check") || role.contains("Link") || role.contains("PopUp") || role.contains("Menu") || role.contains("Combo") || role.contains("Tab")
                isAllowed = !isHud && !isRender && (!trimmed.isEmpty || isInteractive)
            }
            if isAllowed {
                currentCounter += 1
                if targetIndex > 0 && currentCounter == targetIndex {
                    targetEl = c
                    return
                }
            }

            if hasBounds, let (x, y, w, h) = bounds {
                if abs(x - targetX) <= 6 && abs(y - targetY) <= 6 && abs(w - targetW) <= 6 && abs(h - targetH) <= 6 {
                    if targetRole.isEmpty || role == targetRole || role.contains(targetRole) || targetRole.contains(role) {
                        targetEl = c
                        return
                    }
                }
            }

            if !targetLabel.isEmpty && !trimmed.isEmpty {
                let roleMatches = targetRole.isEmpty || role == targetRole || role.contains(targetRole) || targetRole.contains(role)
                if trimmed.caseInsensitiveCompare(targetLabel) == .orderedSame {
                    if roleMatches {
                        if targetIndex <= 0 || (isAllowed && currentCounter == targetIndex) {
                            targetEl = c
                            return
                        } else if fallbackEl == nil {
                            fallbackEl = c
                        }
                    }
                } else if roleMatches && (trimmed.localizedCaseInsensitiveContains(targetLabel) || targetLabel.localizedCaseInsensitiveContains(trimmed)) {
                    if fallbackEl == nil {
                        fallbackEl = c
                    }
                }
            }
            checkElement(c, depth: depth + 1)
        }
    }
}

checkElement(rw, depth: 0)

if targetEl == nil && fallbackEl == nil && winList.count > 1 {
    for w in winList {
        if let rw = rootWindow, CFEqual(w, rw) { continue }
        checkElement(w, depth: 0)
        if targetEl != nil || fallbackEl != nil { break }
    }
}

guard let found = targetEl ?? fallbackEl else {
    print("{\\"success\\":false,\\"error\\":\\"Element not found\\"}")
    exit(0)
}

let action = "${escapedAction}" as CFString
var res: AXError = AXUIElementPerformAction(found, action)
if res != .success && action as String == "AXPress" {
    var cur = found
    for _ in 0..<4 {
        var parentVal: AnyObject?
        if AXUIElementCopyAttributeValue(cur, kAXParentAttribute as CFString, &parentVal) == .success, let p = parentVal {
            let pEl = p as! AXUIElement
            var actListVal: CFArray?
            if AXUIElementCopyActionNames(pEl, &actListVal) == .success, let acts = actListVal as? [String], acts.contains("AXPress") {
                if AXUIElementPerformAction(pEl, "AXPress" as CFString) == .success {
                    res = .success
                    break
                }
            }
            cur = pEl
        } else {
            break
        }
    }
}
if res != .success && action as String == "AXPress" {
    var chListVal: AnyObject?
    if AXUIElementCopyAttributeValue(found, kAXChildrenAttribute as CFString, &chListVal) == .success, let chList = chListVal as? [AXUIElement] {
        for c in chList {
            var actListVal: CFArray?
            if AXUIElementCopyActionNames(c, &actListVal) == .success, let acts = actListVal as? [String], acts.contains("AXPress") {
                if AXUIElementPerformAction(c, "AXPress" as CFString) == .success {
                    res = .success
                    break
                }
            }
        }
    }
}
let foundRole = getAttr(found, kAXRoleAttribute)
if res != .success && (foundRole == "AXRadioButton" || foundRole == "AXCheckBox") {
    if AXUIElementSetAttributeValue(found, kAXValueAttribute as CFString, 1 as CFTypeRef) == .success {
        res = .success
    }
}
if res != .success && action as String == "AXPress", let (x, y, w, h) = getBounds(found), w > 0, h > 0 {
    let pt = CGPoint(x: Double(x + w / 2), y: Double(y + h / 2))
    if let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left),
       let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) {
        down.post(tap: .cghidEventTap)
        usleep(30000)
        up.post(tap: .cghidEventTap)
        res = .success
    }
}
if res == .success {
    print("{\\"success\\":true}")
} else {
    print("{\\"success\\":false}")
}
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
    let matched = apps.filter {
        ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.localizedName ?? "").localizedCaseInsensitiveContains(query) ||
        ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains(query)
    }
    targetApp = matched.first(where: { $0.isActive }) ?? matched.first
} else {
    targetApp = NSWorkspace.shared.frontmostApplication
}

guard let app = targetApp else {
    print("[]")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
var rootWindow: AXUIElement?
var focVal: AnyObject?
if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focVal) == .success, let w = focVal {
    rootWindow = (w as! AXUIElement)
}
if rootWindow == nil {
    var mainVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXMainWindowAttribute as CFString, &mainVal) == .success, let w = mainVal {
        rootWindow = (w as! AXUIElement)
    }
}
if rootWindow == nil {
    var wins: AnyObject?
    _ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
    if let winList = wins as? [AXUIElement], !winList.isEmpty { rootWindow = winList.first }
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
    if depth > 24 || targetEl != nil { return }
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
            if let (x, y, w, h) = getBounds(c), w >= 4, h >= 4, x >= -20000, y >= -20000 {
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
  const escapedWinTitle = (normTarget.windowTitle ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const swiftScript = `
import Cocoa
import ApplicationServices

let query = "${escapedApp}"
let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let targetApp: NSRunningApplication?
if !query.isEmpty {
    let matched = apps.filter {
        ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.localizedName ?? "").localizedCaseInsensitiveContains(query) ||
        ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains(query)
    }
    targetApp = matched.first(where: { $0.isActive }) ?? matched.first
} else {
    targetApp = NSWorkspace.shared.frontmostApplication
}

guard let app = targetApp else {
    print("{\\"success\\":false}")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
_ = app.activate(options: [])

let targetWinTitle = "${escapedWinTitle}"
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
let winList = (wins as? [AXUIElement]) ?? []

var rootWindow: AXUIElement?
if !targetWinTitle.isEmpty {
    for w in winList {
        let title = getAttr(w, kAXTitleAttribute)
        if title.localizedCaseInsensitiveContains(targetWinTitle) || targetWinTitle.localizedCaseInsensitiveContains(title) {
            rootWindow = w
            break
        }
    }
}
if rootWindow == nil {
    var focVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focVal) == .success, let w = focVal {
        rootWindow = (w as! AXUIElement)
    }
}
if rootWindow == nil {
    var mainVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXMainWindowAttribute as CFString, &mainVal) == .success, let w = mainVal {
        rootWindow = (w as! AXUIElement)
    }
}
if rootWindow == nil {
    for w in winList {
        let sub = getAttr(w, kAXSubroleAttribute)
        let title = getAttr(w, kAXTitleAttribute)
        if sub == "AXStandardWindow" && !title.isEmpty {
            rootWindow = w
            break
        }
    }
}
if rootWindow == nil && !winList.isEmpty {
    rootWindow = winList.first
}

if let rw = rootWindow {
    AXUIElementSetAttributeValue(rw, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementPerformAction(rw, "AXRaise" as CFString)
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
    if depth > 64 || targetEl != nil { return }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            if targetEl != nil { return }
            let role = getAttr(c, kAXRoleAttribute)
            let title = getAttr(c, kAXTitleAttribute)
            let desc = getAttr(c, kAXDescriptionAttribute)
            let val = getAttr(c, kAXValueAttribute)
            let label = !title.isEmpty ? title : (!desc.isEmpty ? desc : val)
            let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)

            if !targetLabel.isEmpty && !trimmed.isEmpty {
                let roleMatches = targetRole.isEmpty || role == targetRole || role.contains(targetRole) || targetRole.contains(role)
                if trimmed.caseInsensitiveCompare(targetLabel) == .orderedSame {
                    if roleMatches {
                        targetEl = c
                        return
                    }
                } else if roleMatches && (trimmed.localizedCaseInsensitiveContains(targetLabel) || targetLabel.localizedCaseInsensitiveContains(trimmed)) {
                    fallbackEl = c
                }
            }

            if hasBounds {
                if let (x, y, w, h) = getBounds(c) {
                    if abs(x - targetX) <= 6 && abs(y - targetY) <= 6 && abs(w - targetW) <= 6 && abs(h - targetH) <= 6 {
                        if targetRole.isEmpty || role == targetRole || role.contains(targetRole) || targetRole.contains(role) {
                            targetEl = c
                            return
                        }
                    }
                }
            }
            if let (x, y, w, h) = getBounds(c), w >= 4, h >= 4, x >= -20000, y >= -20000 {
                let isHud = trimmed.contains("Type follow-up instruction") ||
                            trimmed.contains("press Esc to stop") ||
                            trimmed == "⏹ Stop" || trimmed == "✕" ||
                            trimmed.contains("• EXECUTING") || trimmed.contains("• WORKING") ||
                            trimmed.contains("✔ COMPLETE") || trimmed.contains("⏹ STOPPED")
                let isGroupEmpty = (role == "AXGroup" && trimmed.isEmpty)
                let isRender = trimmed.hasPrefix("<wxCustomRendererObject") || trimmed.contains("RendererObject")
                let isAllowed = !isHud && !isGroupEmpty && !isRender && (!trimmed.isEmpty || role.contains("Button") || role.contains("Text") || role.contains("Radio") || role.contains("Check") || role.contains("Heading") || role.contains("Area"))
                if isAllowed {
                    currentCounter += 1
                    if currentCounter == targetIndex {
                        if targetEl == nil {
                            targetEl = c
                            return
                        }
                    }
                }
            }
            checkElement(c, depth: depth + 1)
        }
    }
}

checkElement(rw, depth: 0)

if targetEl == nil && fallbackEl == nil && winList.count > 1 {
    for w in winList {
        if let rw = rootWindow, CFEqual(w, rw) { continue }
        checkElement(w, depth: 0)
        if targetEl != nil || fallbackEl != nil { break }
    }
}

guard let found = targetEl ?? fallbackEl else {
    print("{\\"success\\":false}")
    exit(0)
}

let val = "${escapedValue}" as CFTypeRef
var res = AXUIElementSetAttributeValue(found, kAXValueAttribute as CFString, val)
if res != .success {
    var childrenVal: AnyObject?
    if AXUIElementCopyAttributeValue(found, kAXChildrenAttribute as CFString, &childrenVal) == .success, let children = childrenVal as? [AXUIElement] {
        for c in children {
            if AXUIElementSetAttributeValue(c, kAXValueAttribute as CFString, val) == .success {
                res = .success
                break
            }
        }
    }
}
if res != .success {
    _ = AXUIElementSetAttributeValue(found, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementPerformAction(found, "AXPress" as CFString)
    res = AXUIElementSetAttributeValue(found, kAXValueAttribute as CFString, val)
}
if res == .success {
    print("{\\"success\\":true}")
} else {
    print("{\\"success\\":false}")
}
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
