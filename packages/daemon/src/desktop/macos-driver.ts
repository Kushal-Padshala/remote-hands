import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface WindowInfo {
  app: string;
  title: string;
  id?: number;
}

export interface CaptureScreenshotOptions {
  destPath?: string | undefined;
  maxWidth?: number | undefined;
  quality?: number | undefined;
}

export interface ExecFunction {
  (command: string, args: string[]): { stdout: string; stderr: string; status: number | null };
}

export interface MacOsDriverOptions {
  exec?: ExecFunction;
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const NAMED_KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  command: 55,
  cmd: 55,
  shift: 56,
  capslock: 57,
  option: 58,
  alt: 58,
  control: 59,
  ctrl: 59,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

export class MacOsDriver {
  public exec: ExecFunction;

  constructor(options?: MacOsDriverOptions) {
    this.exec = options?.exec ?? ((cmd, args) => {
      const res = spawnSync(cmd, args, { encoding: 'utf-8' });
      return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
    });
  }

  async openApp(appName: string): Promise<void> {
    const escaped = escapeAppleScript(appName);
    this.exec('open', ['-a', appName]);
    this.exec('osascript', [
      '-e',
      `tell application "${escaped}" to activate`,
      '-e',
      `tell application "${escaped}" to reopen`,
    ]);
  }

