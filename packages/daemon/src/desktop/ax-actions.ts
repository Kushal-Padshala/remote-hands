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
