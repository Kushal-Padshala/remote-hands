import { MacOsDriver } from '../desktop/macos-driver.js';
import { AxWalker } from '../desktop/ax-walker.js';

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
  private isActive = false;

  constructor(driver?: MacOsDriver, axWalker?: AxWalker) {
    this.driver = driver || new MacOsDriver();
    this.axWalker = axWalker || new AxWalker(this.driver);
  }

  async show(options: DesktopGuideOptions): Promise<{ success: boolean; bounds?: DesktopBounds | undefined; error?: string | undefined }> {
    let targetBounds = options.bounds;

    if (!targetBounds && options.app && options.target) {
      try {
        const snap = typeof (this.axWalker as any).snapshot === 'function'
          ? await (this.axWalker as any).snapshot(options.app)
          : { elements: await this.axWalker.walkActiveApp(options.app) };
        const elements: any[] = snap?.elements ?? (Array.isArray(snap) ? snap : []);
        const targetLower = options.target.toLowerCase();
        const match = elements.find(
          (el: any) =>
            el.bounds &&
            ((el.title && typeof el.title === 'string' && el.title.toLowerCase().includes(targetLower)) ||
              (el.description && typeof el.description === 'string' && el.description.toLowerCase().includes(targetLower)) ||
              (el.label && typeof el.label === 'string' && el.label.toLowerCase().includes(targetLower)))
        );
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

    const { x, y, width, height } = targetBounds;
    const arrowX = Math.round(x + width / 2);
    const arrowY = Math.round(y);
    const label = `${options.step ? `[${options.step}] ` : ''}${options.text}`;

    const script = `
      ObjC.import('Cocoa');
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
      targetLayer.frame = $.CGRectMake(${x}, screenH - ${y + height}, ${width}, ${height});
      targetLayer.borderColor = $.NSColor.colorWithRedGreenBlueAlpha(0.23, 0.51, 0.96, 1.0).CGColor;
      targetLayer.borderWidth = 3;
      targetLayer.cornerRadius = 6;
      view.layer.addSublayer(targetLayer);

      panel.setContentView(view);
      panel.orderFrontRegardless();
      $.__rhDesktopOverlay = panel;
    `;

    this.driver.exec('osascript', ['-l', 'JavaScript', '-e', script]);
    this.isActive = true;
    return { success: true, bounds: targetBounds };
  }

  async dismiss(): Promise<void> {
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
    this.isActive = false;
  }
}