  async listWindows(): Promise<WindowInfo[]> {
    const script = `
      const se = Application("System Events");
      const procs = se.applicationProcesses.where({ backgroundOnly: false });
      const results = [];
      for (let i = 0; i < procs.length; i++) {
        try {
          const p = procs[i];
          const wins = p.windows();
          for (let j = 0; j < wins.length; j++) {
            results.push({ app: p.name(), title: wins[j].name() || "" });
          }
        } catch (_) {}
      }
      JSON.stringify(results);
    `;
    const res = this.exec('osascript', ['-l', 'JavaScript', '-e', script]);
    try {
      const parsed = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async focusWindow(appName: string): Promise<void> {
    const script = `tell application "${escapeAppleScript(appName)}" to activate`;
    this.exec('osascript', ['-e', script]);
  }

  async closeWindow(appName: string): Promise<void> {
    const escaped = escapeAppleScript(appName);
    const script = `
      tell application "${escaped}" to activate
      tell application "System Events"
        tell process "${escaped}"
          keystroke "w" using command down
        end tell
      end tell
    `;
    this.exec('osascript', ['-e', script]);
  }

  async triggerMenu(appName: string, menuPath: string[]): Promise<void> {
    if (menuPath.length < 2) return;
    let target = `menu "${escapeAppleScript(menuPath[0]!)}" of menu bar 1`;
    for (let i = 1; i < menuPath.length - 1; i++) {
      target = `menu 1 of menu item "${escapeAppleScript(menuPath[i]!)}" of ${target}`;
    }
    const lastItem = escapeAppleScript(menuPath[menuPath.length - 1]!);
    const script = `
      tell application "System Events"
        tell process "${escapeAppleScript(appName)}"
          click menu item "${lastItem}" of ${target}
        end tell
      end tell
    `;
    this.exec('osascript', ['-e', script]);
  }

  async sendKeyCombo(keys: string[], modifiers: string[]): Promise<void> {
    const mods = modifiers
      .map((m) => {
        const trimmed = m.trim();
        return trimmed.endsWith('down') ? trimmed : `${trimmed} down`;
      })
      .join(', ');
    const modString = mods.length > 0 ? ` using {${mods}}` : '';
    const key = keys[0] ?? '';
    const lowerKey = key.toLowerCase();
    const keyCode = NAMED_KEY_CODES[lowerKey];
    const script =
      keyCode !== undefined
        ? `tell application "System Events"\n  key code ${keyCode}${modString}\nend tell`
        : `tell application "System Events"\n  keystroke "${escapeAppleScript(key)}"${modString}\nend tell`;
    this.exec('osascript', ['-e', script]);
  }

  async captureScreenshot(options?: CaptureScreenshotOptions): Promise<Buffer | null> {
    const maxWidth = options?.maxWidth ?? 1280;
    const quality = options?.quality ?? 0.55;
    const targetFile = options?.destPath ?? path.join(os.tmpdir(), `rh_desktop_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    const isTemp = !options?.destPath;

    try {
      if (process.platform === 'darwin') {
        const binPath = path.join(os.homedir(), '.remote-hands', 'bin', 'rh-screenshot');
        let executed = false;
        if (fs.existsSync(binPath)) {
          const res = this.exec(binPath, [targetFile, String(maxWidth), String(quality)]);
          if (res.status === 0 && fs.existsSync(targetFile)) {
            executed = true;
          }
        }
        if (!executed) {
          const swiftScript = `import Darwin\nimport CoreGraphics\nimport ImageIO\nimport Foundation\nlet args = CommandLine.arguments\nif args.count > 1 && args[1] == "--check" {\n  let auth = CGPreflightScreenCaptureAccess()\n  print(auth ? "AUTHORIZED" : "DENIED")\n  exit(auth ? 0 : 1)\n}\nlet outputPath = args.count > 1 ? args[1] : "/tmp/rh_dest_test.jpg"\nlet maxDim = args.count > 2 ? (Double(args[2]) ?? 1280.0) : 1280.0\nlet quality = args.count > 3 ? (Float(args[3]) ?? 0.55) : 0.55\nif let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW), let symMain = dlsym(handle, "CGMainDisplayID"), let symBounds = dlsym(handle, "CGDisplayBounds"), let sym = dlsym(handle, "CGWindowListCreateImage") {\n  let fnMain = unsafeBitCast(symMain, to: (@convention(c) () -> UInt32).self)\n  let fnBounds = unsafeBitCast(symBounds, to: (@convention(c) (UInt32) -> CGRect).self)\n  let fn = unsafeBitCast(sym, to: (@convention(c) (CGRect, UInt32, UInt32, UInt32) -> CGImage?).self)\n  let bounds = fnBounds(fnMain())\n  if let img = fn(bounds, 1, 0, 0) ?? fn(CGRect.null, 1, 0, 0) {\n    let origW = CGFloat(img.width)\n    let origH = CGFloat(img.height)\n    let scale = min(1.0, CGFloat(maxDim) / max(origW, origH))\n    let targetW = max(1, Int(origW * scale))\n    let targetH = max(1, Int(origH * scale))\n    let colorSpace = CGColorSpaceCreateDeviceRGB()\n    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue\n    if let ctx = CGContext(data: nil, width: targetW, height: targetH, bitsPerComponent: 8, bytesPerRow: targetW * 4, space: colorSpace, bitmapInfo: bitmapInfo) {\n      ctx.interpolationQuality = .medium\n      ctx.draw(img, in: CGRect(x: 0, y: 0, width: targetW, height: targetH))\n      if let scaled = ctx.makeImage() {\n        let destUrl = URL(fileURLWithPath: outputPath) as CFURL\n        if let dest = CGImageDestinationCreateWithURL(destUrl, "public.jpeg" as CFString, 1, nil) {\n          let opts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]\n          CGImageDestinationAddImage(dest, scaled, opts as CFDictionary)\n          CGImageDestinationFinalize(dest)\n        }\n      }\n    }\n  }\n}`;
          const res = this.exec('swift', ['-e', swiftScript, targetFile, String(maxWidth), String(quality)]);
          if (res.status === 0 && fs.existsSync(targetFile)) {
            executed = true;
          }
        }
        if (!executed) {
          this.exec('screencapture', ['-x', '-t', 'jpg', targetFile]);
        }
      } else if (process.platform === 'linux') {
        this.exec('import', ['-window', 'root', targetFile]);
      }

      if (fs.existsSync(targetFile)) {
        const buf = await fs.promises.readFile(targetFile);
        if (isTemp) {
          await fs.promises.unlink(targetFile).catch(() => {});
        }
        return buf.length > 0 ? buf : null;
      }
      return null;
    } catch {
      return null;
    }
  }
}
