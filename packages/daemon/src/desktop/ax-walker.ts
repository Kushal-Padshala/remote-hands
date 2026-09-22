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
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class AxWalker {
  private exec: ExecFunction;

  constructor(options?: AxWalkerOptions | MacOsDriver) {
    if (options && 'openApp' in options) {
      this.exec = options.exec;
    } else if (options && typeof options === 'object') {
      this.exec = options.exec ?? options.driver?.exec ?? ((cmd, args) => {
        const res = spawnSync(cmd, args, { encoding: 'utf-8' });
        return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
      });
    } else {
      this.exec = (cmd, args) => {
        const res = spawnSync(cmd, args, { encoding: 'utf-8' });
        return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
      };
    }
  }

  pruneAndIndex(nodes: RawAxNode[]): IndexedElement[] {
    const valid: IndexedElement[] = [];
    let counter = 1;

    for (const node of nodes) {
      if (!node) continue;
      if (node.visible === false || node.hidden === true) continue;
      if (typeof node.width !== 'number' || typeof node.height !== 'number') continue;
      if (node.width < 4 || node.height < 4) continue;
      if (typeof node.x !== 'number' || typeof node.y !== 'number') continue;
      if (node.x < 0 || node.y < 0) continue;

      const trimmed = (node.label ?? '').trim();
      if (!trimmed) {
        if (node.role !== 'AXTextField' && node.role !== 'AXTextArea') continue;
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

  async walkActiveApp(appNameOrExec?: string | ExecFunction, maybeExec?: ExecFunction): Promise<IndexedElement[]> {
    let appName: string | undefined;
    let execFunc = this.exec;
    if (typeof appNameOrExec === 'function') {
      execFunc = appNameOrExec;
    } else if (typeof appNameOrExec === 'string') {
      appName = appNameOrExec;
      if (typeof maybeExec === 'function') {
        execFunc = maybeExec;
      }
    }

    const nativeElements = await this.walkNativeSwift(appName, execFunc);
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
        const indexed = this.pruneAndIndex(raw);
        if (indexed.length > 0) return indexed;
      }
    } catch {}

    return this.walkVisionOcr(execFunc);
  }

  async walkNativeSwift(appName?: string, execFunc: ExecFunction = this.exec): Promise<IndexedElement[]> {
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
    targetApp = apps.first(where: {
        ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame
    }) ?? apps.first(where: {
        ($0.localizedName ?? "").localizedCaseInsensitiveContains(query) ||
        ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains(query)
    }) ?? NSWorkspace.shared.frontmostApplication
} else {
    targetApp = NSWorkspace.shared.frontmostApplication
}

guard let app = targetApp else {
    print("[]")
    exit(0)
}

let appEl = AXUIElementCreateApplication(app.processIdentifier)
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)

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
    if depth > 8 || nodes.count >= 100 { return }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
       let list = children as? [AXUIElement] {
        for c in list {
            if nodes.count >= 100 { break }
            let role = getAttr(c, kAXRoleAttribute)
            let title = getAttr(c, kAXTitleAttribute)
            let desc = getAttr(c, kAXDescriptionAttribute)
            let val = getAttr(c, kAXValueAttribute)
            let label = !title.isEmpty ? title : (!desc.isEmpty ? desc : val)
            if let (x, y, w, h) = getBounds(c), w > 4, h > 4 {
                if !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || role.contains("Button") || role.contains("Text") {
                    nodes.append(Node(role: role, label: label, x: x, y: y, width: w, height: h))
                }
            }
            walk(el: c, depth: depth + 1)
        }
    }
}

if let winList = wins as? [AXUIElement], let w = winList.first {
    walk(el: w, depth: 0)
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
        return this.pruneAndIndex(raw);
      }
    } catch {}
    return [];
  }

  async walkVisionOcr(execFunc: ExecFunction): Promise<IndexedElement[]> {
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
var out: [[String: Any]] = []
for obs in (req.results ?? []) {
  guard let cand = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  let x = Int(b.origin.x * w)
  let y = Int((1.0 - b.origin.y - b.size.height) * h)
  let bw = Int(b.size.width * w)
  let bh = Int(b.size.height * h)
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
