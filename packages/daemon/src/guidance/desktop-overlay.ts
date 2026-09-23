import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MacOsDriver } from '../desktop/macos-driver.js';
import { AxWalker, type IndexedElement } from '../desktop/ax-walker.js';

export interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopGuideOptions {
  app?: string | undefined;
  target?: string | undefined;
  text: string;
  bounds?: DesktopBounds | undefined;
  step?: number | undefined;
  totalSteps?: number | undefined;
}

export class DesktopOverlayController {
  private driver: MacOsDriver;
  private axWalker: AxWalker;
  private pidPath: string;

  constructor(driver?: MacOsDriver, axWalker?: AxWalker, pidPath?: string) {
    this.driver = driver || new MacOsDriver();
    this.axWalker = axWalker || new AxWalker(this.driver);
    this.pidPath = pidPath || path.join(os.homedir(), '.remote-hands', 'desktop-overlay.pid');
  }

  async show(options: DesktopGuideOptions): Promise<{ success: boolean; bounds?: DesktopBounds | undefined; error?: string | undefined }> {
    let targetBounds = options.bounds;

    if (!targetBounds && options.app && options.target) {
      try {
        let elements: any[] = [];
        if (typeof (this.axWalker as any).snapshot === 'function') {
          const snap = await (this.axWalker as any).snapshot(options.app);
          elements = snap?.elements ?? (Array.isArray(snap) ? snap : []);
        } else {
          elements = await this.axWalker.walkActiveApp(options.app);
        }

        const targetLower = options.target.toLowerCase();
        const match = elements.find((el: any) => {
          if (!el.bounds) return false;
          const title = typeof el.title === 'string' ? el.title.toLowerCase() : '';
          const desc = typeof el.description === 'string' ? el.description.toLowerCase() : '';
          const label = typeof el.label === 'string' ? el.label.toLowerCase() : '';
          return title.includes(targetLower) || desc.includes(targetLower) || label.includes(targetLower);
        });

        if (match && match.bounds) {
          if (Array.isArray(match.bounds)) {
            targetBounds = {
              x: match.bounds[0],
              y: match.bounds[1],
              width: match.bounds[2],
              height: match.bounds[3],
            };
          } else {
            targetBounds = match.bounds;
          }
        }
      } catch (err: any) {
        return { success: false, error: `Failed to inspect app: ${err?.message || String(err)}` };
      }
    }

    if (!targetBounds) {
      return { success: false, error: 'Target element or bounds not found' };
    }

    await this.dismiss();

    const { x, y, width, height } = targetBounds;
    const arrowX = Math.round(x + width / 2);
    const arrowY = Math.round(y);
    const label = `${options.step ? `[${options.step}] ` : ''}${options.text}`.replace(/"/g, '\\"');

    const script = `
      ObjC.import('Cocoa');
      ObjC.import('QuartzCore');

      const app = $.NSApplication.sharedApplication;
      app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

      if ($.__rhDesktopOverlay) {
        try { $.__rhDesktopOverlay.close(); } catch(e) {}
      }

      const screenRect = $.NSScreen.mainScreen.frame;
      const screenH = screenRect.size.height;
      const windowRect = $.NSMakeRect(0, 0, screenRect.size.width, screenH);

      const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        windowRect,
        $.NSWindowStyleMaskBorderless | $.NSWindowStyleMaskNonactivatingPanel,
        $.NSBackingStoreBuffered,
        false
      );

      panel.setOpaque(false);
      panel.setBackgroundColor($.NSColor.clearColor);
      panel.setLevel($.NSFloatingWindowLevel);
      panel.setIgnoresMouseEvents(true);
      panel.setCollectionBehavior($.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary);

      const view = $.NSView.alloc.initWithFrame(windowRect);
      view.setWantsLayer(true);

      const targetLayer = $.CALayer.layer;
      const targetY = screenH - ${y + height};
      targetLayer.frame = $.CGRectMake(${x}, targetY, ${width}, ${height});
      targetLayer.borderColor = $.NSColor.colorWithRedGreenBlueAlpha(0.23, 0.51, 0.96, 1.0).CGColor;
      targetLayer.borderWidth = 3;
      targetLayer.cornerRadius = 6;
      view.layer.addSublayer(targetLayer);

      const textLayer = $.CATextLayer.layer;
      textLayer.string = "${label}";
      textLayer.fontSize = 13;
      textLayer.alignmentMode = 'center';
      textLayer.foregroundColor = $.NSColor.whiteColor.CGColor;
      textLayer.backgroundColor = $.NSColor.colorWithRedGreenBlueAlpha(0.06, 0.09, 0.16, 0.95).CGColor;
      textLayer.cornerRadius = 6;
      textLayer.masksToBounds = true;
      const cardWidth = Math.max(140, "${label}".length * 9);
      const cardX = Math.max(10, Math.min(screenRect.size.width - cardWidth - 10, ${arrowX} - cardWidth / 2));
      let cardY = targetY + ${height} + 18;
      if (cardY + 32 > screenH - 10) {
        cardY = targetY - 42;
      }
      textLayer.frame = $.CGRectMake(cardX, cardY, cardWidth, 28);
      view.layer.addSublayer(textLayer);

      panel.setContentView(view);
      panel.orderFrontRegardless();
      $.__rhDesktopOverlay = panel;
    `;

    this.driver.exec('osascript', ['-l', 'JavaScript', '-e', script]);

    try {
      const runScript = `${script}; $.NSApplication.sharedApplication.run();`;
      const child = spawn('osascript', ['-l', 'JavaScript', '-e', runScript], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      if (child.pid) {
        fs.mkdirSync(path.dirname(this.pidPath), { recursive: true });
        fs.writeFileSync(this.pidPath, String(child.pid), 'utf-8');
      }
    } catch {}

    return { success: true, bounds: targetBounds };
  }

  async dismiss(): Promise<void> {
    try {
      if (fs.existsSync(this.pidPath)) {
        const pid = parseInt(fs.readFileSync(this.pidPath, 'utf-8').trim(), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }
        try {
          fs.unlinkSync(this.pidPath);
        } catch {}
      }
    } catch {}

    const script = `
      ObjC.import('Cocoa');
      if ($.__rhDesktopOverlay) {
        try {
          $.__rhDesktopOverlay.close();
          $.__rhDesktopOverlay = null;
        } catch(e) {}
      }
    `;
    this.driver.exec('osascript', ['-l', 'JavaScript', '-e', script]);
  }
}
