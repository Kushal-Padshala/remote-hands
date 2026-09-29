import { spawnSync } from 'node:child_process';
import type { ExecFunction, MacOsDriver } from './macos-driver.js';

export interface RawAxNode {
  role: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  subrole?: string;
  visible?: boolean;
  hidden?: boolean;
}

export interface IndexedElement {
  index: number;
  role: string;
  label: string;
  bounds: [number, number, number, number];
}

export interface AxWalkerOptions {
  driver?: MacOsDriver;
  exec?: ExecFunction;
  allowOcr?: boolean;
}

export interface WalkOptions {
  allowOcr?: boolean;
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class AxWalker {
  private exec: ExecFunction;
  private allowOcr: boolean = false;

  constructor(options?: AxWalkerOptions | MacOsDriver) {
    if (options && 'openApp' in options) {
      this.exec = options.exec;
    } else if (options && typeof options === 'object') {
      this.exec = options.exec ?? options.driver?.exec ?? ((cmd, args) => {
        const res = spawnSync(cmd, args, { encoding: 'utf-8' });
        return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
      });
      if (typeof options.allowOcr === 'boolean') {
        this.allowOcr = options.allowOcr;
      }
    } else {
      this.exec = (cmd, args) => {
        const res = spawnSync(cmd, args, { encoding: 'utf-8' });
        return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
      };
    }
  }

  pruneAndIndex(nodes: RawAxNode[], options?: { allowNegativeCoordinates?: boolean }): IndexedElement[] {
    const valid: IndexedElement[] = [];
    let counter = 1;
    const allowNegative = options?.allowNegativeCoordinates ?? false;

    for (const node of nodes) {
      if (!node) continue;
      if (node.visible === false || node.hidden === true) continue;
      if (typeof node.width !== 'number' || typeof node.height !== 'number') continue;
      if (node.width < 4 || node.height < 4) continue;
      if (typeof node.x !== 'number' || typeof node.y !== 'number' || Number.isNaN(node.x) || Number.isNaN(node.y)) continue;
      if (!allowNegative && (node.x < 0 || node.y < 0)) continue;
      if (allowNegative && (node.x < -20000 || node.y < -20000 || node.x > 50000 || node.y > 50000)) continue;

      const trimmed = (node.label ?? '').trim();
      if (
        trimmed.includes('Type follow-up instruction') ||
        trimmed.includes('press Esc to stop') ||
        trimmed === '⏹ Stop' ||
        trimmed === '✕' ||
        trimmed.includes('• EXECUTING') ||
        trimmed.includes('• WORKING') ||
        trimmed.includes('✔ COMPLETE') ||
        trimmed.includes('⏹ STOPPED')
      ) {
        continue;
      }
      if (!trimmed || trimmed.startsWith('<NSImage') || trimmed.startsWith('<wxCustomRendererObject') || trimmed.includes('RendererObject')) {
        if (node.role !== 'AXTextField' && node.role !== 'AXTextArea') continue;
        if (trimmed.startsWith('<wxCustomRendererObject') || trimmed.includes('RendererObject')) continue;
      }
      if (node.role === 'AXGroup' && !trimmed) continue;

      valid.push({
        index: counter++,
        role: node.role,
        label: trimmed,
        bounds: [node.x, node.y, node.width, node.height],
      });
    }

    return valid;
  }

  formatTable(elements: IndexedElement[]): string {
    return elements
      .map((el) => `[${el.index}] ${el.role} "${el.label}"`)
      .join('\n');
  }

  async walkActiveApp(
    appNameOrExecOrOpts?: string | ExecFunction | WalkOptions,
    maybeExecOrOpts?: ExecFunction | WalkOptions,
    maybeExec?: ExecFunction,
  ): Promise<IndexedElement[]> {
    let appName: string | undefined;
    let options: WalkOptions = { allowOcr: this.allowOcr };
    let execFunc = this.exec;

    if (typeof appNameOrExecOrOpts === 'string') {
      appName = appNameOrExecOrOpts;
      if (typeof maybeExecOrOpts === 'function') {
        execFunc = maybeExecOrOpts;
      } else if (maybeExecOrOpts && typeof maybeExecOrOpts === 'object') {
        options = { ...options, ...maybeExecOrOpts };
        if (typeof maybeExec === 'function') {
          execFunc = maybeExec;
        }
      }
    } else if (typeof appNameOrExecOrOpts === 'function') {
      execFunc = appNameOrExecOrOpts;
      if (maybeExecOrOpts && typeof maybeExecOrOpts === 'object') {
        options = { ...options, ...maybeExecOrOpts };
      }
    } else if (appNameOrExecOrOpts && typeof appNameOrExecOrOpts === 'object') {
      options = { ...options, ...appNameOrExecOrOpts };
      if (typeof maybeExecOrOpts === 'function') {
        execFunc = maybeExecOrOpts;
      }
    } else {
      if (maybeExecOrOpts && typeof maybeExecOrOpts === 'object') {
        options = { ...options, ...maybeExecOrOpts };
        if (typeof maybeExec === 'function') {
          execFunc = maybeExec;
        }
      } else if (typeof maybeExecOrOpts === 'function') {
        execFunc = maybeExecOrOpts;
      }
    }

    const nativeElements = await this.walkNativeSwift(appName, execFunc, options);
    const hasCustomRenderer = nativeElements.some(
      (e) => e.label.includes('<wxCustomRendererObject') || e.label.includes('RendererObject'),
    );
    const meaningfulCount = nativeElements.filter((e) => e.label && !e.label.startsWith('<')).length;

    if (nativeElements.length > 0 && !hasCustomRenderer && meaningfulCount >= 5) {
      return nativeElements;
    }

    if (options.allowOcr === true) {
      const ocrElements = await this.walkVisionOcr(execFunc);
      if (ocrElements.length > 0) {
        if (nativeElements.length === 0 || hasCustomRenderer || meaningfulCount < 5) {
          return ocrElements;
        }
      }
    }

    if (nativeElements.length > 0) return nativeElements;

    const escapedApp = appName ? escapeAppleScript(appName) : '';
    const script = `
      function run() {
        try {
          const se = Application("System Events");
          const procs = ${appName ? `[se.applicationProcesses.byName("${escapedApp}")].filter(Boolean)` : `se.applicationProcesses.where({ frontmost: true })`};
          if (!procs || procs.length === 0) return JSON.stringify([]);
          const front = procs[0];
          const wins = front.windows();
          if (!wins || wins.length === 0) return JSON.stringify([]);
          const win = wins[0];
          const items = [];
          function walk(el, depth) {
            if (depth > 3 || items.length >= 60) return;
            try {
              const children = el.uiElements();
              for (let i = 0; i < children.length; i++) {
                if (items.length >= 60) break;
                const c = children[i];
                try {
                  const role = c.role();
                  const name = c.name() || c.description() || "";
                  const pos = c.position();
                  const size = c.size();
                  if (size[0] > 4 && size[1] > 4) {
                    items.push({ role, label: name, x: pos[0], y: pos[1], width: size[0], height: size[1] });
                  }
                  if (role === "AXGroup" || role === "AXScrollArea" || role === "AXSplitGroup" || role === "AXView" || role === "AXToolbar" || role === "AXWindow") {
                    walk(c, depth + 1);
                  }
                } catch (_) {}
              }
            } catch (_) {}
          }
          walk(win, 0);
          return JSON.stringify(items);
        } catch (_) {
          return JSON.stringify([]);
        }
      }
      run();
    `;

    try {
      const res = execFunc('osascript', ['-l', 'JavaScript', '-e', script]);
      const raw = JSON.parse(res.stdout.trim() || '[]');
      if (Array.isArray(raw)) {
        const indexed = this.pruneAndIndex(raw, { allowNegativeCoordinates: true });
        if (indexed.length > 0) return indexed;
      }
    } catch {}

    if (options.allowOcr !== false) {
      return this.walkVisionOcr(execFunc);
    }
    return [];
  }

  async walkNativeSwift(
    appName?: string,
    execFunc: ExecFunction = this.exec,
    options: WalkOptions = { allowOcr: this.allowOcr },
  ): Promise<IndexedElement[]> {
    const escapedApp = (appName ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const swiftScript = `
import Cocoa
import ApplicationServices
import Foundation

struct Node: Codable {
    let role: String
    let label: String
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

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

var nodes: [Node] = []
func walk(el: AXUIElement, depth: Int) {
    if depth > 24 || nodes.count >= 300 { return }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            if nodes.count >= 300 { break }
            let role = getAttr(c, kAXRoleAttribute)
            let title = getAttr(c, kAXTitleAttribute)
            let desc = getAttr(c, kAXDescriptionAttribute)
            let val = getAttr(c, kAXValueAttribute)
            let label = !title.isEmpty ? title : (!desc.isEmpty ? desc : val)
            if let (x, y, w, h) = getBounds(c), w > 4, h > 4 {
                if !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || role.contains("Button") || role.contains("Text") || role.contains("Radio") || role.contains("Check") || role.contains("Heading") || role.contains("Area") {
                    nodes.append(Node(role: role, label: label, x: x, y: y, width: w, height: h))
                }
            }
            walk(el: c, depth: depth + 1)
        }
    }
}

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
    if let winList = wins as? [AXUIElement], !winList.isEmpty {
        rootWindow = winList.first
    }
}

if let rw = rootWindow {
    walk(el: rw, depth: 0)
} else {
    walk(el: appEl, depth: 0)
}
if let data = try? JSONEncoder().encode(nodes), let str = String(data: data, encoding: .utf8) {
    print(str)
} else {
    print("[]")
}
`;
    try {
      const res = execFunc('swift', ['-e', swiftScript]);
      const raw = JSON.parse(res.stdout.trim() || '[]');
      if (Array.isArray(raw) && raw.length > 0) {
        const hasCustom = raw.some((n: any) => typeof n.label === 'string' && (n.label.includes('wxCustomRendererObject') || n.label.includes('RendererObject')));
        if (hasCustom && options.allowOcr === true) {
          const ocr = await this.walkVisionOcr(execFunc);
          if (ocr.length > 0) return ocr;
        }
        return this.pruneAndIndex(raw, { allowNegativeCoordinates: true });
      }
    } catch {}
    return [];
  }

  async walkVisionOcr(execFunc: ExecFunction): Promise<IndexedElement[]> {
    if (this.allowOcr !== true) return [];
    const tmpShot = '/tmp/rh_ax_ocr.png';
    const captureRes = execFunc('screencapture', ['-x', '-m', tmpShot]);
    if (captureRes.status !== 0) return [];

    const swiftScript = `
import Vision
import Cocoa

guard let img = NSImage(contentsOfFile: "${tmpShot}"),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("[]")
  exit(0)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([req])
let w = CGFloat(cg.width)
let h = CGFloat(cg.height)
let scaleX = img.size.width > 0 ? (img.size.width / w) : 1.0
let scaleY = img.size.height > 0 ? (img.size.height / h) : 1.0
var out: [[String: Any]] = []
for obs in (req.results ?? []) {
  guard let cand = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  let x = Int(b.origin.x * w * scaleX)
  let y = Int((1.0 - b.origin.y - b.size.height) * h * scaleY)
  let bw = Int(b.size.width * w * scaleX)
  let bh = Int(b.size.height * h * scaleY)
  out.append([
    "role": "AXStaticText",
    "label": cand.string,
    "x": x,
    "y": y,
    "width": bw,
    "height": bh
  ])
}
if let data = try? JSONSerialization.data(withJSONObject: out),
   let str = String(data: data, encoding: .utf8) {
  print(str)
} else {
  print("[]")
}
`;
    try {
      const res = execFunc('swift', ['-e', swiftScript]);
      const raw = JSON.parse(res.stdout.trim() || '[]');
      if (Array.isArray(raw) && raw.length > 0) {
        return this.pruneAndIndex(raw);
      }
    } catch {}
    return [];
  }
}
